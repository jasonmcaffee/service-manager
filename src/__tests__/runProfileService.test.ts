// Mock process-manager
const mockProcessManager = {
  isRunning: jest.fn(() => false),
  startService: jest.fn(async () => {}),
  stopService: jest.fn(async () => {}),
  restartService: jest.fn(async () => {}),
  adoptExternal: jest.fn(),
  adoptNoPort: jest.fn(),
  getStatus: jest.fn(() => undefined as any),
  getSpawnedPids: jest.fn((_id: string) => [] as number[]),
  getTrackedPidsByService: jest.fn(() => new Map<string, number[]>()),
}

jest.mock('@/lib/process-manager', () => ({
  processManager: mockProcessManager,
}))

// Mock serviceRepository
const mockServiceRepo = {
  findAll: jest.fn(async () => []),
  findById: jest.fn(async () => null),
  update: jest.fn(async (id: string, data: any) => ({ id, ...data })),
}

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: mockServiceRepo,
}))

// Mock runProfileRepository
const mockProfileRepo = {
  findAll: jest.fn(async () => []),
  findById: jest.fn(async () => null),
  findActive: jest.fn(async () => null),
  create: jest.fn(async (name: string) => ({ id: 'new-profile', name, isActive: false, services: [] })),
  setActive: jest.fn(async (id: string) => ({ id, name: 'Profile', isActive: true, services: [] })),
  findProfileService: jest.fn(async () => null),
  upsertProfileService: jest.fn(async (profileId: string, serviceId: string, data: any) => ({
    id: 'rps-1', profileId, serviceId, ...data
  })),
  createProfileServicesForAllProfiles: jest.fn(async () => {}),
  cloneProfileServices: jest.fn(async () => {}),
  backfillProfileServices: jest.fn(async () => 0),
  delete: jest.fn(async (_id: string) => {}),
  findAutoStartServices: jest.fn(async () => []),
  count: jest.fn(async () => 1),
  rename: jest.fn(async (id: string, name: string) => ({ id, name, isActive: false, services: [] })),
}

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: mockProfileRepo,
}))

// Mock init so initializeIfNeeded is a no-op in these tests
jest.mock('@/lib/services/init', () => ({
  initializeIfNeeded: jest.fn(async () => {}),
  ensureDefaultProfile: jest.fn(async () => {}),
}))

