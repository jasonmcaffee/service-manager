/**
 * Unit tests for the Reconciler background tick.
 * All dependencies are mocked — no real OS calls, no real processes.
 *
 * The reconciler's contract: the OS is the source of truth. Each tick must
 * make backend state (processManager + DB) match what the OS shows on each
 * service's port. The UI then paints backend state — no UI-only state.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

const mockVerifyHealthWithMaps = jest.fn(() => ({ healthy: true }))
const mockMarkUnhealthy = jest.fn()
const mockGetStatus = jest.fn((): any => undefined)
const mockAdoptExternal = jest.fn()

jest.mock('@/lib/process-manager', () => ({
  processManager: {
    getStatus: mockGetStatus,
    verifyHealthWithMaps: mockVerifyHealthWithMaps,
    markUnhealthy: mockMarkUnhealthy,
    adoptExternal: mockAdoptExternal,
  },
}))

const mockFindAll = jest.fn(async () => [] as any[])
const mockUpdate = jest.fn(async () => ({}))

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    findAll: mockFindAll,
    update: mockUpdate,
  },
}))

const mockFindActiveProfile = jest.fn(async () => null as any)
const mockFindAutoStart = jest.fn(async () => [] as any[])

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: mockFindActiveProfile,
    findAutoStartServices: mockFindAutoStart,
  },
}))

const mockSnapshotWindows = jest.fn(async () => new Map<number, number[]>() as Map<number, number[]> | null)
const mockSnapshotWsl = jest.fn(async () => new Map<number, number[]>() as Map<number, number[]> | null)
const mockIsWslProxyPid = jest.fn(async () => false)

jest.mock('@/lib/util/portHelper', () => ({
  snapshotWindowsListeners: mockSnapshotWindows,
  snapshotWslListeners: mockSnapshotWsl,
  isWslProxyPid: mockIsWslProxyPid,
}))

jest.mock('@/lib/lifecycle', () => ({
  onShutdown: jest.fn(),
  fireAllSync: jest.fn(),
}))

// ── tests ────────────────────────────────────────────────────────────────────

import { reconciler } from '@/lib/services/reconciler'

beforeEach(() => {
  jest.clearAllMocks()
  reconciler.stop()
  ;(globalThis as any).reconcilerInstance = undefined
})

afterEach(() => {
  reconciler.stop()
})

describe('Reconciler.tick — snapshot behavior', () => {
  it('takes ONE port snapshot per tick regardless of service count', async () => {
    mockFindAll.mockResolvedValue([
      { id: 'a', port: 7070, status: 'running' },
      { id: 'b', port: 8080, status: 'running' },
      { id: 'c', port: 9090, status: 'running' },
    ])
    mockGetStatus.mockReturnValue({ status: 'running' })

    await reconciler.tick()

    expect(mockSnapshotWindows).toHaveBeenCalledTimes(1)
    expect(mockSnapshotWsl).toHaveBeenCalledTimes(1)
  })

  it('ignores noPort services (they use log-freshness, not port snapshots)', async () => {
    mockFindAll.mockResolvedValue([
      { id: 'noport-svc', port: null, status: 'running' },
    ])
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('Reconciler.tick — OS as source of truth', () => {
  it('does nothing when service is stopped and no listener is on its port', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map())

    mockFindAll.mockResolvedValue([{ id: 'svc-1', port: 8080, status: 'stopped', wsl: true }])
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('marks a DB=running service stopped when no listener is on its port', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map())

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true }])
    mockGetStatus.mockReturnValue({ status: 'running', adoption: 'wsl', pid: 12345 })

    await reconciler.tick()

    expect(mockMarkUnhealthy).toHaveBeenCalledWith('vllm-id', 'port-not-bound')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'stopped', pid: null })
  })

  it('preserves DB=error status when no listener (does not clobber error info with stopped)', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map())

    mockFindAll.mockResolvedValue([{ id: 'crashed-svc', port: 8080, status: 'error', wsl: true }])
    mockGetStatus.mockReturnValue({ status: 'error', adoption: undefined, pid: undefined })

    await reconciler.tick()

    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('adopts a service whose listener appears on its port (DB was previously running)', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [46947]]]))

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true, name: 'vllm' }])
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 46947, 'wsl')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'running', pid: 46947 })
  })

  it('adopts a service whose listener appears even when DB says stopped (vllm-survival case)', async () => {
    // This is the user-reported bug: vllm's cmd.exe died (so we marked it stopped)
    // but the WSL vllm process kept running. Reconciler must re-adopt to match OS.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [80924]]]))

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'stopped', wsl: true, name: 'vllm' }])
    mockGetStatus.mockReturnValue({ status: 'stopped', adoption: undefined, pid: undefined, process: null })

    await reconciler.tick()

    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 80924, 'wsl')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'running', pid: 80924 })
  })

  it('re-adopts with a new pid when an adopted service\'s pid changed via internal restart', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [99999]]]))

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true, pid: 46947, name: 'vllm' }])
    mockGetStatus.mockReturnValue({ status: 'running', adoption: 'wsl', pid: 46947 })

    await reconciler.tick()

    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 99999, 'wsl')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'running', pid: 99999 })
  })

  it('leaves a correctly-adopted service alone (no DB write churn)', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [46947]]]))

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true, pid: 46947 }])
    mockGetStatus.mockReturnValue({ status: 'running', adoption: 'wsl', pid: 46947 })

    await reconciler.tick()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
  })

  it('does not touch a spawned service whose child is still alive (model loading grace)', async () => {
    // User just clicked Start; cmd.exe is alive; vllm hasn't bound the port yet.
    // The reconciler must not declare it stopped during this window.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map())

    mockFindAll.mockResolvedValue([{ id: 'svc-1', port: 8080, status: 'running', wsl: true }])
    mockGetStatus.mockReturnValue({
      status: 'running',
      process: { exitCode: null, killed: false }, // alive
      pid: 11111,
    })

    await reconciler.tick()

    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('Reconciler.tick — port/PID claim tracking across services', () => {
  it('does not adopt a second service with the same PID when both share a port (autostart owner wins)', async () => {
    // vllm + Llama.cpp both configured for port 8080; only vllm is in autostart.
    // Without claim tracking the reconciler used to adopt the WSL pid for BOTH,
    // so stopping Llama.cpp via the UI would kill vllm. Autostart ranking must
    // route the claim to vllm; Llama.cpp must remain stopped.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [406576]]]))

    mockFindAll.mockResolvedValue([
      { id: 'llama-id', port: 8080, status: 'stopped', wsl: true, name: 'Llama.cpp' },
      { id: 'vllm-id', port: 8080, status: 'running', wsl: true, name: 'vllm' },
    ])
    mockFindActiveProfile.mockResolvedValueOnce({ id: 'p1' })
    mockFindAutoStart.mockResolvedValueOnce([{ serviceId: 'vllm-id' }])
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockAdoptExternal).toHaveBeenCalledTimes(1)
    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 406576, 'wsl')
    // Llama.cpp must not have been adopted with vllm's PID
    expect(mockAdoptExternal).not.toHaveBeenCalledWith('llama-id', 406576, 'wsl')
  })

  it('does not clobber an already-adopted service when a lower-priority service shares its port', async () => {
    // vllm is correctly adopted (memMatches=true → skip). Llama.cpp shares port
    // but must NOT inherit vllm's PID just because vllm's branch returned early.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [406576]]]))

    mockFindAll.mockResolvedValue([
      { id: 'vllm-id', port: 8080, status: 'running', wsl: true, pid: 406576, name: 'vllm' },
      { id: 'llama-id', port: 8080, status: 'stopped', wsl: true, name: 'Llama.cpp' },
    ])
    mockFindActiveProfile.mockResolvedValueOnce({ id: 'p1' })
    mockFindAutoStart.mockResolvedValueOnce([{ serviceId: 'vllm-id' }])
    mockGetStatus.mockImplementation((id: string) =>
      id === 'vllm-id'
        ? { status: 'running', adoption: 'wsl', pid: 406576 }
        : undefined
    )

    await reconciler.tick()

    // vllm is already correct — no adopt call (memMatches short-circuits)
    expect(mockAdoptExternal).not.toHaveBeenCalled()
    // Llama.cpp must NOT have been adopted with the same PID
    expect(mockUpdate).not.toHaveBeenCalledWith('llama-id', expect.objectContaining({ status: 'running' }))
  })
})

describe('Reconciler.tick — snapshot-failure resilience', () => {
  it('skips a wsl service when wsl snapshot returns null (does NOT mark stopped)', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(null)

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true }])
    mockGetStatus.mockReturnValue({ status: 'running', adoption: 'wsl', pid: 46947 })

    await reconciler.tick()

    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('skips a wsl-untracked service when wsl snapshot returns null', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(null)

    mockFindAll.mockResolvedValue([{ id: 'vllm-id', port: 8080, status: 'running', wsl: true }])
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('Reconciler lifecycle', () => {
  it('start() is idempotent — calling it twice does not double-tick', async () => {
    jest.useFakeTimers()
    mockFindAll.mockResolvedValue([])

    reconciler.start()
    reconciler.start() // second call should be a no-op

    // Run both the immediate tick and the first interval tick
    await Promise.resolve()
    jest.advanceTimersByTime(10_000)
    await Promise.resolve()

    jest.useRealTimers()
    // snapshotWindows called once per tick (2 ticks: immediate + interval)
    // Not 4 (which would indicate two intervals running)
    expect(mockSnapshotWindows.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('stop() prevents further ticks', async () => {
    jest.useFakeTimers()
    mockFindAll.mockResolvedValue([])

    reconciler.start()
    await Promise.resolve() // let the immediate tick run
    reconciler.stop()

    jest.advanceTimersByTime(30_000)
    await Promise.resolve()

    jest.useRealTimers()
    // After stop(), no new ticks should have run (only the initial immediate one)
    expect(mockSnapshotWindows.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
