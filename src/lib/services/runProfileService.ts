import { processManager } from '@/lib/process-manager'
import { runProfileRepository, UpsertProfileServiceInput } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { initializeIfNeeded, ensureDefaultProfile } from '@/lib/services/init'
import { diffProfiles, EffectiveConfig } from '@/lib/services/profileDiff'

function buildEnv(port: number | null | undefined, cudaDevice: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  if (port) env.PORT = String(port)
  if (cudaDevice) env.CUDA_DEVICE = cudaDevice
  return env
}

function makeOnStateChange(id: string) {
  return async (status: import('@/lib/process-manager').ServiceStatus, pid?: number) => {
    await serviceRepository.update(id, { status, pid: pid ?? null })
  }
}

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

    const actions = diffProfiles(prevConfigs, nextConfigs, sid => processManager.isRunning(sid))

    // Switch the active profile before spawning so env vars resolve correctly
    const profile = await runProfileRepository.setActive(id)

    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    for (const [serviceId, action] of actions) {
      if (action === 'noop') continue

      const nextCfg = nextConfigs.find(c => c.serviceId === serviceId)
      const service = await serviceRepository.findById(serviceId)
      if (!service) continue

      const env = buildEnv(nextCfg?.port, nextCfg?.cudaDevice)
      const onStateChange = makeOnStateChange(serviceId)

      try {
        if (action === 'stop') {
          await processManager.stopService(serviceId, onStateChange)
          results.push({ id: serviceId, name: service.name, status: 'stopped' })
        } else if (action === 'start') {
          await processManager.startService(serviceId, service.command, env, onStateChange)
          results.push({ id: serviceId, name: service.name, status: 'started' })
          await new Promise(resolve => setTimeout(resolve, 500))
        } else if (action === 'restart') {
          await processManager.restartService(serviceId, service.command, env, onStateChange)
          results.push({ id: serviceId, name: service.name, status: 'restarted' })
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      } catch (error: any) {
        results.push({ id: serviceId, name: service.name, status: 'error', error: error.message })
      }
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
