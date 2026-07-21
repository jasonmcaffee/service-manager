import { processManager } from '@/lib/process-manager'
import { runProfileRepository, UpsertProfileServiceInput } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { initializeIfNeeded, ensureDefaultProfile } from '@/lib/services/init'
import { serviceService } from '@/lib/services/serviceService'
import { diffProfiles, EffectiveConfig, DiffAction } from '@/lib/services/profileDiff'
import { isProtectedServiceName } from '@/lib/util/processGuard'

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
async function applyProfileAction(serviceId: string, action: DiffAction): Promise<{ id: string; name: string; status: string; error?: string } | null> {
  const service = await serviceRepository.findById(serviceId)
  if (!service) return null

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
    return runProfileRepository.findAll()
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

    for (const [serviceId, action] of actions) {
      if (action === 'noop') continue
      const result = await applyProfileAction(serviceId, action)
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

  async upsertServiceOverride(profileId: string, serviceId: string, data: UpsertProfileServiceInput) {
    return runProfileRepository.upsertProfileService(profileId, serviceId, data)
  },

  async getServiceOverride(profileId: string, serviceId: string) {
    return runProfileRepository.findProfileService(profileId, serviceId)
  },
}
