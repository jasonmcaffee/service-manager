import { prisma } from '@/lib/db'

export interface CreateServiceInput {
  name: string
  description?: string | null
  command: string
  port?: number | null
  // cudaDevice and startOnBoot are profile-specific; stored in RunProfileService
  cudaDevice?: string | null
  startOnBoot?: boolean
}

export interface UpdateServiceInput {
  name?: string
  description?: string | null
  command?: string
  port?: number | null
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

}
