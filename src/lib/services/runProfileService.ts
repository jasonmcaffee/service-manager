import { processManager } from '@/lib/process-manager'
import { runProfileRepository, UpsertProfileServiceInput } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { initializeIfNeeded, ensureDefaultProfile } from '@/lib/services/init'
import { serviceService } from '@/lib/services/serviceService'
import { diffProfiles, EffectiveConfig, DiffAction } from '@/lib/services/profileDiff'
import { isProtectedServiceName } from '@/lib/util/processGuard'
import { appendServiceNote } from '@/lib/util/logTailer'
import { extractCudaDevicesFromCommand, parseCudaDevices } from '@/lib/util/gpuGuard'

/**
 * Builds an EffectiveConfig array for every service under the given profile.
 * Merges global fields (command, port) with profile-specific overrides (cudaDevice, startOnBoot).
 * @param profileId - the profile to build configs for
 */
async function buildEffectiveConfigs(profileId: string): Promise<EffectiveConfig[]> {
  const [allServices, profile] = await Promise.all([
    serviceRepository.findAll(),
    runProfileRepository.findById(profileId),
  ])

  return allServices.map(svc => {
    const override = profile?.services.find(s => s.serviceId === svc.id)
    return {
      serviceId: svc.id,
      command: svc.command,
      port: svc.port,
      cudaDevice: override?.cudaDevice ?? null,
      startOnBoot: override?.startOnBoot ?? false,
    }
  })
}

/**
 * Returns the ids of services a profile switch must never stop or restart —
 * the claude/opencode terminal daemons that host the agent session driving
 * Service Manager.
 */
async function buildProtectedServiceIds(): Promise<Set<string>> {
  const services = await serviceRepository.findAll()
  return new Set(services.filter(s => isProtectedServiceName(s.name)).map(s => s.id))
}

/**
 * Applies one profile-switch action to a service through serviceService, so a
 * switch gets exactly the same guarded treatment as a manual start/stop/restart
 * (scoped port free, never-kill guard, WSL portproxy, DB state persistence).
 * @param serviceId - the service to act on
 * @param action - the diff action to apply ('start' | 'stop' | 'restart')
 */
async function applyProfileAction(serviceId: string, action: DiffAction, profileName?: string): Promise<{ id: string; name: string; status: string; error?: string } | null> {
  const service = await serviceRepository.findById(serviceId)
  if (!service) return null

  // A profile switch is the other way a service "just stops" with nothing in its
  // output to say why, so the reason is written where someone would look (task-1493).
  const because = profileName ? ` (switching to profile "${profileName}")` : ''
  if (action !== 'noop') {
    appendServiceNote(serviceId, `Profile switch: performing ${action}${because}.`)
  }

  try {
    if (action === 'stop') {
      await serviceService.stopService(serviceId)
      return { id: serviceId, name: service.name, status: 'stopped' }
    }
    if (action === 'start') {
      await serviceService.startService(serviceId)
      await new Promise(resolve => setTimeout(resolve, 500))
      return { id: serviceId, name: service.name, status: 'started' }
    }
    if (action === 'restart') {
      await serviceService.restartService(serviceId)
      await new Promise(resolve => setTimeout(resolve, 500))
      return { id: serviceId, name: service.name, status: 'restarted' }
    }
    return null
  } catch (error: any) {
    return { id: serviceId, name: service.name, status: 'error', error: error.message }
  }
}

export { ensureDefaultProfile }

