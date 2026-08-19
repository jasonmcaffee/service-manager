/**
 * Change-log coverage (task-1523): a configuration change must explain itself, must be
 * recorded with both snapshots, and must be restorable. The repositories are backed by
 * in-memory stores rather than jest.fn() stubs so the service layer's real read/write
 * paths (snapshot capture, profile-override routing, diffing) actually execute.
 */

// ---- in-memory stores -------------------------------------------------------
interface StoredService {
  id: string
  name: string
  description: string | null
  command: string
  port: number | null
  noPort: boolean
  wsl: boolean
  minFreeVramMb: number | null
  status: string
  pid: number | null
  createdAt: Date
  updatedAt: Date
}

const services = new Map<string, StoredService>()
const profileServices = new Map<string, { id: string; profileId: string; serviceId: string; cudaDevice: string | null; startOnBoot: boolean }>()
const revisions: any[] = []
const ACTIVE_PROFILE = { id: 'profile-1', name: 'Default', isActive: true, services: [] as any[] }

let idCounter = 0
const nextId = (prefix: string) => `${prefix}-${++idCounter}`

const mockProcessManager = {
  isRunning: jest.fn(() => false),
  stopService: jest.fn(async () => {}),
  startService: jest.fn(async () => {}),
  restartService: jest.fn(async () => {}),
  getStatus: jest.fn(() => undefined as any),
  getOutput: jest.fn(() => [] as string[]),
  getSpawnedPids: jest.fn((_id: string) => [] as number[]),
  hasBootStarted: jest.fn(() => true),
  markBootStarted: jest.fn(),
}
jest.mock('@/lib/process-manager', () => ({ processManager: mockProcessManager }))

jest.mock('@/lib/util/portHelper', () => ({
  killPort: jest.fn(async () => ({ killed: false, pids: [] })),
  killMatchingProcesses: jest.fn(async () => {}),
  ensureWslPortProxy: jest.fn(async () => {}),
  extractServiceDir: jest.fn(() => null),
}))

jest.mock('@/lib/services/init', () => ({
  initializeIfNeeded: jest.fn(async () => {}),
  ensureDefaultProfile: jest.fn(async () => {}),
  startAutoStartServices: jest.fn(async () => []),
}))

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    findAll: jest.fn(async () => Array.from(services.values())),
    findById: jest.fn(async (id: string) => services.get(id) ?? null),
    findByName: jest.fn(async (name: string) => Array.from(services.values()).find(s => s.name === name) ?? null),
    findByPort: jest.fn(async (port: number) => Array.from(services.values()).filter(s => s.port === port).map(s => ({ id: s.id, name: s.name }))),
    getPort: jest.fn(async (id: string) => services.get(id)?.port ?? null),
    setDesiredStatus: jest.fn(async () => undefined),
    create: jest.fn(async (data: any) => {
      const row: StoredService = {
        id: nextId('svc'),
        name: data.name,
        description: data.description ?? null,
        command: data.command,
        port: data.port ?? null,
        noPort: data.noPort ?? false,
        wsl: data.wsl ?? false,
        minFreeVramMb: data.minFreeVramMb ?? null,
        status: 'stopped',
        pid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      services.set(row.id, row)
      return row
    }),
    update: jest.fn(async (id: string, data: any) => {
      const row = services.get(id)
      if (!row) throw new Error('not found')
      const updated = { ...row, ...data, updatedAt: new Date() }
      services.set(id, updated)
      return updated
    }),
    delete: jest.fn(async (id: string) => { services.delete(id) }),
  },
}))

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: jest.fn(async () => ACTIVE_PROFILE),
    findById: jest.fn(async (id: string) => (id === ACTIVE_PROFILE.id ? ACTIVE_PROFILE : null)),
    findProfileService: jest.fn(async (profileId: string, serviceId: string) => profileServices.get(`${profileId}:${serviceId}`) ?? null),
    upsertProfileService: jest.fn(async (profileId: string, serviceId: string, data: any) => {
      const key = `${profileId}:${serviceId}`
      const existing = profileServices.get(key)
      const row = {
        id: existing?.id ?? nextId('rps'),
        profileId,
        serviceId,
        cudaDevice: data.cudaDevice !== undefined ? data.cudaDevice : existing?.cudaDevice ?? null,
        startOnBoot: data.startOnBoot !== undefined ? Boolean(data.startOnBoot) : existing?.startOnBoot ?? false,
      }
      profileServices.set(key, row)
      return row
    }),
    createProfileServicesForAllProfiles: jest.fn(async (serviceId: string, data: any) => {
      profileServices.set(`${ACTIVE_PROFILE.id}:${serviceId}`, {
        id: nextId('rps'),
        profileId: ACTIVE_PROFILE.id,
        serviceId,
        cudaDevice: data?.cudaDevice ?? null,
        startOnBoot: Boolean(data?.startOnBoot),
      })
    }),
    backfillProfileServices: jest.fn(async () => 0),
    count: jest.fn(async () => 1),
  },
}))

