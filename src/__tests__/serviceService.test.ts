// Mock process-manager before any imports
const mockProcessManager = {
  hasBootStarted: jest.fn(() => false),
  markBootStarted: jest.fn(),
  isRunning: jest.fn(() => false),
  startService: jest.fn(async () => {}),
  stopService: jest.fn(async () => {}),
  restartService: jest.fn(async () => {}),
  getStatus: jest.fn(() => undefined),
  getOutput: jest.fn(() => []),
  clearOutput: jest.fn(),
  restoreFromDb: jest.fn(),
}

jest.mock('@/lib/process-manager', () => ({
  processManager: mockProcessManager,
}))

// Mock portHelper
const mockKillPort = jest.fn(async () => ({ killed: true, pids: [1234] }))
jest.mock('@/lib/util/portHelper', () => ({
  killPort: mockKillPort,
  isPortListening: jest.fn(async () => false),
}))

// Mock serviceRepository
const mockRepo = {
  findAll: jest.fn(async () => []),
  findById: jest.fn(async () => null),
  create: jest.fn(async (data: any) => ({ id: 'test-id', ...data, createdAt: new Date(), updatedAt: new Date() })),
  update: jest.fn(async (id: string, data: any) => ({ id, ...data })),
  delete: jest.fn(async () => {}),
  findAutoStart: jest.fn(async () => []),
}

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: mockRepo,
}))

// Also mock batchWriter (used by processManager internally, but mocked above)
jest.mock('@/lib/util/batchWriter', () => ({
  writeBatchFile: jest.fn(() => '/tmp/service-manager/service-test.bat'),
}))

// Reset global init flag before each test
beforeEach(() => {
  jest.clearAllMocks()
  mockProcessManager.hasBootStarted.mockReturnValue(false)
  mockProcessManager.isRunning.mockReturnValue(false)
  mockProcessManager.getStatus.mockReturnValue(undefined)
  ;(globalThis as any).processManagerInitialized = false
})

import { serviceService } from '@/lib/services/serviceService'

const makeService = (overrides = {}) => ({
  id: 'svc-1',
  name: 'Test Service',
  description: null,
  command: 'echo hello',
  startOnBoot: false,
  port: null,
  cudaDevice: null,
  pid: null,
  status: 'stopped',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('serviceService.runAutoStart', () => {
  it('starts auto-start services on first call', async () => {
    const svc = makeService({ startOnBoot: true })
    mockRepo.findAutoStart.mockResolvedValue([svc])
    mockRepo.findAll.mockResolvedValue([svc])

    const result = await serviceService.runAutoStart()

    expect(result.alreadyStarted).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].status).toBe('started')
    expect(mockProcessManager.markBootStarted).toHaveBeenCalledTimes(1)
    expect(mockProcessManager.startService).toHaveBeenCalledTimes(1)
  })

  it('skips starting on subsequent calls (boot guard)', async () => {
    mockProcessManager.hasBootStarted.mockReturnValue(true)
    const svc = makeService({ startOnBoot: true })
    mockRepo.findAutoStart.mockResolvedValue([svc])

    const result = await serviceService.runAutoStart()

    expect(result.alreadyStarted).toBe(true)
    expect(result.results).toHaveLength(0)
    expect(mockProcessManager.startService).not.toHaveBeenCalled()
  })

  it('skips services already running', async () => {
    const svc = makeService({ startOnBoot: true })
    mockRepo.findAutoStart.mockResolvedValue([svc])
    mockRepo.findAll.mockResolvedValue([svc])
    mockProcessManager.isRunning.mockReturnValue(true)

    const result = await serviceService.runAutoStart()

    expect(result.results[0].status).toBe('already_running')
    expect(mockProcessManager.startService).not.toHaveBeenCalled()
  })
})

describe('serviceService.stopService', () => {
  it('stops service and does not call killPort when no port configured', async () => {
    const svc = makeService({ port: null })
    mockRepo.findById.mockResolvedValue(svc)

    await serviceService.stopService('svc-1')

    expect(mockProcessManager.stopService).toHaveBeenCalledWith('svc-1', expect.any(Function))
    expect(mockKillPort).not.toHaveBeenCalled()
  })

  it('calls killPort as fallback when PID kill fails and port is configured', async () => {
    const svc = makeService({ port: 9999 })
    mockRepo.findById.mockResolvedValue(svc)
    // Process still appears running after stopService
    mockProcessManager.isRunning.mockReturnValue(true)

    await serviceService.stopService('svc-1')

    expect(mockProcessManager.stopService).toHaveBeenCalled()
    expect(mockKillPort).toHaveBeenCalledWith(9999)
  })

  it('does not call killPort if process stopped cleanly', async () => {
    const svc = makeService({ port: 8080 })
    mockRepo.findById.mockResolvedValue(svc)
    mockProcessManager.isRunning.mockReturnValue(false)

    await serviceService.stopService('svc-1')

    expect(mockKillPort).not.toHaveBeenCalled()
  })
})

describe('serviceService.startService', () => {
  it('passes PORT env var when port is set', async () => {
    const svc = makeService({ port: 8080 })
    mockRepo.findById.mockResolvedValue(svc)

    await serviceService.startService('svc-1')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      { PORT: '8080' },
      expect.any(Function)
    )
  })

  it('passes CUDA_DEVICE env var when cudaDevice is set', async () => {
    const svc = makeService({ cudaDevice: 'cuda1' })
    mockRepo.findById.mockResolvedValue(svc)

    await serviceService.startService('svc-1')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      { CUDA_DEVICE: 'cuda1' },
      expect.any(Function)
    )
  })

  it('passes both PORT and CUDA_DEVICE when both are set', async () => {
    const svc = makeService({ port: 8080, cudaDevice: '1' })
    mockRepo.findById.mockResolvedValue(svc)

    await serviceService.startService('svc-1')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      { PORT: '8080', CUDA_DEVICE: '1' },
      expect.any(Function)
    )
  })

  it('passes empty env when neither port nor cudaDevice is set', async () => {
    const svc = makeService()
    mockRepo.findById.mockResolvedValue(svc)

    await serviceService.startService('svc-1')

    expect(mockProcessManager.startService).toHaveBeenCalledWith(
      'svc-1',
      'echo hello',
      {},
      expect.any(Function)
    )
  })
})

describe('serviceService.createService', () => {
  it('rejects port below 1', async () => {
    await expect(serviceService.createService({ name: 'x', command: 'echo', port: 0 }))
      .rejects.toThrow('Port must be an integer between 1 and 65535')
  })

  it('rejects port above 65535', async () => {
    await expect(serviceService.createService({ name: 'x', command: 'echo', port: 99999 }))
      .rejects.toThrow('Port must be an integer between 1 and 65535')
  })

  it('accepts null port', async () => {
    mockRepo.create.mockResolvedValue(makeService())
    await expect(serviceService.createService({ name: 'x', command: 'echo', port: null }))
      .resolves.toBeDefined()
  })

  it('accepts valid port', async () => {
    mockRepo.create.mockResolvedValue(makeService({ port: 8080 }))
    await expect(serviceService.createService({ name: 'x', command: 'echo', port: 8080 }))
      .resolves.toBeDefined()
    expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })
})