export const runProfileService = {
  async listProfiles() {
    await ensureDefaultProfile()
    // Self-heal any profile that is missing a service, so a newly added service
    // shows up in EVERY profile rather than only the one it was created under.
    const added = await runProfileRepository.backfillProfileServices()
    if (added > 0) console.log(`[runProfileService] backfilled ${added} missing profile-service row(s)`)
    return runProfileRepository.findAll()
  },

  /**
   * Deletes a profile. The active profile is protected — removing it would leave
   * Service Manager with no effective config for cudaDevice/startOnBoot.
   * @param id - the profile to delete
   */
  async deleteProfile(id: string) {
    const profile = await runProfileRepository.findById(id)
    if (!profile) {
      const err = new Error(`Profile not found: ${id}`)
      ;(err as any).statusCode = 404
      throw err
    }
    if (profile.isActive) {
      const err = new Error('Cannot delete the active profile. Switch to another profile first.')
      ;(err as any).statusCode = 409
      throw err
    }
    const count = await runProfileRepository.count()
    if (count <= 1) {
      const err = new Error('Cannot delete the last remaining profile.')
      ;(err as any).statusCode = 409
      throw err
    }
    await runProfileRepository.delete(id)
    return { id, deleted: true }
  },

  async getActiveProfile() {
    await ensureDefaultProfile()
    return runProfileRepository.findActive()
  },

  async createProfile(name: string) {
    const active = await runProfileRepository.findActive()
    const newProfile = await runProfileRepository.create(name)
    if (active) {
      await runProfileRepository.cloneProfileServices(active.id, newProfile.id)
    } else {
      const services = await serviceRepository.findAll()
      for (const service of services) {
        await runProfileRepository.upsertProfileService(newProfile.id, service.id, {})
      }
    }
    return runProfileRepository.findById(newProfile.id)
  },

  async switchProfile(id: string) {
    await initializeIfNeeded()

    const exists = await runProfileRepository.findById(id)
    if (!exists) {
      const err = new Error(`Profile not found: ${id}`)
      ;(err as any).statusCode = 404
      throw err
    }

    const prevProfile = await runProfileRepository.findActive()
    const prevId = prevProfile?.id ?? id

    const [prevConfigs, nextConfigs] = await Promise.all([
      buildEffectiveConfigs(prevId),
      buildEffectiveConfigs(id),
    ])

    const protectedIds = await buildProtectedServiceIds()
    const actions = diffProfiles(
      prevConfigs, nextConfigs,
      sid => processManager.isRunning(sid),
      sid => protectedIds.has(sid),
    )

    // Switch the active profile before spawning so env vars resolve correctly
    const profile = await runProfileRepository.setActive(id)

    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    // Stops must land before starts. The outgoing and incoming profiles routinely
    // trade the same GPU (llama on cuda1 vs the second ComfyUI on cuda1), so
    // starting first would briefly run both on one card — which does not OOM
    // cleanly, it hard-hangs the machine (task-1406). Freeing first also releases
    // ports before the incoming service claims them.
    const ordered = [...actions].filter(([, action]) => action !== 'noop')
    ordered.sort(([, a], [, b]) => (a === 'stop' ? 0 : 1) - (b === 'stop' ? 0 : 1))

    for (const [serviceId, action] of ordered) {
      const result = await applyProfileAction(serviceId, action, profile.name)
      if (result) results.push(result)
    }

    return { profile, startedServices: results }
  },

  async renameProfile(id: string, name: string) {
    if (!name.trim()) {
      const err = new Error('Name cannot be empty')
      ;(err as any).statusCode = 400
      throw err
    }
    return runProfileRepository.rename(id, name.trim())
  },

  /**
   * Writes a profile's per-service override. A cudaDevice that contradicts a device
   * the service's start command hard-codes is rejected here as well as on the
   * service endpoint, so there is no path that can store a pin the process will not
   * honour (task-1493).
   * @param profileId - profile owning the override
   * @param serviceId - service being overridden
   * @param data - the cudaDevice / startOnBoot values to write
   */
  async upsertServiceOverride(profileId: string, serviceId: string, data: UpsertProfileServiceInput) {
    if (data.cudaDevice !== undefined && data.cudaDevice !== null && String(data.cudaDevice).trim() !== '') {
      const service = await serviceRepository.findById(serviceId)
      const commandPin = extractCudaDevicesFromCommand(service?.command)
      const requested = String(data.cudaDevice).trim()
      if (commandPin && parseCudaDevices(commandPin).join(',') !== parseCudaDevices(requested).join(',')) {
        const err = new Error(
          `Cannot set cudaDevice to "${requested}": the start command hard-codes GPU "${commandPin}". ` +
          `Change the command (or make it use %CUDA_DEVICE%) so the registration and the process agree.`
        )
        ;(err as any).statusCode = 409
        throw err
      }
    }
    return runProfileRepository.upsertProfileService(profileId, serviceId, data)
  },

  async getServiceOverride(profileId: string, serviceId: string) {
    return runProfileRepository.findProfileService(profileId, serviceId)
  },
}
