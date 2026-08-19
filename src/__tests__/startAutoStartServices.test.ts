/**
 * Unit tests for init.startAutoStartServices — the server-side boot autostart.
 * Verifies it (a) selects exactly the active-profile start-on-boot services,
 * (b) skips ones already running/adopted, and (c) spawns the stopped ones.
 * All dependencies are mocked — no real ports, no real processes.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

const mockIsRunning = jest.fn((_id: string) => false)
const mockStartService = jest.fn(async (..._args: any[]) => {})

jest.mock('@/lib/process-manager', () => ({
  processManager: {
    isRunning: mockIsRunning,
    startService: mockStartService,
    getSpawnedPids: jest.fn((_id: string) => [] as number[]),
    getTrackedPidsByService: jest.fn(() => new Map()),
    // used by initializeIfNeeded's boot guard (not exercised in these tests)
    hasBootStarted: jest.fn(() => false),
    markBootStarted: jest.fn(),
  },
}))

const mockUpdate = jest.fn(async () => ({}))
jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    update: mockUpdate,
    findAll: jest.fn(async () => []),
    findByName: jest.fn(async () => null),
    setDesiredStatus: jest.fn(async () => undefined),
  },
}))

const mockFindActive = jest.fn(async (): Promise<any> => ({ id: 'profile-1' }))
const mockFindAutoStart = jest.fn(async (): Promise<any[]> => [])
jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: mockFindActive,
    findAutoStartServices: mockFindAutoStart,
    count: jest.fn(async () => 1),
  },
}))

const mockKillPort = jest.fn(async () => ({ killed: false, pids: [] }))
const mockKillMatching = jest.fn(async () => {})
const mockExtractDir = jest.fn((_cmd: string) => null)
const mockEnsureProxy = jest.fn(async () => {})
jest.mock('@/lib/util/portHelper', () => ({
  snapshotWindowsListeners: jest.fn(async () => new Map()),
  snapshotWslListeners: jest.fn(async () => new Map()),
  isWslProxyPid: jest.fn(async () => false),
  killPort: mockKillPort,
  killMatchingProcesses: mockKillMatching,
  extractServiceDir: mockExtractDir,
  ensureWslPortProxy: mockEnsureProxy,
}))

jest.mock('@/lib/util/logTailer', () => ({
  getLogFilePath: jest.fn((id: string) => `/tmp/${id}.log`),
}))

jest.mock('@/lib/services/reconciler', () => ({
  reconciler: { start: jest.fn(), setServiceStarter: jest.fn() },
}))

// ── helpers ────────────────────────────────────────────────────────────────

function makeEntry(id: string, name: string, overrides: any = {}) {
  return {
    cudaDevice: null,
    startOnBoot: true,
    service: { id, name, command: `echo ${name}`, port: null, wsl: false, ...overrides },
  }
}

import { startAutoStartServices } from '@/lib/services/init'

beforeEach(() => {
  jest.clearAllMocks()
  mockIsRunning.mockReturnValue(false)
  mockFindActive.mockResolvedValue({ id: 'profile-1' })
  mockFindAutoStart.mockResolvedValue([])
})

// ── tests ────────────────────────────────────────────────────────────────────

describe('startAutoStartServices', () => {
  it('starts every flagged service that is not already running', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-a', 'Llama'),
      makeEntry('svc-b', 'ComfyUI', { port: 8083 }),
    ])

    const results = await startAutoStartServices()

    expect(mockStartService).toHaveBeenCalledTimes(2)
    expect(mockStartService).toHaveBeenCalledWith('svc-a', 'echo Llama', expect.any(Object), expect.any(Function))
    expect(mockStartService).toHaveBeenCalledWith('svc-b', 'echo ComfyUI', expect.any(Object), expect.any(Function))
    expect(results.map(r => r.status)).toEqual(['started', 'started'])
  })

  it('only queries the active profile for start-on-boot services (selection)', async () => {
    await startAutoStartServices()
    expect(mockFindAutoStart).toHaveBeenCalledWith('profile-1')
  })

  it('skips services already running/adopted and never double-starts them', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-a', 'Llama'),
      makeEntry('svc-b', 'ComfyUI', { port: 8083 }),
    ])
    // svc-a already adopted/running, svc-b stopped
    mockIsRunning.mockImplementation((id: string) => id === 'svc-a')

    const results = await startAutoStartServices()

    expect(mockStartService).toHaveBeenCalledTimes(1)
    expect(mockStartService).toHaveBeenCalledWith('svc-b', expect.anything(), expect.anything(), expect.anything())
    expect(mockStartService).not.toHaveBeenCalledWith('svc-a', expect.anything(), expect.anything(), expect.anything())
    expect(results.find(r => r.id === 'svc-a')?.status).toBe('already_running')
    expect(results.find(r => r.id === 'svc-b')?.status).toBe('started')
  })

  it('frees the port before spawning a service that has one', async () => {
    mockFindAutoStart.mockResolvedValue([makeEntry('svc-b', 'ComfyUI', { port: 8083 })])

    await startAutoStartServices()

    expect(mockKillPort).toHaveBeenCalledWith(8083, expect.objectContaining({ ownerServiceId: expect.any(String) }))
  })

  it('passes PORT and CUDA_DEVICE env when configured', async () => {
    mockFindAutoStart.mockResolvedValue([
      { cudaDevice: '1', startOnBoot: true, service: { id: 'svc-b', name: 'ComfyUI', command: 'run', port: 8083, wsl: false } },
    ])

    await startAutoStartServices()

    const env = mockStartService.mock.calls[0][2]
    expect(env).toEqual({ PORT: '8083', CUDA_DEVICE: '1' })
  })

  it('re-establishes the WSL port proxy for WSL services', async () => {
    mockFindAutoStart.mockResolvedValue([
      { cudaDevice: null, startOnBoot: true, service: { id: 'svc-w', name: 'vllm', command: 'run', port: 8000, wsl: true } },
    ])

    await startAutoStartServices()

    expect(mockEnsureProxy).toHaveBeenCalledWith(8000)
  })

  it('records an error result and keeps going when a spawn throws', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-a', 'Llama'),
      makeEntry('svc-b', 'ComfyUI'),
    ])
    mockStartService.mockImplementationOnce(async () => { throw new Error('boom') })

    const results = await startAutoStartServices()

    expect(results.find(r => r.id === 'svc-a')?.status).toBe('error')
    expect(results.find(r => r.id === 'svc-a')?.error).toBe('boom')
    expect(results.find(r => r.id === 'svc-b')?.status).toBe('started')
  })

  it('returns empty and starts nothing when there is no active profile', async () => {
    mockFindActive.mockResolvedValue(null as any)

    const results = await startAutoStartServices()

    expect(results).toEqual([])
    expect(mockStartService).not.toHaveBeenCalled()
    expect(mockFindAutoStart).not.toHaveBeenCalled()
  })
})