jest.mock('@/lib/util/batchWriter', () => ({
  writeStartupScript: jest.fn(() => ({ scriptFile: '/tmp/test.bat', logFile: '/tmp/test.log' })),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockProfileRepo.count.mockResolvedValue(1)
  mockProfileRepo.findActive.mockResolvedValue({ id: 'profile-1', name: 'Default', isActive: true, services: [] })
  // clearAllMocks keeps implementations, so reset the per-test override explicitly
  mockProfileRepo.findProfileService.mockResolvedValue(null)
  mockProfileRepo.findAutoStartServices.mockResolvedValue([])
  mockProcessManager.isRunning.mockReturnValue(false)
})

import { runProfileService } from '@/lib/services/runProfileService'

const makeProfile = (overrides = {}) => ({
  id: 'profile-1',
  name: 'Default',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  services: [],
  ...overrides,
})

const makeService = (overrides = {}) => ({
  id: 'svc-1',
  name: 'My Service',
  command: 'echo hello',
  port: null,
  pid: null,
  status: 'stopped',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('runProfileService.listProfiles', () => {
  it('returns all profiles', async () => {
    mockProfileRepo.findAll.mockResolvedValue([makeProfile()])
    const profiles = await runProfileService.listProfiles()
    expect(profiles).toHaveLength(1)
    expect(mockProfileRepo.findAll).toHaveBeenCalled()
  })
})

describe('runProfileService.getActiveProfile', () => {
  it('returns the active profile', async () => {
    mockProfileRepo.findActive.mockResolvedValue(makeProfile())
    const profile = await runProfileService.getActiveProfile()
    expect(profile?.isActive).toBe(true)
  })
})

describe('runProfileService.createProfile', () => {
  it('clones active profile services into new profile', async () => {
    mockProfileRepo.findActive.mockResolvedValue(makeProfile())
    mockProfileRepo.create.mockResolvedValue({ id: 'new-p', name: 'New', isActive: false, services: [] })
    mockProfileRepo.findById.mockResolvedValue({ id: 'new-p', name: 'New', isActive: false, services: [] })

    await runProfileService.createProfile('New')

    expect(mockProfileRepo.create).toHaveBeenCalledWith('New')
    expect(mockProfileRepo.cloneProfileServices).toHaveBeenCalledWith('profile-1', 'new-p')
  })

  it('creates empty profile services when no active profile', async () => {
    mockProfileRepo.findActive.mockResolvedValue(null)
    mockProfileRepo.create.mockResolvedValue({ id: 'new-p', name: 'New', isActive: false, services: [] })
    mockServiceRepo.findAll.mockResolvedValue([makeService()])
    mockProfileRepo.findById.mockResolvedValue({ id: 'new-p', name: 'New', isActive: false, services: [] })

    await runProfileService.createProfile('New')

    expect(mockProfileRepo.upsertProfileService).toHaveBeenCalledWith('new-p', 'svc-1', {})
  })
})

describe('runProfileService.switchProfile — diff behaviour', () => {
  const prevProfile = makeProfile({ id: 'profile-1', services: [{ serviceId: 'svc-1', cudaDevice: '0', startOnBoot: true }] })
  const targetProfile = makeProfile({ id: 'profile-2', services: [{ serviceId: 'svc-1', cudaDevice: '0', startOnBoot: true }] })
  const svc1 = makeService({ id: 'svc-1', command: 'echo hello', port: null })

  it('does NOT stop a service whose config is identical between profiles', async () => {
    mockProfileRepo.findById
      .mockResolvedValueOnce(targetProfile)  // exists check
      .mockResolvedValueOnce(prevProfile)    // buildEffectiveConfigs prev
      .mockResolvedValueOnce(targetProfile)  // buildEffectiveConfigs next
    mockProfileRepo.findActive.mockResolvedValue(prevProfile)
    mockServiceRepo.findAll.mockResolvedValue([svc1])
    mockProcessManager.isRunning.mockReturnValue(true)
    mockProfileRepo.setActive.mockResolvedValue(targetProfile)

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.stopService).not.toHaveBeenCalled()
    expect(mockProcessManager.restartService).not.toHaveBeenCalled()
  })

  it('restarts a service when cudaDevice changes and it is running', async () => {
    const prevWithCuda = makeProfile({ id: 'profile-1', services: [{ serviceId: 'svc-1', cudaDevice: '0', startOnBoot: true }] })
    const nextWithCuda = makeProfile({ id: 'profile-2', services: [{ serviceId: 'svc-1', cudaDevice: '1', startOnBoot: true }] })

    mockProfileRepo.findById
      .mockResolvedValueOnce(nextWithCuda) // exists check
      .mockResolvedValueOnce(prevWithCuda) // prev configs
      .mockResolvedValueOnce(nextWithCuda) // next configs
    mockProfileRepo.findActive.mockResolvedValue(prevWithCuda)
    mockServiceRepo.findAll.mockResolvedValue([svc1])
    mockServiceRepo.findById.mockResolvedValue(svc1)
    mockProcessManager.isRunning.mockReturnValue(true)
    mockProfileRepo.setActive.mockResolvedValue(nextWithCuda)
    // Profile switches now run through serviceService, which resolves CUDA_DEVICE
    // from the (already-activated) profile override rather than the diff config.
    mockProfileRepo.findProfileService.mockResolvedValue({ cudaDevice: '1', startOnBoot: true } as any)

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.restartService).toHaveBeenCalledWith(
      'svc-1', 'echo hello', { CUDA_DEVICE: '1' }, expect.any(Function)
    )
  })

  it('stops a running service that is not startOnBoot in the target profile', async () => {
    const prevAutoStart = makeProfile({ id: 'profile-1', services: [{ serviceId: 'svc-1', cudaDevice: null, startOnBoot: true }] })
    const nextNoStart = makeProfile({ id: 'profile-2', services: [{ serviceId: 'svc-1', cudaDevice: null, startOnBoot: false }] })

    mockProfileRepo.findById
      .mockResolvedValueOnce(nextNoStart)
      .mockResolvedValueOnce(prevAutoStart)
      .mockResolvedValueOnce(nextNoStart)
    mockProfileRepo.findActive.mockResolvedValue(prevAutoStart)
    mockServiceRepo.findAll.mockResolvedValue([svc1])
    mockServiceRepo.findById.mockResolvedValue(svc1)
    mockProcessManager.isRunning.mockReturnValue(true)
    mockProfileRepo.setActive.mockResolvedValue(nextNoStart)

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.stopService).toHaveBeenCalledWith('svc-1', expect.any(Function))
    expect(mockProcessManager.startService).not.toHaveBeenCalled()
  })

  it('starts a service that becomes startOnBoot and is not currently running', async () => {
    const prevNoStart = makeProfile({ id: 'profile-1', services: [{ serviceId: 'svc-1', cudaDevice: null, startOnBoot: false }] })
    const nextAutoStart = makeProfile({ id: 'profile-2', services: [{ serviceId: 'svc-1', cudaDevice: null, startOnBoot: true }] })

    mockProfileRepo.findById
      .mockResolvedValueOnce(nextAutoStart)
      .mockResolvedValueOnce(prevNoStart)
      .mockResolvedValueOnce(nextAutoStart)
    mockProfileRepo.findActive.mockResolvedValue(prevNoStart)
    mockServiceRepo.findAll.mockResolvedValue([svc1])
    mockServiceRepo.findById.mockResolvedValue(svc1)
    mockProcessManager.isRunning.mockReturnValue(false)
    mockProfileRepo.setActive.mockResolvedValue(nextAutoStart)

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1', 'echo hello', {}, expect.any(Function)
    )
    expect(mockProcessManager.stopService).not.toHaveBeenCalled()
  })

  it('throws 404 when switching to a non-existent profile', async () => {
    mockProfileRepo.findById.mockResolvedValueOnce(null)
    await expect(runProfileService.switchProfile('bad-id')).rejects.toThrow('Profile not found')
  })
})

describe('runProfileService.upsertServiceOverride', () => {
  it('updates cudaDevice for the specified profile', async () => {
    mockProfileRepo.upsertProfileService.mockResolvedValue({
      id: 'rps-1', profileId: 'profile-1', serviceId: 'svc-1', cudaDevice: '2', startOnBoot: false
    })

    const result = await runProfileService.upsertServiceOverride('profile-1', 'svc-1', { cudaDevice: '2' })

    expect(mockProfileRepo.upsertProfileService).toHaveBeenCalledWith('profile-1', 'svc-1', { cudaDevice: '2' })
    expect(result.cudaDevice).toBe('2')
  })

  it('does not affect other profiles when updating one profile', async () => {
    await runProfileService.upsertServiceOverride('profile-1', 'svc-1', { cudaDevice: '0' })

    expect(mockProfileRepo.upsertProfileService).toHaveBeenCalledTimes(1)
    expect(mockProfileRepo.upsertProfileService).toHaveBeenCalledWith(
      'profile-1', 'svc-1', { cudaDevice: '0' }
    )
  })
})
