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
        status: 'stopped',
        pid: null,
      },
    })
  },

  async update(id: string, data: UpdateServiceInput) {
    return prisma.service.update({ where: { id }, data })
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
