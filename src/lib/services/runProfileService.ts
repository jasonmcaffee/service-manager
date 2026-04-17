import { processManager } from '@/lib/process-manager'
import { runProfileRepository, UpsertProfileServiceInput } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'

export async function ensureDefaultProfile(): Promise<void> {
  const count = await runProfileRepository.count()
  if (count > 0) return

  const profile = await runProfileRepository.create('Default')
  await runProfileRepository.setActive(profile.id)

  // Migrate existing service data (cudaDevice/startOnBoot from legacy columns)
  const services = await serviceRepository.findAll()
  for (const service of services) {
    await runProfileRepository.upsertProfileService(profile.id, service.id, {
      cudaDevice: (service as any).cudaDevice ?? null,
      startOnBoot: (service as any).startOnBoot ?? false,
    })
  }
}

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
    // Stop all running services
    const allServices = await serviceRepository.findAll()
    for (const service of allServices) {
      if (processManager.isRunning(service.id)) {
        await processManager.stopService(service.id, makeOnStateChange(service.id))
      }
    }

    // Switch active profile
    const profile = await runProfileRepository.setActive(id)

    // Start autostart services for the new profile
    const autoStartEntries = await runProfileRepository.findAutoStartServices(id)
    const results: Array<{ id: string; name: string; status: string; error?: string }> = []

    for (const entry of autoStartEntries) {
      const service = entry.service
      try {
        await processManager.startService(
          service.id,
          service.command,
          buildEnv(service.port, entry.cudaDevice),
          makeOnStateChange(service.id)
        )
        results.push({ id: service.id, name: service.name, status: 'started' })
        await new Promise(resolve => setTimeout(resolve, 500))
      } catch (error: any) {
        results.push({ id: service.id, name: service.name, status: 'error', error: error.message })
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
