/**
 * Unit tests for init.retryFailedAutoStartServices — the delayed boot-retry sweep
 * that self-heals start-on-boot services which failed their first launch (e.g. the
 * GPU-backed llama.cpp server when the NVIDIA driver wasn't ready yet on a cold boot).
 * Verifies it re-attempts ONLY the flagged services that are currently not running,
 * and never touches ones already up/adopted. All dependencies are mocked.
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

import { retryFailedAutoStartServices } from '@/lib/services/init'

beforeEach(() => {
  jest.clearAllMocks()
  mockIsRunning.mockReturnValue(false)
  mockFindActive.mockResolvedValue({ id: 'profile-1' })
  mockFindAutoStart.mockResolvedValue([])
})

// ── tests ────────────────────────────────────────────────────────────────────

describe('retryFailedAutoStartServices', () => {
  it('re-attempts only the flagged services that are currently down', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-llama', 'Llama.cpp Server', { port: 8080 }),
      makeEntry('svc-comfy', 'ComfyUI', { port: 8083 }),
    ])
    // Llama failed its boot launch (down); ComfyUI came up fine (running).
    mockIsRunning.mockImplementation((id: string) => id === 'svc-comfy')

    await retryFailedAutoStartServices(1)

    expect(mockStartService).toHaveBeenCalledTimes(1)
    expect(mockStartService).toHaveBeenCalledWith('svc-llama', 'echo Llama.cpp Server', expect.any(Object), expect.any(Function))
    expect(mockStartService).not.toHaveBeenCalledWith('svc-comfy', expect.anything(), expect.anything(), expect.anything())
  })

  it('frees the port before re-spawning a failed service', async () => {
    mockFindAutoStart.mockResolvedValue([makeEntry('svc-llama', 'Llama.cpp Server', { port: 8080 })])
    mockIsRunning.mockReturnValue(false)

    await retryFailedAutoStartServices(2)

    expect(mockKillPort).toHaveBeenCalledWith(8080, expect.objectContaining({ ownerServiceId: 'svc-llama' }))
    expect(mockStartService).toHaveBeenCalledWith('svc-llama', expect.anything(), expect.objectContaining({ PORT: '8080' }), expect.any(Function))
  })

  it('does nothing when every flagged service is already running', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-llama', 'Llama.cpp Server', { port: 8080 }),
      makeEntry('svc-comfy', 'ComfyUI', { port: 8083 }),
    ])
    mockIsRunning.mockReturnValue(true)

    await retryFailedAutoStartServices(1)

    expect(mockStartService).not.toHaveBeenCalled()
    expect(mockKillPort).not.toHaveBeenCalled()
  })

  // task-1593: this sweep runs for a few minutes after every manager boot, and it used
  // to restart anything flagged start-on-boot that was not running — including a service
  // somebody had deliberately stopped in that window, silently undoing the Stop.
  it('leaves a deliberately-stopped service alone instead of undoing the Stop', async () => {
    mockFindAutoStart.mockResolvedValue([
      makeEntry('svc-media', 'Media Site', { port: 3300, desiredStatus: 'stopped' }),
      makeEntry('svc-llama', 'Llama.cpp Server', { port: 8080, desiredStatus: 'running' }),
    ])
    mockIsRunning.mockReturnValue(false)

    await retryFailedAutoStartServices(1)

    expect(mockStartService).toHaveBeenCalledTimes(1)
    expect(mockStartService).toHaveBeenCalledWith('svc-llama', expect.anything(), expect.anything(), expect.any(Function))
    expect(mockKillPort).not.toHaveBeenCalledWith(3300, expect.anything())
  })

  it('is a no-op when there is no active profile', async () => {
    mockFindActive.mockResolvedValue(null as any)

    await retryFailedAutoStartServices(1)

    expect(mockFindAutoStart).not.toHaveBeenCalled()
    expect(mockStartService).not.toHaveBeenCalled()
  })
})
