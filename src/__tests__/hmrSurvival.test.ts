/**
 * HMR Survival Tests
 *
 * Verifies that when Next.js hot-module-reload replaces the ProcessManager
 * singleton (simulated by calling hmrCleanup() directly), spawned services
 * are NOT killed and are correctly re-adopted by the next init cycle.
 *
 * All external dependencies are mocked — no real OS processes spawned.
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockTreeKill = jest.fn((pid: number, signal: string, cb?: (err: Error | null) => void) => {
  cb?.(null)
})
jest.mock('tree-kill', () => mockTreeKill)

const mockSnapshotWindows = jest.fn(async () => new Map<number, number[]>())
const mockSnapshotWsl = jest.fn(async () => new Map<number, number[]>())
const mockIsWslProxyPid = jest.fn(async (_pid: number) => false)
const mockKillWslPids = jest.fn(async () => [] as number[])

jest.mock('@/lib/util/portHelper', () => ({
  snapshotWindowsListeners: mockSnapshotWindows,
  snapshotWslListeners: mockSnapshotWsl,
  isWslProxyPid: mockIsWslProxyPid,
  killWslPids: mockKillWslPids,
}))

const mockFindAll = jest.fn(async () => [] as any[])
const mockFindByName = jest.fn(async () => null as any)
const mockFindById = jest.fn(async () => null as any)
const mockUpdate = jest.fn(async () => ({} as any))
const mockFindByPort = jest.fn(async () => [] as any[])

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    findAll: mockFindAll,
    findById: mockFindById,
    findByName: mockFindByName,
    update: mockUpdate,
    findByPort: mockFindByPort,
  },
}))

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: jest.fn(async () => null),
    findAutoStartServices: jest.fn(async () => []),
    count: jest.fn(async () => 1),
  },
}))

jest.mock('@/lib/lifecycle', () => ({
  onShutdown: jest.fn(),
  fireAllSync: jest.fn(),
}))

jest.mock('@/lib/services/reconciler', () => ({
  reconciler: { start: jest.fn(), stop: jest.fn(), tick: jest.fn(async () => {}), setServiceStarter: jest.fn() },
}))

// ── imports ───────────────────────────────────────────────────────────────────

import { processManager } from '@/lib/process-manager'
import { logTailer, getLogFilePath } from '@/lib/util/logTailer'
import { initializeIfNeeded } from '@/lib/services/init'
import fs from 'fs'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns a fake ChildProcess-like object with a PID. */
function makeFakeChild(pid: number) {
  return { pid, exitCode: null, killed: false, on: jest.fn() } as any
}

/**
 * Simulates HMR by directly calling hmrCleanup() on the ProcessManager singleton.
 * In production Next.js does this when it detects the class module has been replaced
 * (instanceof check fails). We also reset smInitPromise so the next
 * initializeIfNeeded() call re-runs adoptRunningServices().
 */
function simulateHmr() {
  ;(processManager as any).hmrCleanup()
  ;(globalThis as any).smInitPromise = undefined
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  ;(globalThis as any).smBootStarted = undefined
  ;(globalThis as any).smInitPromise = undefined
  // Clear any process state from previous test without triggering treeKill
  ;(processManager as any).processes.clear()
  logTailer.stopAll()
})

