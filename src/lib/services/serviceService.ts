import fs from 'fs'
import { processManager, ServiceStatus } from '@/lib/process-manager'
import { serviceRepository, CreateServiceInput, UpdateServiceInput } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { initializeIfNeeded, startAutoStartServices } from '@/lib/services/init'
import {
  ChangeProvenance, RESTORABLE_FIELDS, captureSnapshot, getRevision, recordChange, requireReason,
} from '@/lib/services/configRevisionService'
import { ConfigSnapshot } from '@/types/service'
import { killPort, killMatchingProcesses, extractServiceDir, ensureWslPortProxy } from '@/lib/util/portHelper'
import { getLogFilePath, readLogFileCapped, INITIAL_TAIL_BYTES, appendServiceNote, readServiceEvents } from '@/lib/util/logTailer'
import {
  checkVramAdmission, parseCudaDevices, queryGpuMemory, resolveGuardedCudaDevice,
  describeCudaDeviceConflict, extractCudaDevicesFromCommand, reapGpuSurvivors, buildKnownExecutables,
} from '@/lib/util/gpuGuard'

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

/**
 * Returns the cudaDevice as REGISTERED for a service: the active profile's override
 * when there is one, else the service row's own value. This is the configured value,
 * not necessarily the card the process ends up on — see resolveGuardedCudaDevice.
 * @param serviceId - the service being inspected
 * @param fallback - the service row's cudaDevice
 */
async function resolveRegisteredCudaDevice(serviceId: string, fallback: string | null): Promise<string | null> {
  const active = await runProfileRepository.findActive()
  if (!active) return fallback
  const override = await runProfileRepository.findProfileService(active.id, serviceId)
  return override?.cudaDevice ?? fallback
}

/**
 * Returns the GPU the service's process will ACTUALLY occupy: the pin its own start
 * command hard-codes when it has one, else the registered value. Everything that
 * reasons about GPUs — admission, occupancy, post-stop VRAM checks and what the UI
 * displays — goes through this, so the guard can no longer reserve and police a
 * different card from the one the job runs on (task-1493).
 * @param service - the service row (needs id, cudaDevice, command)
 */
async function resolveEffectiveCudaDevice(service: { id: string; cudaDevice?: string | null; command?: string | null }): Promise<string | null> {
  const registered = await resolveRegisteredCudaDevice(service.id, service.cudaDevice ?? null)
  return resolveGuardedCudaDevice(registered, service.command)
}

/**
 * Maps each GPU index to the names of the services currently RUNNING on it, so a
 * refusal can name what is holding the card instead of just reporting a number.
 * @param excludeServiceId - the service being started, which is never its own occupant
 */
async function buildGpuOccupants(excludeServiceId: string): Promise<Map<number, string[]>> {
  const occupants = new Map<number, string[]>()
  const services = await serviceRepository.findAll()

  for (const svc of services) {
    if (svc.id === excludeServiceId) continue
    if (!processManager.isRunning(svc.id)) continue
    const cudaDevice = await resolveEffectiveCudaDevice(svc)
    for (const index of parseCudaDevices(cudaDevice)) {
      const names = occupants.get(index) ?? []
      names.push(svc.name)
      occupants.set(index, names)
    }
  }
  return occupants
}

/**
 * Blocks a stopped→running transition that would over-subscribe a GPU, throwing 409
 * with a message naming the occupying service. Without this, starting a second heavy
 * CUDA service on an already-full card hard-hangs the whole machine rather than
 * failing cleanly (task-1406): ComfyUI is masked to a single device and run with
 * --disable-dynamic-vram, so it believes it owns all the card's memory.
 *
 * Only guards services that declare a `minFreeVramMb`; everything else starts as before.
 * @param service - the service row about to be started
 */
