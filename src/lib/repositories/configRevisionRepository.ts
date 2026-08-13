import { prisma } from '@/lib/db'

export interface CreateConfigRevisionInput {
  serviceId: string
  serviceName: string
  profileId?: string | null
  profileName?: string | null
  changeType: string
  author?: string
  reason: string
  /** JSON string of the config AFTER the change; null for a delete. */
  snapshot?: string | null
  /** JSON string of the config BEFORE the change; null for create/baseline. */
  previous?: string | null
  /** JSON string of [{ field, from, to }]. */
  changedFields?: string
  revertedFromRevisionId?: string | null
}

export const configRevisionRepository = {
  async create(data: CreateConfigRevisionInput) {
    return prisma.configRevision.create({
      data: {
        serviceId: data.serviceId,
        serviceName: data.serviceName,
        profileId: data.profileId ?? null,
        profileName: data.profileName ?? null,
        changeType: data.changeType,
        author: data.author ?? 'ui',
        reason: data.reason,
        snapshot: data.snapshot ?? null,
        previous: data.previous ?? null,
        changedFields: data.changedFields ?? '[]',
        revertedFromRevisionId: data.revertedFromRevisionId ?? null,
      },
    })
  },

  /** Newest first — the History tab reads top-down. */
  async listByService(serviceId: string, limit = 50) {
    return prisma.configRevision.findMany({
      where: { serviceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  },

  async findById(id: string) {
    return prisma.configRevision.findUnique({ where: { id } })
  },

  async countByService(serviceId: string): Promise<number> {
    return prisma.configRevision.count({ where: { serviceId } })
  },

  /** Service ids that already have at least one revision (used by the baseline backfill). */
  async listServiceIdsWithRevisions(): Promise<Set<string>> {
    const rows = await prisma.configRevision.findMany({
      distinct: ['serviceId'],
      select: { serviceId: true },
    })
    return new Set(rows.map(r => r.serviceId))
  },
}
