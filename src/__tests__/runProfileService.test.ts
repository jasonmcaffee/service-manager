// Mock process-manager
const mockProcessManager = {
  isRunning: jest.fn(() => false),
  startService: jest.fn(async () => {}),
  stopService: jest.fn(async () => {}),
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
  findAutoStartServices: jest.fn(async () => []),
  count: jest.fn(async () => 1),
}

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: mockProfileRepo,
}))

jest.mock('@/lib/util/batchWriter', () => ({
  writeBatchFile: jest.fn(() => '/tmp/test.bat'),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockProfileRepo.count.mockResolvedValue(1)
  mockProfileRepo.findActive.mockResolvedValue({ id: 'profile-1', name: 'Default', isActive: true, services: [] })
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

describe('runProfileService.switchProfile', () => {
  it('stops all running services', async () => {
    const svc1 = makeService({ id: 'svc-1' })
    const svc2 = makeService({ id: 'svc-2' })
    mockServiceRepo.findAll.mockResolvedValue([svc1, svc2])
    mockProcessManager.isRunning.mockReturnValue(true)
    mockProfileRepo.setActive.mockResolvedValue(makeProfile({ id: 'profile-2', isActive: true }))

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.stopService).toHaveBeenCalledTimes(2)
  })

  it('does not stop services that are not running', async () => {
    mockServiceRepo.findAll.mockResolvedValue([makeService()])
    mockProcessManager.isRunning.mockReturnValue(false)
    mockProfileRepo.setActive.mockResolvedValue(makeProfile())

    await runProfileService.switchProfile('profile-1')

    expect(mockProcessManager.stopService).not.toHaveBeenCalled()
  })

  it('sets the new profile as active', async () => {
    mockServiceRepo.findAll.mockResolvedValue([])
    mockProfileRepo.setActive.mockResolvedValue(makeProfile({ id: 'profile-2', isActive: true }))

    await runProfileService.switchProfile('profile-2')

    expect(mockProfileRepo.setActive).toHaveBeenCalledWith('profile-2')
  })

  it('starts autostart services for the new profile', async () => {
    const svc = makeService()
    mockServiceRepo.findAll.mockResolvedValue([])
    mockProfileRepo.setActive.mockResolvedValue(makeProfile({ id: 'profile-2' }))
    mockProfileRepo.findAutoStartServices.mockResolvedValue([
      { service: svc, cudaDevice: '1', startOnBoot: true }
    ])

    const result = await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      { CUDA_DEVICE: '1' },
      expect.any(Function)
    )
    expect(result.startedServices[0].status).toBe('started')
  })

  it('passes PORT env var when service has a port', async () => {
    const svc = makeService({ port: 8080 })
    mockServiceRepo.findAll.mockResolvedValue([])
    mockProfileRepo.setActive.mockResolvedValue(makeProfile({ id: 'profile-2' }))
    mockProfileRepo.findAutoStartServices.mockResolvedValue([
      { service: svc, cudaDevice: null, startOnBoot: true }
    ])

    await runProfileService.switchProfile('profile-2')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      { PORT: '8080' },
      expect.any(Function)
    )
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