jest.mock('@/lib/repositories/configRevisionRepository', () => ({
  configRevisionRepository: {
    create: jest.fn(async (data: any) => {
      const row = { id: nextId('rev'), createdAt: new Date(), seq: revisions.length, ...data }
      revisions.push(row)
      return row
    }),
    listByService: jest.fn(async (serviceId: string, limit = 50) =>
      revisions.filter(r => r.serviceId === serviceId).slice().reverse().slice(0, limit)),
    findById: jest.fn(async (id: string) => revisions.find(r => r.id === id) ?? null),
    countByService: jest.fn(async (serviceId: string) => revisions.filter(r => r.serviceId === serviceId).length),
    listServiceIdsWithRevisions: jest.fn(async () => new Set(revisions.map(r => r.serviceId))),
  },
}))

import { serviceService } from '@/lib/services/serviceService'
import { runProfileService } from '@/lib/services/runProfileService'
import { ensureBaselineRevisions, listRevisions } from '@/lib/services/configRevisionService'

const REASON = 'Switching to the dev command so hot reload works while debugging'

beforeEach(() => {
  jest.clearAllMocks()
  services.clear()
  profileServices.clear()
  revisions.length = 0
  mockProcessManager.isRunning.mockReturnValue(false)
  mockProcessManager.getStatus.mockReturnValue(undefined)
})

/** Registers a service through the real service layer so its create revision exists. */
async function createTestService(overrides: Record<string, unknown> = {}) {
  return serviceService.createService({
    name: 'Test Service',
    command: 'npm start',
    port: 3100,
    ...overrides,
  } as any, { reason: 'Registering the test service so the suite has something to change', author: 'api' })
}

describe('reason enforcement', () => {
  it('rejects a create with no reason and writes nothing', async () => {
    await expect(serviceService.createService({ name: 'X', command: 'echo' } as any, { reason: '' } as any))
      .rejects.toThrow(/reason is required/i)
    expect(services.size).toBe(0)
    expect(revisions).toHaveLength(0)
  })

  it.each([
    ['blank', '   '],
    ['too short', 'too short'.slice(0, 6)],
    ['single word', 'reconfigured'],
  ])('rejects an update whose reason is %s, leaving the service untouched', async (_label, reason) => {
    const service = await createTestService()
    const before = services.get(service.id)!.command

    await expect(serviceService.updateService(service.id, { command: 'npm run dev' }, { reason } as any))
      .rejects.toThrow(/reason is required/i)

    expect(services.get(service.id)!.command).toBe(before)
    expect(revisions.filter(r => r.changeType === 'update')).toHaveLength(0)
  })

  it('reports 400 as the status code so the route answers 400, not 500', async () => {
    await expect(serviceService.createService({ name: 'X', command: 'echo' } as any, { reason: 'no' } as any))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a delete with no reason and keeps the service', async () => {
    const service = await createTestService()
    await expect(serviceService.deleteService(service.id, { reason: '' } as any)).rejects.toThrow(/reason is required/i)
    expect(services.has(service.id)).toBe(true)
  })
})

describe('revision recording', () => {
  it('records a create revision with the reason and an after-snapshot', async () => {
    const service = await createTestService()

    const history = await listRevisions(service.id)
    expect(history).toHaveLength(1)
    expect(history[0].changeType).toBe('create')
    expect(history[0].reason).toMatch(/Registering the test service/)
    expect(history[0].previous).toBeNull()
    expect(history[0].snapshot?.command).toBe('npm start')
    expect(history[0].snapshot?.port).toBe(3100)
  })

  it('records exactly which fields an update changed, with from/to values', async () => {
    const service = await createTestService()
    await serviceService.updateService(service.id, { command: 'npm run dev', port: 3101 }, { reason: REASON, author: 'ui' })

    const [latest] = await listRevisions(service.id)
    expect(latest.changeType).toBe('update')
    expect(latest.author).toBe('ui')
    expect(latest.reason).toBe(REASON)
    expect(latest.changedFields.map(f => f.field).sort()).toEqual(['command', 'port'])
    expect(latest.changedFields.find(f => f.field === 'command')).toMatchObject({ from: 'npm start', to: 'npm run dev' })
    expect(latest.previous?.port).toBe(3100)
    expect(latest.snapshot?.port).toBe(3101)
  })

  it('records nothing when an update changes nothing', async () => {
    const service = await createTestService()
    const before = revisions.length

    await serviceService.updateService(service.id, { command: 'npm start' }, { reason: REASON })

    expect(revisions).toHaveLength(before)
  })

  it('records a profile override with the profile it applies to', async () => {
    const service = await createTestService()
    await runProfileService.upsertServiceOverride('profile-1', service.id, { cudaDevice: '1' }, {
      reason: 'Pinning to GPU 1 so ComfyUI keeps GPU 0 free for renders',
      author: 'agent',
    })

    const [latest] = await listRevisions(service.id)
    expect(latest.profileName).toBe('Default')
    expect(latest.author).toBe('agent')
    expect(latest.changedFields).toEqual([{ field: 'cudaDevice', from: null, to: '1' }])
  })

  it('routes startOnBoot to the active profile so the flag actually sticks', async () => {
    const service = await createTestService()
    await serviceService.updateService(service.id, { startOnBoot: true } as any, { reason: REASON })

    expect(profileServices.get(`profile-1:${service.id}`)?.startOnBoot).toBe(true)
    const [latest] = await listRevisions(service.id)
    expect(latest.changedFields).toEqual([{ field: 'startOnBoot', from: false, to: true }])
  })

  it('keeps the delete revision after the service row is gone', async () => {
    const service = await createTestService()
    await serviceService.deleteService(service.id, { reason: 'Retiring the scratch service now that the test is done' })

    expect(services.has(service.id)).toBe(false)
    const history = await listRevisions(service.id)
    expect(history[0].changeType).toBe('delete')
    expect(history[0].snapshot).toBeNull()
    expect(history[0].previous?.command).toBe('npm start')
  })

  it('writes no revisions for lifecycle actions', async () => {
    const service = await createTestService()
    const before = revisions.length

    await serviceService.startService(service.id)
    await serviceService.stopService(service.id)
    await serviceService.restartService(service.id)

    expect(revisions).toHaveLength(before)
  })
})