async function assertVramAvailable(service: any): Promise<void> {
  const registered = await resolveRegisteredCudaDevice(service.id, service.cudaDevice ?? null)
  const conflict = describeCudaDeviceConflict(registered, service.command)
  if (conflict) {
    console.warn(`[gpuGuard] "${service.name}": ${conflict}`)
    appendServiceNote(service.id, conflict)
  }

  const cudaDevice = resolveGuardedCudaDevice(registered, service.command)
  if (parseCudaDevices(cudaDevice).length === 0) return
  if (!service.minFreeVramMb) return

  const [gpus, occupantsByDevice] = await Promise.all([
    queryGpuMemory(),
    buildGpuOccupants(service.id),
  ])

  const verdict = checkVramAdmission({
    serviceName: service.name,
    cudaDevice,
    minFreeVramMb: service.minFreeVramMb,
    gpus,
    occupantsByDevice,
  })

  if (!verdict.allowed) {
    console.warn(`[gpuGuard] ${verdict.reason}`)
    // The refusal has to land in the service's OWN output: the card just reads
    // "stopped" and /output otherwise still shows the previous run's tail, which is
    // exactly how a guard decision looked like a silent crash (task-1493).
    appendServiceNote(service.id, `START REFUSED. ${verdict.reason}`)
    const err = new Error(verdict.reason)
    ;(err as any).statusCode = 409
    throw err
  }
}

/**
 * Checks the GPUs a service is pinned to for processes still holding VRAM, reaps the
 * ones that are unambiguously its own orphans, and writes the outcome into that
 * service's output. Run after a stop (so "stopped" means the card is actually free)
 * and before a start (so admission is not refused because of the service's own
 * leftover process). Never throws — a stop must still report the process it did kill
 * even if the GPU probe fails.
 * @param service - the service row being started or stopped
 */
async function sweepServiceGpuOrphans(service: any): Promise<string[]> {
  try {
    const cudaDevice = await resolveEffectiveCudaDevice(service)
    const devices = parseCudaDevices(cudaDevice)
    if (devices.length === 0) return []

    const all = await serviceRepository.findAll()
    const { notes } = await reapGpuSurvivors({
      devices,
      command: service.command,
      ownerServiceId: service.id,
      knownExecutables: buildKnownExecutables(all, service.name),
    })
    for (const note of notes) {
      console.warn(`[gpuGuard] "${service.name}": ${note}`)
      appendServiceNote(service.id, note)
    }
    return notes
  } catch (err: any) {
    console.warn(`[gpuGuard] post-stop VRAM sweep failed for "${service.name}":`, err?.message)
    return []
  }
}

/**
 * Turns a stored snapshot into an update payload. Only the restorable configuration
 * fields are taken — runtime state (status, pid) and the snapshot's profile context
 * are deliberately left out, so a revert restores configuration and nothing else.
 * @param snapshot - the configuration captured by the revision being restored
 */
function buildRevertInput(snapshot: ConfigSnapshot): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const field of RESTORABLE_FIELDS) {
    input[field] = (snapshot as any)[field] ?? null
  }
  // startOnBoot is a boolean flag; a null would read as "unset" downstream.
  input.startOnBoot = Boolean(snapshot.startOnBoot)
  input.autoRestart = Boolean(snapshot.autoRestart)
  input.noPort = Boolean(snapshot.noPort)
  input.wsl = Boolean(snapshot.wsl)
  return input
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

/**
 * Merges a service row with its active-profile override and resolves the GPU it will
 * really run on.
 *
 * `cudaDevice` is reported as the EFFECTIVE device — the command's own pin when it
 * hard-codes one — so the list, the guard and the process can never show three
 * different answers. `registeredCudaDevice` keeps the stored value visible, and
 * `cudaDeviceConflict` carries the explanation whenever the two differ.
 * @param service - the service row to merge
 */
async function mergeProfileOverride(service: any) {
  const active = await runProfileRepository.findActive()
  const override = active ? await runProfileRepository.findProfileService(active.id, service.id) : null
  const registered = override?.cudaDevice ?? null
  return {
    ...service,
    cudaDevice: resolveGuardedCudaDevice(registered, service.command),
    registeredCudaDevice: registered,
    cudaDeviceSource: extractCudaDevicesFromCommand(service.command) ? 'command' : 'profile',
    cudaDeviceConflict: describeCudaDeviceConflict(registered, service.command),
    startOnBoot: override?.startOnBoot ?? false,
    autoRestart: override?.autoRestart ?? false,
  }
}

