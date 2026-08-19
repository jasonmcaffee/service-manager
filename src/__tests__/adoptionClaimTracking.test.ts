/**
 * Unit tests for port-collision claim-tracking in adoptRunningServices.
 * Uses fully mocked dependencies — no real ports, no real processes.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

const mockAdoptExternal = jest.fn()
const mockIsRunning = jest.fn((_id: string) => false)

jest.mock('@/lib/process-manager', () => ({
  processManager: {
    isRunning: mockIsRunning,
    adoptExternal: mockAdoptExternal,
    // initializeIfNeeded now runs boot autostart guarded by these; return true so
    // these adoption-focused tests skip the autostart step entirely.
    hasBootStarted: jest.fn(() => true),
    markBootStarted: jest.fn(),
  },
}))

const mockFindAll = jest.fn()
const mockUpdate = jest.fn(async () => ({}))
const mockFindByName = jest.fn(async () => null)

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    findAll: mockFindAll,
    update: mockUpdate,
    findByName: mockFindByName,
    getPort: jest.fn(async () => null),
    findByPort: jest.fn(async () => []),
  },
}))

const mockFindActive = jest.fn(async () => null)
const mockFindAutoStart = jest.fn(async () => [])
const mockCount = jest.fn(async () => 1)

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: mockFindActive,
    findAutoStartServices: mockFindAutoStart,
    count: mockCount,
    create: jest.fn(),
    setActive: jest.fn(),
    upsertProfileService: jest.fn(),
  },
}))

// snapshotWindowsListeners and snapshotWslListeners are mocked per-test
const mockSnapshotWindows = jest.fn(async () => new Map<number, number[]>())
const mockSnapshotWsl = jest.fn(async () => new Map<number, number[]>())
// Default: no PID is a WSL proxy — tests that need svchost behaviour override this
const mockIsWslProxyPid = jest.fn(async (_pid: number) => false)

jest.mock('@/lib/util/portHelper', () => ({
  snapshotWindowsListeners: mockSnapshotWindows,
  snapshotWslListeners: mockSnapshotWsl,
  isWslProxyPid: mockIsWslProxyPid,
}))

jest.mock('@/lib/services/reconciler', () => ({
  reconciler: { start: jest.fn(), setServiceStarter: jest.fn() },
}))

jest.mock('@/lib/lifecycle', () => ({
  onShutdown: jest.fn(),
  fireAllSync: jest.fn(),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeService(id: string, name: string, port: number | null) {
  return { id, name, port, status: 'stopped', pid: null }
}

// ── tests ────────────────────────────────────────────────────────────────────

// Import AFTER mocks are set up
import { initializeIfNeeded } from '@/lib/services/init'

// Reset the global init promise before each test so we get a fresh run
beforeEach(() => {
  jest.clearAllMocks()
  ;(globalThis as any).smInitPromise = undefined
  mockIsRunning.mockReturnValue(false)
  mockCount.mockResolvedValue(1)  // skip ensureDefaultProfile
  mockFindActive.mockResolvedValue(null)
  mockFindAutoStart.mockResolvedValue([])
  mockFindByName.mockResolvedValue(null)  // no port backfills
  mockIsWslProxyPid.mockResolvedValue(false)  // not a proxy by default
})

describe('adoptRunningServices — port-collision claim tracking', () => {
  it('adopts the first service that claims a PID; second gets a conflict', async () => {
    // Two services on the same port, same Windows PID
    const vllm = makeService('vllm-id', 'vllm', 8080)
    const llama = makeService('llama-id', 'Llama.cpp Server', 8080)
    mockFindAll.mockResolvedValue([vllm, llama])
    mockSnapshotWindows.mockResolvedValue(new Map([[8080, [5196]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    // Only one adoptExternal call — vllm (first in list, no priority sorting without active profile)
    expect(mockAdoptExternal).toHaveBeenCalledTimes(1)
    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 5196, 'windows')
    // llama was NOT adopted
    expect(mockAdoptExternal).not.toHaveBeenCalledWith('llama-id', expect.anything(), expect.anything())
  })

  it('autostart service wins port collision over non-autostart', async () => {
    const vllm = makeService('vllm-id', 'vllm', 8080)
    const llama = makeService('llama-id', 'Llama.cpp Server', 8080)
    // DB returns llama first, but vllm is autostart
    mockFindAll.mockResolvedValue([llama, vllm])
    mockFindActive.mockResolvedValue({ id: 'p1', name: 'Default', isActive: true, services: [] })
    mockFindAutoStart.mockResolvedValue([{ serviceId: 'vllm-id', service: vllm }])
    mockSnapshotWindows.mockResolvedValue(new Map([[8080, [5196]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    // vllm (autostart) wins even though llama is first in findAll
    expect(mockAdoptExternal).toHaveBeenCalledTimes(1)
    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 5196, 'windows')
  })

  it('services on different ports adopt independently', async () => {
    const svcA = makeService('svc-a', 'Service A', 7070)
    const svcB = makeService('svc-b', 'Service B', 8082)
    mockFindAll.mockResolvedValue([svcA, svcB])
    mockSnapshotWindows.mockResolvedValue(new Map([[7070, [1000]], [8082, [2000]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    expect(mockAdoptExternal).toHaveBeenCalledTimes(2)
    expect(mockAdoptExternal).toHaveBeenCalledWith('svc-a', 1000, 'windows')
    expect(mockAdoptExternal).toHaveBeenCalledWith('svc-b', 2000, 'windows')
  })

  it('skips services with no port configured', async () => {
    const noPort = makeService('svc-np', 'No Port Svc', null)
    mockFindAll.mockResolvedValue([noPort])
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
  })

  it('skips services whose port is not listening on any PID', async () => {
    const svc = makeService('svc-1', 'My Service', 9999)
    mockFindAll.mockResolvedValue([svc])
    // port 9999 not in any map
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
  })

  it('skips services already marked running in processManager', async () => {
    const svc = makeService('svc-1', 'Already Running', 8080)
    mockFindAll.mockResolvedValue([svc])
    mockIsRunning.mockReturnValue(true)
    mockSnapshotWindows.mockResolvedValue(new Map([[8080, [1234]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
  })

  it('prefers Windows PID over WSL PID when both report the same port', async () => {
    const svc = makeService('svc-1', 'My Service', 8080)
    mockFindAll.mockResolvedValue([svc])
    mockSnapshotWindows.mockResolvedValue(new Map([[8080, [100]]]))
    mockSnapshotWsl.mockResolvedValue(new Map([[8080, [200]]]))

    await initializeIfNeeded()

    // Windows pid wins
    expect(mockAdoptExternal).toHaveBeenCalledWith('svc-1', 100, 'windows')
  })

  it('filters out Windows PIDs that are WSL proxy processes (svchost)', async () => {
    const svc = makeService('svc-1', 'My Service', 8080)
    mockFindAll.mockResolvedValue([svc])
    // Windows port is bound by svchost (PID 5196); WSL has nothing on 8080
    mockSnapshotWindows.mockResolvedValue(new Map([[8080, [5196]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockIsWslProxyPid.mockResolvedValue(true)  // 5196 is svchost

    await initializeIfNeeded()

    // svchost should be filtered → no candidate → no adoption
    expect(mockAdoptExternal).not.toHaveBeenCalled()
  })

  it('treats windows:pid and wsl:pid as separate claims', async () => {
    // Two services: one on windows, one on wsl — same numeric PID value but different namespaces
    const svcA = makeService('svc-a', 'Service A', 7070)
    const svcB = makeService('svc-b', 'Service B', 9090)
    mockFindAll.mockResolvedValue([svcA, svcB])
    mockSnapshotWindows.mockResolvedValue(new Map([[7070, [1234]]]))
    mockSnapshotWsl.mockResolvedValue(new Map([[9090, [1234]]]))

    await initializeIfNeeded()

    // Both adopt because windows:1234 ≠ wsl:1234
    expect(mockAdoptExternal).toHaveBeenCalledTimes(2)
    expect(mockAdoptExternal).toHaveBeenCalledWith('svc-a', 1234, 'windows')
    expect(mockAdoptExternal).toHaveBeenCalledWith('svc-b', 1234, 'wsl')
  })
})

describe('backfillKnownPorts', () => {
  it('backfills Speaches port to 8000 when port is null', async () => {
    const speaches = { id: 'speaches-id', name: 'Speaches STT & TTS', port: null, status: 'stopped', pid: null }
    mockFindByName.mockImplementation(async (name: string) =>
      name === 'Speaches STT & TTS' ? speaches : null
    )
    mockFindAll.mockResolvedValue([speaches])
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    expect(mockUpdate).toHaveBeenCalledWith('speaches-id', { port: 8000 })
  })

  it('does NOT backfill when Speaches already has a port set', async () => {
    const speaches = { id: 'speaches-id', name: 'Speaches STT & TTS', port: 8001, status: 'stopped', pid: null }
    mockFindByName.mockResolvedValue(speaches)
    mockFindAll.mockResolvedValue([speaches])
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map())

    await initializeIfNeeded()

    // update should NOT be called with port (status update from adoption is fine, but no port backfill)
    const portUpdates = mockUpdate.mock.calls.filter(
      ([, data]) => 'port' in data
    )
    expect(portUpdates).toHaveLength(0)
  })
})
