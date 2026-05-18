/**
 * Unit tests for the Reconciler background tick.
 * All dependencies are mocked — no real OS calls, no real processes.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

const mockVerifyHealthWithMaps = jest.fn(() => ({ healthy: true }))
const mockMarkUnhealthy = jest.fn()
const mockGetStatus = jest.fn((): any => ({ status: 'running' }))
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

describe('Reconciler.tick', () => {
  it('takes ONE port snapshot per tick regardless of service count', async () => {
    const services = [
      { id: 'a', port: 7070, status: 'running' },
      { id: 'b', port: 8080, status: 'running' },
      { id: 'c', port: 9090, status: 'running' },
    ]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running' })
    mockVerifyHealthWithMaps.mockReturnValue({ healthy: true })

    await reconciler.tick()

    // One call each, not one per service
    expect(mockSnapshotWindows).toHaveBeenCalledTimes(1)
    expect(mockSnapshotWsl).toHaveBeenCalledTimes(1)
  })

  it('skips services that are not running', async () => {
    const services = [{ id: 'svc-1', port: 8080, status: 'stopped' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'stopped' })

    await reconciler.tick()

    expect(mockVerifyHealthWithMaps).not.toHaveBeenCalled()
    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
  })

  it('marks unhealthy + updates DB when port is not bound', async () => {
    const services = [{ id: 'vllm-id', port: 8080, status: 'running' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running' })
    mockVerifyHealthWithMaps.mockReturnValue({ healthy: false, reason: 'port-not-bound' })

    await reconciler.tick()

    expect(mockMarkUnhealthy).toHaveBeenCalledWith('vllm-id', 'port-not-bound')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'stopped', pid: null })
  })

  it('marks unhealthy when port is taken by a different PID', async () => {
    const services = [{ id: 'svc-1', port: 9999, status: 'running' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running' })
    mockVerifyHealthWithMaps.mockReturnValue({ healthy: false, reason: 'port-taken-by-other-pid' })

    await reconciler.tick()

    expect(mockMarkUnhealthy).toHaveBeenCalledWith('svc-1', 'port-taken-by-other-pid')
  })

  it('leaves healthy services alone', async () => {
    const services = [{ id: 'svc-ok', port: 7070, status: 'running' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running' })
    mockVerifyHealthWithMaps.mockReturnValue({ healthy: true })

    await reconciler.tick()

    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('skips verification when the WSL snapshot returns null and the service is wsl-adopted', async () => {
    // Reproduces the vllm-startup bug: a transient `wsl ss` failure must not flip
    // a healthy wsl-adopted service to stopped.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(null) // snapshot failed

    const services = [{ id: 'vllm-id', port: 8080, status: 'running', wsl: true }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running', adoption: 'wsl', pid: 12345 })

    await reconciler.tick()

    expect(mockVerifyHealthWithMaps).not.toHaveBeenCalled()
    expect(mockMarkUnhealthy).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('late-adopts a service that DB says running but processManager has not tracked', async () => {
    // Reproduces post-boot recovery: init-time adoption failed (snapshot empty) but
    // the WSL service is actually still listening. Reconciler should adopt it
    // rather than marking it stopped.
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map([[8080, [46947]]]))

    const services = [{ id: 'vllm-id', port: 8080, status: 'running', wsl: true, name: 'vllm' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue(undefined) // not tracked by processManager

    await reconciler.tick()

    expect(mockAdoptExternal).toHaveBeenCalledWith('vllm-id', 46947, 'wsl')
    expect(mockUpdate).toHaveBeenCalledWith('vllm-id', { status: 'running', pid: 46947 })
  })

  it('marks a DB-running but absent service as stopped if no listener is on the port', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(new Map()) // empty but command succeeded

    const services = [{ id: 'dead-svc', port: 8080, status: 'running', wsl: true, name: 'dead' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith('dead-svc', { status: 'stopped', pid: null })
  })

  it('does not late-adopt when WSL snapshot failed for a wsl service (avoids false stopped)', async () => {
    mockSnapshotWindows.mockResolvedValueOnce(new Map())
    mockSnapshotWsl.mockResolvedValueOnce(null) // snapshot failed

    const services = [{ id: 'vllm-id', port: 8080, status: 'running', wsl: true, name: 'vllm' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue(undefined)

    await reconciler.tick()

    expect(mockAdoptExternal).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('passes the pre-fetched maps to verifyHealthWithMaps', async () => {
    const winMap = new Map([[8080, [5196]]])
    const wslMap = new Map<number, number[]>()
    mockSnapshotWindows.mockResolvedValue(winMap)
    mockSnapshotWsl.mockResolvedValue(wslMap)

    const services = [{ id: 'svc-1', port: 8080, status: 'running' }]
    mockFindAll.mockResolvedValue(services)
    mockGetStatus.mockReturnValue({ status: 'running' })
    mockVerifyHealthWithMaps.mockReturnValue({ healthy: true })

    await reconciler.tick()

    expect(mockVerifyHealthWithMaps).toHaveBeenCalledWith('svc-1', 8080, winMap, wslMap)
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
