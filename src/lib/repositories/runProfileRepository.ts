import { prisma } from '@/lib/db'

export interface UpsertProfileServiceInput {
  cudaDevice?: string | null
  startOnBoot?: boolean
}

const profileInclude = {
  services: {
    include: {
      service: {
        select: { name: true, port: true },
      },
    },
  },
} as const

export const runProfileRepository = {
  async findAll() {
    return prisma.runProfile.findMany({
      orderBy: { createdAt: 'asc' },
      include: profileInclude,
    })
  },

  async findById(id: string) {
    return prisma.runProfile.findUnique({
      where: { id },
      include: profileInclude,
    })
  },

  async findActive() {
    return prisma.runProfile.findFirst({
      where: { isActive: true },
      include: profileInclude,
    })
  },

  async create(name: string) {
    return prisma.runProfile.create({
      data: { name, isActive: false },
      include: profileInclude,
    })
  },

  async setActive(id: string) {
    await prisma.runProfile.updateMany({ data: { isActive: false } })
    return prisma.runProfile.update({
      where: { id },
      data: { isActive: true },
      include: profileInclude,
    })
  },

  async rename(id: string, name: string) {
    return prisma.runProfile.update({
      where: { id },
      data: { name },
      include: profileInclude,
    })
  },

  async findProfileService(profileId: string, serviceId: string) {
    return prisma.runProfileService.findUnique({
      where: { profileId_serviceId: { profileId, serviceId } },
    })
  },

  async upsertProfileService(profileId: string, serviceId: string, data: UpsertProfileServiceInput) {
    return prisma.runProfileService.upsert({
      where: { profileId_serviceId: { profileId, serviceId } },
      create: {
        profileId,
        serviceId,
        cudaDevice: data.cudaDevice ?? null,
        startOnBoot: data.startOnBoot ?? false,
      },
      update: {
        ...(data.cudaDevice !== undefined && { cudaDevice: data.cudaDevice }),
        ...(data.startOnBoot !== undefined && { startOnBoot: data.startOnBoot }),
      },
    })
  },

  async createProfileServicesForAllProfiles(serviceId: string, activeProfileOverride?: UpsertProfileServiceInput) {
    const profiles = await prisma.runProfile.findMany()
    for (const profile of profiles) {
      await prisma.runProfileService.upsert({
        where: { profileId_serviceId: { profileId: profile.id, serviceId } },
        create: {
          profileId: profile.id,
          serviceId,
          cudaDevice: activeProfileOverride?.cudaDevice ?? null,
          startOnBoot: activeProfileOverride?.startOnBoot ?? false,
        },
        update: {},
      })
    }
  },

  async cloneProfileServices(sourceProfileId: string, targetProfileId: string) {
    const source = await prisma.runProfile.findUnique({
      where: { id: sourceProfileId },
      include: { services: true },
    })
    if (!source) return
    for (const svc of source.services) {
      await prisma.runProfileService.upsert({
        where: { profileId_serviceId: { profileId: targetProfileId, serviceId: svc.serviceId } },
        create: {
          profileId: targetProfileId,
          serviceId: svc.serviceId,
          cudaDevice: svc.cudaDevice,
          startOnBoot: svc.startOnBoot,
        },
        update: {},
      })
    }
  },

  async delete(id: string) {
    // RunProfileService rows cascade (onDelete: Cascade on the relation).
    await prisma.runProfile.delete({ where: { id } })
  },

  /**
   * Ensures every profile has a RunProfileService row for every service, creating
   * the missing ones with neutral defaults (no GPU pin, not started on boot).
   * Returns how many rows were added, so callers can log real drift.
   *
   * This is the self-healing half of "a new service shows up in every profile":
   * createService writes the rows up front, but any service that predates a profile
   * — or was added while a write failed — would otherwise be invisible in that
   * profile forever.
   */
  async backfillProfileServices(): Promise<number> {
    const [profiles, services] = await Promise.all([
      prisma.runProfile.findMany({ select: { id: true } }),
      prisma.service.findMany({ select: { id: true } }),
    ])
    const existing = await prisma.runProfileService.findMany({
      select: { profileId: true, serviceId: true },
    })
    const have = new Set(existing.map(r => `${r.profileId}:${r.serviceId}`))

    const missing = []
    for (const profile of profiles) {
      for (const service of services) {
        if (have.has(`${profile.id}:${service.id}`)) continue
        missing.push({ profileId: profile.id, serviceId: service.id, cudaDevice: null, startOnBoot: false })
      }
    }
    if (missing.length === 0) return 0
    await prisma.runProfileService.createMany({ data: missing })
    return missing.length
  },

  async findAutoStartServices(profileId: string) {
    return prisma.runProfileService.findMany({
      where: { profileId, startOnBoot: true },
      include: { service: true },
    })
  },

  async count() {
    return prisma.runProfile.count()
  },
}
