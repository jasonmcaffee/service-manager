/**
 * Duplicate-spawn prevention tests (task-609).
 *
 * The reconciler's adoptExternal() replaces a service's in-memory entry with the
 * adopted listener PID and `process: null`, which used to make Service Manager
 * forget the cmd.exe wrapper it had spawned. The next start then tree-killed only
 * the adopted PID and spawned a SECOND wrapper — the machine ended up with 4 live
 * wrappers for Dynamic DNS Updater and 2 for AI Service.
 *
 * These tests pin the fix: the spawned wrapper is tracked separately from the
 * ServiceProcess entry, survives adoption, and is reaped on the next start/stop.
 */

import { EventEmitter } from 'events'

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockTreeKill = jest.fn((_pid: number, _signal: string, cb?: (err: Error | null) => void) => {
  if (cb) cb(null)
})
jest.mock('tree-kill', () => mockTreeKill)

let nextPid = 50000
const spawnedChildren: any[] = []

const mockSpawn = jest.fn(() => {
  const child: any = new EventEmitter()
  child.pid = nextPid++
  child.exitCode = null
  child.killed = false
  spawnedChildren.push(child)
  return child
})

jest.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn.apply(null, args as any),
  exec: jest.fn(),
  execFile: jest.fn(),
}))

jest.mock('@/lib/util/batchWriter', () => ({
  writeStartupScript: jest.fn((id: string) => ({
    scriptFile: `C:\\tmp\\service-${id}.bat`,
    logFile: `C:\\tmp\\service-${id}.log`,
  })),
}))

jest.mock('@/lib/util/logTailer', () => ({
  getLogFilePath: (id: string) => `C:\\tmp\\service-${id}.log`,
  logTailer: { start: jest.fn(), stop: jest.fn(), stopAll: jest.fn(), getRecent: jest.fn(() => []), clearBuffer: jest.fn() },
  appendServiceNote: jest.fn(),
}))

jest.mock('@/lib/lifecycle', () => ({
  onShutdown: jest.fn(),
  fireAllSync: jest.fn(),
}))

// The real snapshot shells out to PowerShell — stub it and let each test decide
// which wrapper processes the OS is currently showing.
const mockSnapshotProcessTable = jest.fn(async () => ({
  ppidByPid: new Map<number, number>(),
  commandLineByPid: new Map<number, string>(),
}))
jest.mock('@/lib/util/processGuard', () => ({
  ...jest.requireActual('@/lib/util/processGuard'),
  snapshotProcessTable: (...args: any[]) => (mockSnapshotProcessTable as any).apply(null, args),
}))

import { processManager } from '@/lib/process-manager'

const SERVICE_ID = 'svc-dyndns'

// Every PID probed via process.kill(pid, 0) is reported alive unless listed here.
let deadPids = new Set<number>()
let killSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  spawnedChildren.length = 0
  deadPids = new Set()
  mockSnapshotProcessTable.mockResolvedValue({ ppidByPid: new Map(), commandLineByPid: new Map() })
  killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (deadPids.has(pid)) {
      const err: any = new Error('ESRCH')
      err.code = 'ESRCH'
      throw err
    }
    return true
  }) as any)
})

afterEach(() => {
  killSpy.mockRestore()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('spawned wrapper tracking survives adoption', () => {
  it('records the spawned wrapper PID so it can be tree-killed later', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const wrapperPid = spawnedChildren[0].pid

    expect(processManager.getSpawnedPids(SERVICE_ID)).toContain(wrapperPid)
  })

  it('keeps the wrapper PID after the reconciler adopts a different listener PID', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const wrapperPid = spawnedChildren[0].pid

    // Reconciler sees the real listener (a detached grandchild) and adopts it.
    processManager.adoptExternal(SERVICE_ID, 987654, 'windows')

    expect(processManager.getStatus(SERVICE_ID)!.pid).toBe(987654)
    expect(processManager.getStatus(SERVICE_ID)!.process).toBeNull()
    expect(processManager.getSpawnedPids(SERVICE_ID)).toContain(wrapperPid)
  })

  it('reports tracked PIDs per service so other services PIDs can be protected', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const tracked = processManager.getTrackedPidsByService()
    expect(tracked.get(SERVICE_ID)).toContain(spawnedChildren[0].pid)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('starting again never leaves a second wrapper behind', () => {
  it('tree-kills the orphaned wrapper before spawning a replacement', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const firstWrapper = spawnedChildren[0].pid

    // Adoption wipes the ChildProcess handle — this is what orphaned the wrapper.
    processManager.adoptExternal(SERVICE_ID, 987654, 'windows')
    deadPids.add(987654) // the adopted listener is already gone
    mockTreeKill.mockClear()

    await processManager.startService(SERVICE_ID, 'echo hi')

    expect(mockTreeKill).toHaveBeenCalledWith(firstWrapper, 'SIGKILL')
    expect(spawnedChildren).toHaveLength(2)
    expect(processManager.getSpawnedPids(SERVICE_ID)).toEqual([spawnedChildren[1].pid])
    expect(processManager.getSpawnedPids(SERVICE_ID)).not.toContain(firstWrapper)
  })

  it('does not try to kill a wrapper that already exited', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const firstWrapper = spawnedChildren[0].pid

    // The wrapper exits on its own — its exit handler clears the registry entry.
    spawnedChildren[0].exitCode = 0
    spawnedChildren[0].emit('exit', 0)
    await new Promise(r => setImmediate(r))

    expect(processManager.getSpawnedPids(SERVICE_ID)).not.toContain(firstWrapper)

    mockTreeKill.mockClear()
    await processManager.startService(SERVICE_ID, 'echo hi')
    expect(mockTreeKill).not.toHaveBeenCalledWith(firstWrapper, 'SIGKILL')
  })

  it('reaps wrappers orphaned by a PREVIOUS Service Manager process (the 4x Dynamic DNS case)', async () => {
    // Three wrappers for this service are alive on the OS but unknown to this SM
    // instance (it restarted since they were spawned).
    mockSnapshotProcessTable.mockResolvedValue({
      ppidByPid: new Map([[34176, 1], [30180, 1], [36228, 1], [99999, 1]]),
      commandLineByPid: new Map([
        [34176, `cmd.exe /c C:\\Temp\\service-manager\\service-${SERVICE_ID}.bat`],
        [30180, `cmd.exe /c C:\\Temp\\service-manager\\service-${SERVICE_ID}.bat`],
        [36228, `cmd.exe /c C:\\Temp\\service-manager\\service-${SERVICE_ID}.bat`],
        [99999, 'cmd.exe /c C:\\Temp\\service-manager\\service-some-other-service.bat'],
      ]),
    })

    await processManager.startService(SERVICE_ID, 'echo hi')

    for (const orphan of [34176, 30180, 36228]) {
      expect(mockTreeKill).toHaveBeenCalledWith(orphan, 'SIGKILL')
    }
    expect(mockTreeKill).not.toHaveBeenCalledWith(99999, 'SIGKILL')
  })

  it('reaps the wrapper when the service is stopped', async () => {
    await processManager.startService(SERVICE_ID, 'echo hi')
    const wrapperPid = spawnedChildren[0].pid
    processManager.adoptExternal(SERVICE_ID, 987654, 'windows')
    mockTreeKill.mockClear()

    await processManager.stopService(SERVICE_ID)

    expect(mockTreeKill).toHaveBeenCalledWith(wrapperPid, 'SIGKILL')
    expect(processManager.getSpawnedPids(SERVICE_ID)).toEqual([])
  })
})