/**
 * Persists a cudaDevice change to the active profile's override row — the place the
 * value actually lives since profiles were introduced.
 *
 * PUT /api/services/<id> used to drop `cudaDevice` on the floor: it answered 200 with
 * the full service body while writing nothing, so a misregistration could not be
 * corrected through the API at all and had to be patched in the store by hand
 * (task-1493). A value that contradicts a device the command hard-codes is rejected
 * rather than stored, so the two can never drift apart again.
 * @param service - the service row being updated
 * @param cudaDevice - the requested device string (null clears the pin)
 */
async function writeCudaDevice(service: any, cudaDevice: string | null): Promise<void> {
  const value = cudaDevice === null || String(cudaDevice).trim() === '' ? null : String(cudaDevice).trim()

  if (value !== null && parseCudaDevices(value).length === 0) {
    const err = new Error(`cudaDevice must be a GPU index or comma-separated mask (e.g. "1" or "0,1"), got "${cudaDevice}"`)
    ;(err as any).statusCode = 400
    throw err
  }

  const commandPin = extractCudaDevicesFromCommand(service.command)
  if (value !== null && commandPin && parseCudaDevices(commandPin).join(',') !== parseCudaDevices(value).join(',')) {
    const err = new Error(
      `Cannot set cudaDevice to "${value}": the start command hard-codes GPU "${commandPin}". ` +
      `Change the command (or make it use %CUDA_DEVICE%) so the registration and the process agree.`
    )
    ;(err as any).statusCode = 409
    throw err
  }

  const active = await runProfileRepository.findActive()
  if (!active) {
    const err = new Error('No active run profile — cudaDevice is stored per profile.')
    ;(err as any).statusCode = 409
    throw err
  }
  await runProfileRepository.upsertProfileService(active.id, service.id, { cudaDevice: value })
}

/**
 * Persists a startOnBoot change to the active profile's override row, which is where
 * the flag has actually lived since profiles were introduced. Writing it onto the
 * service row (the legacy column) is what made the card's Auto-start toggle appear to
 * do nothing: the write landed somewhere nothing reads, and the next poll re-rendered
 * the profile's unchanged value.
 * @param serviceId - the service being updated
 * @param startOnBoot - the requested flag
 */
async function writeStartOnBoot(serviceId: string, startOnBoot: boolean): Promise<void> {
  const active = await runProfileRepository.findActive()
  if (!active) {
    const err = new Error('No active run profile — startOnBoot is stored per profile.')
    ;(err as any).statusCode = 409
    throw err
  }
  await runProfileRepository.upsertProfileService(active.id, serviceId, { startOnBoot: Boolean(startOnBoot) })
}

/**
 * Persists an autoRestart change to the active profile's override row. Stored beside
 * startOnBoot rather than on the service row, because it is the same kind of statement:
 * "this profile wants this service up". startOnBoot says it at boot, autoRestart keeps
 * saying it for as long as the profile is active (task-1593).
 * @param serviceId - the service being updated
 * @param autoRestart - the requested flag
 */
