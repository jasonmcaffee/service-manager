import { processManager, ServiceStatus } from '@/lib/process-manager'
import { serviceRepository, CreateServiceInput, UpdateServiceInput } from '@/lib/repositories/serviceRepository'
import { killPort } from '@/lib/util/portHelper'

const globalForInit = globalThis as unknown as { processManagerInitialized: boolean }

async function initializeIfNeeded() {
  if (globalForInit.processManagerInitialized) return
  globalForInit.processManagerInitialized = true

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

function buildEnv(service: { port?: number | null; cudaDevice?: string | null }): Record<string, string> {
  const env: Record<string, string> = {}
  if (service.port) env.PORT = String(service.port)
  if (service.cudaDevice) env.CUDA_DEVICE = service.cudaDevice
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

      return { ...service, status, pid }
    }))
  },

  async getService(id: string) {
    const service = await serviceRepository.findById(id)
    if (!service) return null

    const mem = processManager.getStatus(id)
    return {
      ...service,
      status: mem?.status ?? service.status,
      pid: mem?.pid ?? service.pid ?? null,
      output: mem?.output || [],
    }
  },

  async createService(input: CreateServiceInput) {
    validatePort(input.port)
    return serviceRepository.create(input)
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

    return { ...updated, status: currentStatus, pid: currentPid }
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

    await processManager.startService(service.id, service.command, buildEnv(service), makeOnStateChange(id))

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

    // Port-based fallback if PID kill didn't work
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

    await processManager.restartService(service.id, service.command, buildEnv(service), makeOnStateChange(id))

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

    const services = await serviceRepository.findAutoStart()
    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    for (const service of services) {
      if (processManager.isRunning(service.id)) {
        results.push({ id: service.id, name: service.name, status: 'already_running' })
        continue
      }

      try {
        await processManager.startService(
          service.id,
          service.command,
          buildEnv(service),
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
