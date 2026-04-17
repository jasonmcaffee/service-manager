import { prisma } from '@/lib/db'

export interface UpsertProfileServiceInput {
  cudaDevice?: string | null
  startOnBoot?: boolean
}

export const runProfileRepository = {
  async findAll() {
    return prisma.runProfile.findMany({
      orderBy: { createdAt: 'asc' },
      include: { services: true },
    })
  },

  async findById(id: string) {
    return prisma.runProfile.findUnique({
      where: { id },
      include: { services: true },
    })
  },

  async findActive() {
    return prisma.runProfile.findFirst({
      where: { isActive: true },
      include: { services: true },
    })
  },

  async create(name: string) {
    return prisma.runProfile.create({
      data: { name, isActive: false },
      include: { services: true },
    })
  },

  async setActive(id: string) {
    await prisma.runProfile.updateMany({ data: { isActive: false } })
    return prisma.runProfile.update({
      where: { id },
      data: { isActive: true },
      include: { services: true },
    })
  },

  async rename(id: string, name: string) {
    return prisma.runProfile.update({
      where: { id },
      data: { name },
      include: { services: true },
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
      const isActive = profile.isActive
      await prisma.runProfileService.upsert({
        where: { profileId_serviceId: { profileId: profile.id, serviceId } },
        create: {
          profileId: profile.id,
          serviceId,
          cudaDevice: isActive ? (activeProfileOverride?.cudaDevice ?? null) : null,
          startOnBoot: isActive ? (activeProfileOverride?.startOnBoot ?? false) : false,
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