async function writeAutoRestart(serviceId: string, autoRestart: boolean): Promise<void> {
  const active = await runProfileRepository.findActive()
  if (!active) {
    const err = new Error('No active run profile — autoRestart is stored per profile.')
    ;(err as any).statusCode = 409
    throw err
  }
  await runProfileRepository.upsertProfileService(active.id, serviceId, { autoRestart: Boolean(autoRestart) })
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

  /**
   * Registers a new service. The change log's entry point for a create: the reason
   * is validated before anything is written, so a service can never appear with no
   * record of why it exists (task-1523).
   * @param input - the service fields to register
   * @param change - why this service is being added, and by whom
   */
  async createService(input: CreateServiceInput, change: ChangeProvenance) {
    const reason = requireReason(change?.reason, 'create service', input.name ?? 'new service')

    validatePort(input.port)
    await checkPortUniqueness(input.port)
    const service = await serviceRepository.create(input)

    await runProfileRepository.createProfileServicesForAllProfiles(service.id, {
      cudaDevice: input.cudaDevice ?? null,
      startOnBoot: input.startOnBoot ?? false,
      autoRestart: (input as any).autoRestart ?? false,
    })

    await recordChange({
      serviceId: service.id,
      serviceName: service.name,
      changeType: 'create',
      provenance: { ...change, reason },
      previous: null,
      snapshot: await captureSnapshot(service.id),
    })

    // Same merge as list/get, so a freshly created service reports the same effective
    // cudaDevice (and any command conflict) as it will on the next read.
    return mergeProfileOverride(service)
  },

  /**
   * Applies a configuration change to a service and appends it to the change log.
   * Snapshots are taken either side of the write so the recorded diff is what the
   * database actually did, and an update that changes nothing records nothing.
   * @param id - the service to update
   * @param input - the fields to change
   * @param change - why this configuration is changing, and by whom
   */
  async updateService(id: string, input: UpdateServiceInput, change: ChangeProvenance) {
    const current = await serviceRepository.findById(id)
    if (!current) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    const reason = requireReason(change?.reason, 'update service', current.name)
    const before = await captureSnapshot(id)

    validatePort(input.port)
    await checkPortUniqueness(input.port, id)

    const mem = processManager.getStatus(id)
    const currentStatus = mem?.status || current.status
    const currentPid = mem?.pid ?? current.pid ?? null

    // cudaDevice and startOnBoot live on the profile-override row, not the service
    // row — split them out before the service update so Prisma never sees an unknown
    // column and the values are actually persisted where they are read from.
    const { cudaDevice, startOnBoot, autoRestart, ...serviceFields } =
      input as UpdateServiceInput & { cudaDevice?: string | null; startOnBoot?: boolean; autoRestart?: boolean }
    if (cudaDevice !== undefined) {
      await writeCudaDevice({ ...current, ...serviceFields }, cudaDevice ?? null)
    }
    if (startOnBoot !== undefined) {
      await writeStartOnBoot(id, Boolean(startOnBoot))
    }
    if (autoRestart !== undefined) {
      await writeAutoRestart(id, Boolean(autoRestart))
    }

    const updated = await serviceRepository.update(id, {
      ...serviceFields,
      status: currentStatus,
      pid: currentPid,
    })

    await recordChange({
      serviceId: id,
      serviceName: updated.name,
      changeType: change.changeType ?? 'update',
      provenance: { ...change, reason },
      previous: before,
      snapshot: await captureSnapshot(id),
      revertedFromRevisionId: change.revertedFromRevisionId ?? null,
    })

    const merged = await mergeProfileOverride(updated)
    return { ...merged, status: currentStatus, pid: currentPid }
  },

  /**
   * Removes a service, recording the removal and the configuration it had. The
   * revision deliberately outlives the service row (no FK cascade) — the record of
   * what was deleted is the part of the history worth keeping most.
   * @param id - the service to delete
   * @param change - why it is being removed, and by whom
   */
  async deleteService(id: string, change: ChangeProvenance) {
    const current = await serviceRepository.findById(id)
    const reason = requireReason(change?.reason, 'delete service', current?.name ?? id)
    const before = await captureSnapshot(id)

    if (processManager.isRunning(id)) {
      await processManager.stopService(id)
    }
    await serviceRepository.delete(id)

    await recordChange({
      serviceId: id,
      serviceName: current?.name ?? id,
      changeType: 'delete',
      provenance: { ...change, reason },
      previous: before,
      snapshot: null,
    })
  },

  /**
   * Restores the configuration captured by an earlier revision. A revert is a normal
   * forward change: it goes through updateService so every validation still runs, and
   * it appends its own `revert` revision rather than rewriting history.
   *
   * Profile-scoped fields land on the CURRENTLY ACTIVE profile. When the revision was
   * captured under a different profile the response says so — applying only half the
   * config silently would be worse than applying it with a warning.
   * @param id - the service to restore
   * @param revisionId - the revision whose snapshot to apply
   * @param change - why we are reverting, and by whom
   */
  async revertToRevision(id: string, revisionId: string, change: ChangeProvenance) {
    const current = await serviceRepository.findById(id)
    if (!current) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    const reason = requireReason(change?.reason, 'revert service', current.name)
    const revision = await getRevision(id, revisionId)
    if (!revision) {
      const err = new Error('Revision not found for this service')
      ;(err as any).statusCode = 404
      throw err
    }
    if (!revision.snapshot) {
      const err = new Error('This revision has no configuration to restore (the service was deleted at that point).')
      ;(err as any).statusCode = 409
      throw err
    }

    const active = await runProfileRepository.findActive()
    const crossProfile = Boolean(revision.profileId && active && revision.profileId !== active.id)

    const service = await this.updateService(id, buildRevertInput(revision.snapshot) as any, {
      reason,
      author: change.author,
      changeType: 'revert',
      revertedFromRevisionId: revisionId,
    })

    return {
      service,
      revertedFrom: revisionId,
      crossProfile,
      warning: crossProfile
        ? `Profile-scoped values (GPU pin, start-on-boot) came from profile "${revision.profileName}" and were applied to the active profile "${active?.name}".`
        : null,
    }
  },

  async startService(id: string) {
    await initializeIfNeeded()
    const service = await serviceRepository.findById(id)
    if (!service) {
      const err = new Error('Service not found')
      ;(err as any).statusCode = 404
      throw err
    }

    // A service that is already running releases its own VRAM as part of the
    // restart this start performs, so the net change is ~zero — guarding it would
    // only refuse the service its own card. Matches restartService.
    if (!processManager.isRunning(id)) {
      // Reap the service's own leftover GPU processes first: an orphan of a previous
      // run holding the card would otherwise make admission refuse the very service
      // that owns it.
      await sweepServiceGpuOrphans(service)
      await assertVramAvailable(service)
    }
    await freePortForService(service)

    // Record the intent before the spawn, not after: if the start throws, the box still
    // wants this service up, and auto-restart should keep trying.
    await serviceRepository.setDesiredStatus(id, 'running')

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

    // A deliberate stop is the one thing that switches auto-restart off for this
    // service until somebody starts it again. Everything that stops a service on
    // purpose — the Stop button, a profile switch, a deploy — comes through here.
    await serviceRepository.setDesiredStatus(id, 'stopped')

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

    // "Stopped" must mean the card is free. Killing the port holder is not the same
    // as freeing the VRAM — an orphaned llama-server.exe survived both and kept 30 GB
    // while the API reported success (task-1493).
    const vramNotes = await sweepServiceGpuOrphans(service)

    const mem = processManager.getStatus(id)
    return {
      id,
      status: mem?.status || 'stopped',
      pid: mem?.pid ?? null,
      ...(vramNotes.length > 0 && { vramNotes }),
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

    // A service already running on the GPU releases its own VRAM as part of the
    // restart, so the net change is ~zero — guarding it would only false-positive.
    // A restart of a STOPPED service is a real stopped→running transition.
    if (!processManager.isRunning(id)) {
      await sweepServiceGpuOrphans(service)
      await assertVramAvailable(service)
    }
    await freePortForService(service)

    await serviceRepository.setDesiredStatus(id, 'running')

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

  /**
   * The service's recent Service-Manager events — deaths, refused starts, profile-switch
   * stops, auto-restart attempts — read from the history file the run log's truncation
   * does not touch. This is what makes "it went down last night, why?" answerable after
   * the restart that erased the run log (task-1593).
   * @param id - the service to report on
   * @param limit - how many of the most recent events to return
   */
  getEvents(id: string, limit = 40) {
    return readServiceEvents(id).slice(-limit)
  },

  clearOutput(id: string) {
    processManager.clearOutput(id)
  },

  getProcessStatus(id: string) {
    return processManager.getStatus(id)
  },
}
