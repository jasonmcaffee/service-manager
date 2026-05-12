import fs from 'fs'
import { processManager, ServiceStatus } from '@/lib/process-manager'
import { serviceRepository, CreateServiceInput, UpdateServiceInput } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { initializeIfNeeded } from '@/lib/services/init'
import { killPort, getWslPidsOnPort, killWslPids } from '@/lib/util/portHelper'
import { getLogFilePath } from '@/lib/util/logTailer'

/**
 * Reads the log file for a service and returns its lines, or empty array if unavailable.
 * @param id - service identifier used to locate the log file
 */
function readLogFileLines(id: string): string[] {
  try {
    const logFile = getLogFilePath(id)
    if (!fs.existsSync(logFile)) return []
    return fs.readFileSync(logFile, 'utf-8').split('\n')
  } catch {
    return []
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

/**
 * Kills any WSL processes still listening on the given port.
 * Required for WSL services: treeKill only reaches the Windows-side wsl.exe wrapper;
 * the actual Linux process inside the VM survives and keeps holding the port,
 * causing EADDRINUSE on the next start attempt.
 * @param port - WSL port to clear of lingering processes
 */
async function killOrphanedWslProcesses(port: number): Promise<void> {
  const pids = await getWslPidsOnPort(port)
  if (pids.length > 0) {
    console.log(`[serviceService] killing ${pids.length} orphaned WSL process(es) on port ${port}: ${pids.join(', ')}`)
    await killWslPids(pids)
  }
}

function validatePort(port: number | null | undefined) {
  if (port === undefined || port === null) return
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error('Port must be an integer between 1 and 65535')
    ;(err as any).statusCode = 400
    throw err
  }
}

/**
 * Warns (409) if another service already uses the given port.
 * @param port - the port to check
 * @param excludeId - service id to exclude from the check (for updates)
 */
async function checkPortUniqueness(port: number | null | undefined, excludeId?: string): Promise<void> {
  if (!port) return
  const existing = await serviceRepository.findByPort(port)
  const conflicts = excludeId ? existing.filter(s => s.id !== excludeId) : existing
  if (conflicts.length > 0) {
    const names = conflicts.map(s => s.name).join(', ')
    const err = new Error(`Port ${port} is already used by: ${names}. Two services on the same port will cause adoption conflicts.`)
    ;(err as any).statusCode = 409
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

      if (status === 'running') {
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
      output: mem ? processManager.getOutput(id) : readLogFileLines(id),
    }
  },

  async createService(input: CreateServiceInput) {
    validatePort(input.port)
    await checkPortUniqueness(input.port)
    const service = await serviceRepository.create(input)

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
    await checkPortUniqueness(input.port, id)

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
    await initializeIfNeeded()
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    if ((service as any).wsl && service.port) {
      await killOrphanedWslProcesses(service.port)
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

    if ((service as any).wsl && service.port) {
      await killOrphanedWslProcesses(service.port)
    }

    const mem = processManager.getStatus(id)
    return {
      id,
      status: mem?.status || 'stopped',
      pid: mem?.pid ?? null,
    }
  },

  async restartService(id: string) {
    await initializeIfNeeded()
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    if ((service as any).wsl && service.port) {
      await killOrphanedWslProcesses(service.port)
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
    await initializeIfNeeded()

    if (processManager.hasBootStarted()) {
      return { alreadyStarted: true, results: [] }
    }
    processManager.markBootStarted()

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

        if ((service as any).wsl && service.port) {
          await killOrphanedWslProcesses(service.port)
        }

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
