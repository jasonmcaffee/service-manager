import { prisma } from '@/lib/db'

export interface CreateServiceInput {
  name: string
  description?: string | null
  command: string
  startOnBoot?: boolean
  port?: number | null
  cudaDevice?: string | null
}

export interface UpdateServiceInput {
  name?: string
  description?: string | null
  command?: string
  startOnBoot?: boolean
  port?: number | null
  cudaDevice?: string | null
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
        startOnBoot: data.startOnBoot ?? false,
        port: data.port ?? null,
        cudaDevice: data.cudaDevice ?? null,
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

  async findAutoStart() {
    return prisma.service.findMany({
      where: { startOnBoot: true },
      orderBy: { createdAt: 'asc' },
    })
  },
}
