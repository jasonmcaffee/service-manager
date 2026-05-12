/**
 * Unit tests for the Reconciler background tick.
 * All dependencies are mocked — no real OS calls, no real processes.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

const mockVerifyHealthWithMaps = jest.fn(() => ({ healthy: true }))
const mockMarkUnhealthy = jest.fn()
const mockGetStatus = jest.fn(() => ({ status: 'running' }))

jest.mock('@/lib/process-manager', () => ({
  processManager: {
    getStatus: mockGetStatus,
    verifyHealthWithMaps: mockVerifyHealthWithMaps,
    markUnhealthy: mockMarkUnhealthy,
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

const mockSnapshotWindows = jest.fn(async () => new Map<number, number[]>())
const mockSnapshotWsl = jest.fn(async () => new Map<number, number[]>())

jest.mock('@/lib/util/portHelper', () => ({
  snapshotWindowsListeners: mockSnapshotWindows,
  snapshotWslListeners: mockSnapshotWsl,
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