describe('revert', () => {
  it('restores the earlier config and records a new revert revision', async () => {
    const service = await createTestService()
    const [createRevision] = await listRevisions(service.id)

    await serviceService.updateService(service.id, { command: 'npm run dev', port: 3101 }, { reason: REASON })
    expect(services.get(service.id)!.command).toBe('npm run dev')

    const revisionCountBefore = revisions.length
    const result = await serviceService.revertToRevision(service.id, createRevision.id, {
      reason: 'Rolling back to the production command — the dev server crashed under load',
    })

    expect(services.get(service.id)!.command).toBe('npm start')
    expect(services.get(service.id)!.port).toBe(3100)
    expect(result.revertedFrom).toBe(createRevision.id)
    expect(revisions).toHaveLength(revisionCountBefore + 1)

    const [latest] = await listRevisions(service.id)
    expect(latest.changeType).toBe('revert')
    expect(latest.revertedFromRevisionId).toBe(createRevision.id)
    // History is append-only: the revision we restored from is untouched.
    const original = revisions.find(r => r.id === createRevision.id)
    expect(original.changeType).toBe('create')
  })

  it('refuses a revert with no reason and leaves the config alone', async () => {
    const service = await createTestService()
    const [createRevision] = await listRevisions(service.id)
    await serviceService.updateService(service.id, { command: 'npm run dev' }, { reason: REASON })

    await expect(serviceService.revertToRevision(service.id, createRevision.id, { reason: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(services.get(service.id)!.command).toBe('npm run dev')
  })

  it('refuses to revert a delete revision', async () => {
    const service = await createTestService()
    await serviceService.deleteService(service.id, { reason: 'Removing it so the revert path can be tested' })
    // Re-create the row so the service exists again but the delete revision remains.
    services.set(service.id, { ...(service as any), id: service.id, noPort: false, wsl: false, minFreeVramMb: null } as any)

    const deleteRevision = revisions.find(r => r.changeType === 'delete')
    await expect(serviceService.revertToRevision(service.id, deleteRevision.id, {
      reason: 'Trying to restore a configuration that does not exist',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects a revision id belonging to another service', async () => {
    const a = await createTestService({ name: 'A', port: 3200 })
    const b = await createTestService({ name: 'B', port: 3201 })
    const [aRevision] = await listRevisions(a.id)

    await expect(serviceService.revertToRevision(b.id, aRevision.id, {
      reason: 'Attempting to apply another service configuration by id',
    })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('baseline backfill', () => {
  it('gives a history-less service exactly one baseline revision, once', async () => {
    services.set('legacy-1', {
      id: 'legacy-1', name: 'Legacy', description: null, command: 'run.bat', port: 9000,
      noPort: false, wsl: false, minFreeVramMb: null, status: 'stopped', pid: null,
      createdAt: new Date(), updatedAt: new Date(),
    })

    expect(await ensureBaselineRevisions()).toBe(1)
    expect(await ensureBaselineRevisions()).toBe(0)

    const history = await listRevisions('legacy-1')
    expect(history).toHaveLength(1)
    expect(history[0].changeType).toBe('baseline')
    expect(history[0].snapshot?.command).toBe('run.bat')
  })
})

describe('listRevisions', () => {
  it('returns newest first and respects the limit', async () => {
    const service = await createTestService()
    await serviceService.updateService(service.id, { command: 'step-two' }, { reason: REASON })
    await serviceService.updateService(service.id, { command: 'step-three' }, { reason: REASON })

    const all = await listRevisions(service.id)
    expect(all.map(r => r.changeType)).toEqual(['update', 'update', 'create'])
    expect(all[0].snapshot?.command).toBe('step-three')

    const limited = await listRevisions(service.id, 1)
    expect(limited).toHaveLength(1)
    expect(limited[0].snapshot?.command).toBe('step-three')
  })
})
