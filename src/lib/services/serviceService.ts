import { processManager, ServiceStatus } from '@/lib/process-manager'
import { serviceRepository, CreateServiceInput, UpdateServiceInput } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { ensureDefaultProfile } from '@/lib/services/runProfileService'
import { killPort } from '@/lib/util/portHelper'

const globalForInit = globalThis as unknown as { processManagerInitialized: boolean }

async function initializeIfNeeded() {
  if (globalForInit.processManagerInitialized) return
  globalForInit.processManagerInitialized = true

  await ensureDefaultProfile()

  const services = await serviceRepository.findAll()
  for (const service of services) {
    if (service.pid && service.status === 'running') {
      processManager.restoreFromDb(service.id, service.pid, 'running')
      if (!processManager.isRunning(service.id)) {
        await serviceRepository.update(service.id, { status: 'stopped', pid: null })
      }
    }
  }
}

function makeOnStateChange(id: string) {
  return async (status: ServiceStatus, pid?: number) => {
    await serviceRepository.update(id, { status, pid: pid ?? null })
  }
}

async function buildEnvForService(serviceId: string, port: number | null | undefined): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  if (port) env.PORT = String(port)
  const active = await runProfileRepository.findActive()
  if (active) {
    const override = await runProfileRepository.findProfileService(active.id, serviceId)
    if (override?.cudaDevice) env.CUDA_DEVICE = override.cudaDevice
  }
  return env
}

function validatePort(port: number | null | undefined) {
  if (port === undefined || port === null) return
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error('Port must be an integer between 1 and 65535')
    ;(err as any).statusCode = 400
    throw err
  }
}

async function mergeProfileOverride(service: any) {
  const active = await runProfileRepository.findActive()
  if (!active) return { ...service, cudaDevice: null, startOnBoot: false }
  const override = await runProfileRepository.findProfileService(active.id, service.id)
  return {
    ...service,
    cudaDevice: override?.cudaDevice ?? null,
    startOnBoot: override?.startOnBoot ?? false,
  }
}

export const serviceService = {
  async listServices() {
    await initializeIfNeeded()
    const services = await serviceRepository.findAll()

    return Promise.all(services.map(async (service) => {
      let { status, pid } = service

      if (status === 'running' && pid) {
        if (!processManager.isRunning(service.id)) {
          status = 'stopped'
          pid = null
          await serviceRepository.update(service.id, { status: 'stopped', pid: null })
        }
      }

      const mem = processManager.getStatus(service.id)
      if (mem?.status === 'running' && mem.pid) {
        status = 'running'
        pid = mem.pid
      }

      const merged = await mergeProfileOverride(service)
      return { ...merged, status, pid }
    }))
  },

  async getService(id: string) {
    const service = await serviceRepository.findById(id)
    if (!service) return null

    const mem = processManager.getStatus(id)
    const merged = await mergeProfileOverride(service)
    return {
      ...merged,
      status: mem?.status ?? service.status,
      pid: mem?.pid ?? service.pid ?? null,
      output: mem?.output || [],
    }
  },

  async createService(input: CreateServiceInput) {
    validatePort(input.port)
    const service = await serviceRepository.create(input)

    // Create RunProfileService rows for all existing profiles
    const active = await runProfileRepository.findActive()
    await runProfileRepository.createProfileServicesForAllProfiles(service.id, {
      cudaDevice: input.cudaDevice ?? null,
      startOnBoot: input.startOnBoot ?? false,
    })

    if (active) {
      const override = await runProfileRepository.findProfileService(active.id, service.id)
      return { ...service, cudaDevice: override?.cudaDevice ?? null, startOnBoot: override?.startOnBoot ?? false }
    }
    return service
  },

  async updateService(id: string, input: UpdateServiceInput) {
    const current = await serviceRepository.findById(id)
    if (!current) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    validatePort(input.port)

    const mem = processManager.getStatus(id)
    const currentStatus = mem?.status || current.status
    const currentPid = mem?.pid ?? current.pid ?? null

    const updated = await serviceRepository.update(id, {
      ...input,
      status: currentStatus,
      pid: currentPid,
    })

    const merged = await mergeProfileOverride(updated)
    return { ...merged, status: currentStatus, pid: currentPid }
  },

  async deleteService(id: string) {
    if (processManager.isRunning(id)) {
      await processManager.stopService(id)
    }
    await serviceRepository.delete(id)
  },

  async startService(id: string) {
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    const env = await buildEnvForService(id, service.port)
    await processManager.startService(service.id, service.command, env, makeOnStateChange(id))

    const mem = processManager.getStatus(id)
    const updated = await serviceRepository.findById(id)
    return {
      id,
      status: mem?.status || updated?.status || 'stopped',
      pid: mem?.pid ?? updated?.pid ?? null,
    }
  },

  async stopService(id: string) {
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    const onStateChange = makeOnStateChange(id)
    await processManager.stopService(id, onStateChange)

    if (processManager.isRunning(id) && service.port) {
      await killPort(service.port)
      await onStateChange('stopped', undefined)
    }

    const mem = processManager.getStatus(id)
    return {
      id,
      status: mem?.status || 'stopped',
      pid: mem?.pid ?? null,
    }
  },

  async restartService(id: string) {
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    const env = await buildEnvForService(id, service.port)
    await processManager.restartService(service.id, service.command, env, makeOnStateChange(id))

    const mem = processManager.getStatus(id)
    const updated = await serviceRepository.findById(id)
    return {
      id,
      status: mem?.status || updated?.status || 'stopped',
      pid: mem?.pid ?? updated?.pid ?? null,
    }
  },

  async runAutoStart() {
    if (processManager.hasBootStarted()) {
      return { alreadyStarted: true, results: [] }
    }
    processManager.markBootStarted()

    await ensureDefaultProfile()
    const active = await runProfileRepository.findActive()
    if (!active) return { alreadyStarted: false, results: [] }

    const autoStartEntries = await runProfileRepository.findAutoStartServices(active.id)
    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    for (const entry of autoStartEntries) {
      const service = entry.service
      if (processManager.isRunning(service.id)) {
        results.push({ id: service.id, name: service.name, status: 'already_running' })
        continue
      }

      try {
        const env: Record<string, string> = {}
        if (service.port) env.PORT = String(service.port)
        if (entry.cudaDevice) env.CUDA_DEVICE = entry.cudaDevice

        await processManager.startService(
          service.id,
          service.command,
          env,
          makeOnStateChange(service.id)
        )
        results.push({ id: service.id, name: service.name, status: 'started' })
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch (error: any) {
        results.push({ id: service.id, name: service.name, status: 'error', error: error.message })
      }
    }

    return { alreadyStarted: false, results }
  },

  getOutput(id: string) {
    return processManager.getOutput(id)
  },

  clearOutput(id: string) {
    processManager.clearOutput(id)
  },

  getProcessStatus(id: string) {
    return processManager.getStatus(id)
  },
}