afterEach(() => {
  logTailer.stopAll()
  ;(processManager as any).processes.clear()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('hmrCleanup — does NOT kill spawned processes', () => {
  it('does not call treeKill for any spawned process on HMR', () => {
    const fakeChild = makeFakeChild(12345)
    ;(processManager as any).processes.set('hmr-svc-a', {
      id: 'hmr-svc-a', process: fakeChild, status: 'running', pid: 12345,
    })

    simulateHmr()

    expect(mockTreeKill).not.toHaveBeenCalled()
  })

  it('clears the process map after hmrCleanup so fresh adoption can populate it', () => {
    const fakeChild = makeFakeChild(99999)
    ;(processManager as any).processes.set('hmr-svc-b', {
      id: 'hmr-svc-b', process: fakeChild, status: 'running', pid: 99999,
    })

    simulateHmr()

    // Map is empty after cleanup — fresh adoption will re-populate from port scan
    expect(processManager.getStatus('hmr-svc-b')).toBeUndefined()
  })

  it('stops all log tailers on HMR so setInterval handles do not leak', () => {
    const logFile = getLogFilePath('hmr-svc-tailer')
    fs.writeFileSync(logFile, 'some log\n')
    logTailer.start('hmr-svc-tailer', logFile, false)

    simulateHmr()

    // After stopAll the ring buffer is gone — getRecent returns []
    expect(logTailer.getRecent('hmr-svc-tailer')).toEqual([])
  })

  it('does not kill adopted (no-ChildProcess) services', () => {
    ;(processManager as any).processes.set('hmr-svc-adopted', {
      id: 'hmr-svc-adopted', process: null, status: 'running', pid: 55555, adoption: 'windows',
    })

    simulateHmr()

    expect(mockTreeKill).not.toHaveBeenCalled()
  })

  it('does not kill services that are in error state', () => {
    const fakeChild = makeFakeChild(11111)
    ;(processManager as any).processes.set('hmr-svc-err', {
      id: 'hmr-svc-err', process: fakeChild, status: 'error', pid: 11111,
    })

    simulateHmr()

    expect(mockTreeKill).not.toHaveBeenCalled()
    // map cleared by afterEach
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('smBootStarted — survives ProcessManager cleanup on HMR', () => {
  it('hasBootStarted() stays true after simulateHmr if markBootStarted was called', () => {
    processManager.markBootStarted()
    expect(processManager.hasBootStarted()).toBe(true)

    simulateHmr() // hmrCleanup does NOT touch smBootStarted

    // smBootStarted lives on globalThis, not on the instance — must survive HMR
    expect(processManager.hasBootStarted()).toBe(true)
  })

  it('hasBootStarted() returns false when smBootStarted has never been set', () => {
    expect(processManager.hasBootStarted()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('smInitPromise — reset on HMR so adoptRunningServices re-runs', () => {
  it('smInitPromise is undefined after simulateHmr so initializeIfNeeded re-runs', async () => {
    mockFindAll.mockResolvedValue([])
    await initializeIfNeeded()
    expect((globalThis as any).smInitPromise).toBeDefined()

    simulateHmr()

    expect((globalThis as any).smInitPromise).toBeUndefined()
  })

  it('calling initializeIfNeeded() after simulateHmr creates a new promise', async () => {
    mockFindAll.mockResolvedValue([])
    await initializeIfNeeded()
    const firstPromise = (globalThis as any).smInitPromise

    simulateHmr()
    await initializeIfNeeded()
    const secondPromise = (globalThis as any).smInitPromise

    expect(secondPromise).toBeDefined()
    expect(secondPromise).not.toBe(firstPromise)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Re-adoption after HMR — running services are found and adopted', () => {
  it('re-adopts a Windows service whose port is still occupied after HMR', async () => {
    const PORT = 7070
    // Use the current process PID — isRunning() probes the real OS for Windows services
    const PID = process.pid

    mockSnapshotWindows.mockResolvedValue(new Map([[PORT, [PID]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockFindAll.mockResolvedValue([
      { id: 'svc-syllogi', name: 'Syllogi', port: PORT, wsl: false, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    expect(processManager.isRunning('svc-syllogi')).toBe(true)
    expect(processManager.getStatus('svc-syllogi')?.adoption).toBe('windows')
    expect(processManager.getPid('svc-syllogi')).toBe(PID)
  })

  it('re-adopts a WSL service whose port is still occupied after HMR', async () => {
    const PORT = 8080
    const WSL_PID = 99123

    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map([[PORT, [WSL_PID]]]))
    mockFindAll.mockResolvedValue([
      { id: 'svc-vllm', name: 'vllm', port: PORT, wsl: true, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    expect(processManager.isRunning('svc-vllm')).toBe(true)
    expect(processManager.getStatus('svc-vllm')?.adoption).toBe('wsl')
    expect(processManager.getPid('svc-vllm')).toBe(WSL_PID)
  })

  it('shows log history for re-adopted service so the terminal is not blank', async () => {
    const PORT = 7070
    const PID = process.pid  // live PID needed for Windows isRunning() check
    const logFile = getLogFilePath('svc-readopt-log')

    fs.writeFileSync(logFile, 'startup line 1\nstartup line 2\nstartup line 3\n')

    mockSnapshotWindows.mockResolvedValue(new Map([[PORT, [PID]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockFindAll.mockResolvedValue([
      { id: 'svc-readopt-log', name: 'LogTest', port: PORT, wsl: false, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    // adoptExternal() calls logTailer.start(..., fromStart=true) which reads the file synchronously
    await new Promise(r => setTimeout(r, 50))

    const output = processManager.getOutput('svc-readopt-log')
    expect(output.some(l => l.includes('startup line 1'))).toBe(true)
    expect(output.some(l => l.includes('startup line 2'))).toBe(true)
    expect(output.some(l => l.includes('startup line 3'))).toBe(true)

    logTailer.stop('svc-readopt-log')
    ;(processManager as any).processes.delete('svc-readopt-log')
  })

  it('does NOT re-adopt a service whose port is free after HMR (truly stopped)', async () => {
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockFindAll.mockResolvedValue([
      { id: 'svc-dead', name: 'Dead Service', port: 9090, wsl: false, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    expect(processManager.isRunning('svc-dead')).toBe(false)
  })

  it('updates DB to status=running with PID after re-adoption', async () => {
    const PID = process.pid  // live PID so isRunning() check passes

    mockSnapshotWindows.mockResolvedValue(new Map([[5010, [PID]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockFindAll.mockResolvedValue([
      { id: 'svc-db-check', name: 'DB Check', port: 5010, wsl: false, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    expect(mockUpdate).toHaveBeenCalledWith('svc-db-check', { status: 'running', pid: PID })
  })

  it('re-adopts multiple services in the same init cycle', async () => {
    // Use WSL kind for all three — WSL adoption skips the OS PID liveness check
    // so we don't need real PIDs on the Windows side
    mockSnapshotWindows.mockResolvedValue(new Map())
    mockSnapshotWsl.mockResolvedValue(new Map([
      [7070, [3001]],
      [8091, [3002]],
      [8080, [3003]],
    ]))
    mockFindAll.mockResolvedValue([
      { id: 'svc-ma', name: 'A', port: 7070, wsl: true, noPort: false },
      { id: 'svc-mb', name: 'B', port: 8091, wsl: true, noPort: false },
      { id: 'svc-mc', name: 'C', port: 8080, wsl: true, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    expect(processManager.isRunning('svc-ma')).toBe(true)
    expect(processManager.isRunning('svc-mb')).toBe(true)
    expect(processManager.isRunning('svc-mc')).toBe(true)

    ;['svc-ma', 'svc-mb', 'svc-mc'].forEach(id => {
      logTailer.stop(id)
      ;(processManager as any).processes.delete(id)
    })
  })

  it('re-adopted service shows correct status=running (not stopped) immediately', async () => {
    const PID = process.pid  // live PID so isRunning() check passes
    mockSnapshotWindows.mockResolvedValue(new Map([[4000, [PID]]]))
    mockSnapshotWsl.mockResolvedValue(new Map())
    mockFindAll.mockResolvedValue([
      { id: 'svc-status-check', name: 'Status Check', port: 4000, wsl: false, noPort: false },
    ])

    simulateHmr()
    await initializeIfNeeded()

    const status = processManager.getStatus('svc-status-check')
    expect(status?.status).toBe('running')
    expect(status?.pid).toBe(PID)

    logTailer.stop('svc-status-check')
    ;(processManager as any).processes.delete('svc-status-check')
  })
})
