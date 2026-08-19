import { prisma } from '@/lib/db'

export interface CreateServiceInput {
  name: string
  description?: string | null
  command: string
  port?: number | null
  noPort?: boolean
  wsl?: boolean
  // cudaDevice and startOnBoot are profile-specific; stored in RunProfileService
  cudaDevice?: string | null
  startOnBoot?: boolean
  autoRestart?: boolean
  minFreeVramMb?: number | null
}

export interface UpdateServiceInput {
  name?: string
  description?: string | null
  command?: string
  port?: number | null
  noPort?: boolean
  wsl?: boolean
  status?: string
  pid?: number | null
  minFreeVramMb?: number | null
  desiredStatus?: string
}

export const serviceRepository = {
  async findAll() {
    return prisma.service.findMany({ orderBy: { createdAt: 'asc' } })
  },

  async findById(id: string) {
    return prisma.service.findUnique({ where: { id } })
  },

  async create(data: CreateServiceInput) {
    return prisma.service.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        command: data.command,
        port: data.port ?? null,
        noPort: data.noPort ?? false,
        wsl: data.wsl ?? false,
        minFreeVramMb: data.minFreeVramMb ?? null,
        status: 'stopped',
        pid: null,
      },
    })
  },

  async update(id: string, data: UpdateServiceInput) {
    return prisma.service.update({ where: { id }, data })
  },

  /**
   * Records what a service is supposed to be doing, separately from what it is doing.
   * Written on every deliberate start/stop and whenever the service is observed
   * listening, so auto-restart can tell "it died" from "it was turned off".
   * Never throws: intent is advisory, and losing it must not fail a start or a stop.
   * @param id - the service whose intent changed
   * @param desiredStatus - 'running' or 'stopped'
   */
  async setDesiredStatus(id: string, desiredStatus: 'running' | 'stopped') {
    try {
      await prisma.service.update({ where: { id }, data: { desiredStatus } })
    } catch (err: any) {
      console.warn(`[serviceRepository] could not set desiredStatus=${desiredStatus} for ${id}:`, err?.message)
    }
  },

  async delete(id: string) {
    await prisma.service.delete({ where: { id } })
  },

  async findByName(name: string) {
    return prisma.service.findFirst({ where: { name } })
  },

  /** Returns the port for a service without loading the full row. */
  async getPort(id: string): Promise<number | null> {
    const svc = await prisma.service.findUnique({ where: { id }, select: { port: true } })
    return svc?.port ?? null
  },

  /** Returns all services that have the given port configured (for collision detection). */
  async findByPort(port: number): Promise<{ id: string; name: string }[]> {
    return prisma.service.findMany({ where: { port }, select: { id: true, name: true } })
  },
}
