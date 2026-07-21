import fs from 'fs'
import { processManager, ServiceStatus } from '@/lib/process-manager'
import { serviceRepository, CreateServiceInput, UpdateServiceInput } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { initializeIfNeeded, startAutoStartServices } from '@/lib/services/init'
import { killPort, killMatchingProcesses, extractServiceDir, ensureWslPortProxy } from '@/lib/util/portHelper'
import { getLogFilePath, readLogFileCapped, INITIAL_TAIL_BYTES } from '@/lib/util/logTailer'

/**
 * Reads the tail of a service's log file and returns its lines, or an empty array
 * if unavailable. Bounded to INITIAL_TAIL_BYTES because this runs on the 1s UI
 * output poll for every service without a live tailer.
 * @param id - service identifier used to locate the log file
 */
function readLogFileLines(id: string): string[] {
  try {
    const logFile = getLogFilePath(id)
    if (!fs.existsSync(logFile)) return []
    return readLogFileCapped(logFile, INITIAL_TAIL_BYTES).split('\n')
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
 * Frees a service's port before (re)starting it, scoped so the kill can only ever
 * touch that service. The owning service id lets the guard keep every other
 * service's PIDs — and the claude/opencode terminal daemons — off the kill list,
 * and only PIDs Service Manager spawned for this service may be tree-killed.
 * No-op for services without a port.
 * @param service - the service row being started or restarted
 */
async function freePortForService(service: any): Promise<void> {
  if (!service.port) return
  if (!service.wsl) {
    const serviceDir = extractServiceDir(service.command)
    if (serviceDir) await killMatchingProcesses(serviceDir, 'node_modules', service.id)
  }
  await killPort(service.port, {
    ownerServiceId: service.id,
    spawnedPids: processManager.getSpawnedPids(service.id),
  })
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
      const mem = processManager.getStatus(service.id)

      if (mem) {
        // processManager has the service in this session — trust its view.
        if (mem.status === 'running') {
          if (processManager.isRunning(service.id)) {
            status = 'running'
            pid = mem.pid ?? pid
          } else {
            // Tracked but the child or PID is dead — definitive evidence to mark stopped.
            status = 'stopped'
            pid = null
            await serviceRepository.update(service.id, { status: 'stopped', pid: null })
          }
        } else {
          status = mem.status
          pid = mem.pid ?? null
        }
      }
      // If mem is undefined we have no evidence either way. Report the DB status
      // and let the reconciler attempt re-adoption / mark stopped with snapshots
      // — that's the only place we have port-level ground truth.

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

    await freePortForService(service)

    const env = await buildEnvForService(id, service.port)
    await processManager.startService(service.id, service.command, env, makeOnStateChange(id))

    if ((service as any).wsl && service.port) await ensureWslPortProxy(service.port)

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

    const killOpts = { ownerServiceId: id, spawnedPids: processManager.getSpawnedPids(id) }

    if (processManager.isRunning(id) && service.port) {
      await killPort(service.port, killOpts)
      await onStateChange('stopped', undefined)
    }

    if ((service as any).wsl && service.port) {
      await killPort(service.port, killOpts)
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

    await freePortForService(service)

    const env = await buildEnvForService(id, service.port)
    await processManager.restartService(service.id, service.command, env, makeOnStateChange(id))

    if ((service as any).wsl && service.port) await ensureWslPortProxy(service.port)

    const mem = processManager.getStatus(id)
    const updated = await serviceRepository.findById(id)
    return {
      id,
      status: mem?.status || updated?.status || 'stopped',
      pid: mem?.pid ?? updated?.pid ?? null,
    }
  },

  /**
   * HTTP entry point for triggering start-on-boot services (POST /api/services/startup).
   * Delegates to the shared server-side autostart in init so there is a single
   * source of truth. The boot guard is shared with init's own boot-time autostart,
   * so whichever path fires first wins and services are never double-started.
   */
  async runAutoStart() {
    await initializeIfNeeded()

    if (processManager.hasBootStarted()) {
      return { alreadyStarted: true, results: [] }
    }
    processManager.markBootStarted()

    const results = await startAutoStartServices()
    return { alreadyStarted: false, results }
  },

  /**
   * Returns recent output for a service. Prefers the live tailer ring-buffer (fast,
   * has the most-recent lines); falls back to the persisted log file when the
   * tailer hasn't been started (e.g. an unadopted service or one that died
   * before adoption). Without this fallback the terminal goes blank for any
   * service that failed to adopt — hiding error logs the user needs.
   * @param id - service id
   */
  getOutput(id: string) {
    const buffered = processManager.getOutput(id)
    if (buffered.length > 0) return buffered
    return readLogFileLines(id).filter(l => l.length > 0).slice(-1000)
  },

  clearOutput(id: string) {
    processManager.clearOutput(id)
  },

  getProcessStatus(id: string) {
    return processManager.getStatus(id)
  },
}
