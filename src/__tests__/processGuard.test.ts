/**
 * processGuard unit tests (task-609).
 *
 * These cover the two primitives that stop Service Manager from killing processes
 * it does not own:
 *   1. exact NUMERIC port matching when resolving "who is on port P"
 *   2. the never-kill (protected PID) set
 *
 * The netstat fixture is real output captured from the dev machine while the bug
 * was live: `findstr ":80"` matched ports 80, 8081, 8083, 8091, 8092 and 8093, and
 * every one of those PIDs was force-tree-killed — including the Claude Terminal
 * Daemon on 8092 (pid 596), which killed the agent session.
 */

import {
  parseNetstatListeners, parseProcessTable, ancestorsOf, buildProtectedPids,
  partitionKillablePids, commandLineTargetsDir, isProtectedServiceName,
  ProcessTable,
} from '@/lib/util/processGuard'

// Captured verbatim from `netstat -ano` on the dev machine (task-609 repro).
const NETSTAT_FIXTURE = [
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       54740',
  '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       49456',
  '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       44780',
  '  TCP    0.0.0.0:8083           0.0.0.0:0              LISTENING       24068',
  '  TCP    0.0.0.0:8091           0.0.0.0:0              LISTENING       53028',
  '  TCP    127.0.0.1:8092         0.0.0.0:0              LISTENING       596',
  '  TCP    127.0.0.1:8093         0.0.0.0:0              LISTENING       41048',
  '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       11111',
  '  TCP    0.0.0.0:30009          0.0.0.0:0              LISTENING       11112',
  '  TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       31544',
  '  TCP    0.0.0.0:40001          0.0.0.0:0              LISTENING       22222',
  '  TCP    [::]:80                [::]:0                 LISTENING       54740',
  '  TCP    [::]:8091              [::]:0                 LISTENING       53028',
  '  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       9999',
  '  TCP    10.0.0.5:139           0.0.0.0:0              LISTENING       4',
  '  UDP    0.0.0.0:80             *:*                                    77777',
].join('\r\n')

function makeTable(rows: Array<{ pid: number; ppid: number; cmd: string }>): ProcessTable {
  const table: ProcessTable = { ppidByPid: new Map(), commandLineByPid: new Map() }
  for (const r of rows) {
    table.ppidByPid.set(r.pid, r.ppid)
    table.commandLineByPid.set(r.pid, r.cmd)
  }
  return table
}

// ─────────────────────────────────────────────────────────────────────────────
describe('parseNetstatListeners — exact numeric port matching', () => {
  const map = parseNetstatListeners(NETSTAT_FIXTURE)

  it('resolves port 80 to ONLY the port-80 PID', () => {
    expect(map.get(80)).toEqual([54740])
  })

  it('never returns 8080-range PIDs for port 80 (the terminal-killer regression)', () => {
    const pids = map.get(80) ?? []
    for (const bystander of [44780, 24068, 53028, 596, 41048]) {
      expect(pids).not.toContain(bystander)
    }
  })

  it('does not match :3000 against :30000 or :30009', () => {
    expect(map.get(3000)).toEqual([49456])
    expect(map.get(3000)).not.toContain(11111)
    expect(map.get(3000)).not.toContain(11112)
  })

  it('does not match :4000 (service manager itself) against :40001', () => {
    expect(map.get(4000)).toEqual([31544])
  })

  it('keeps the claude terminal daemon addressable on its own port only', () => {
    expect(map.get(8092)).toEqual([596])
  })

  it('collapses IPv4 + IPv6 rows for the same port/pid into one entry', () => {
    expect(map.get(8091)).toEqual([53028])
  })

  it('ignores non-LISTENING rows (UDP has no state column)', () => {
    expect(map.get(80)).not.toContain(77777)
  })

  it('returns undefined for a port nobody is listening on', () => {
    expect(map.get(65000)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('parseProcessTable', () => {
  it('parses an array of CIM rows into pid/ppid/commandLine maps', () => {
    const table = parseProcessTable(JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, Name: 'a.exe', CommandLine: 'a.exe --x' },
      { ProcessId: 11, ParentProcessId: 10, Name: 'b.exe', CommandLine: 'b.exe' },
    ]))
    expect(table.ppidByPid.get(11)).toBe(10)
    expect(table.commandLineByPid.get(10)).toBe('a.exe --x')
  })

  it('tolerates PowerShell emitting a single object instead of an array', () => {
    const table = parseProcessTable(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'x.exe', CommandLine: '' }))
    // Falls back to the image name when CommandLine is empty (common for system procs)
    expect(table.commandLineByPid.get(7)).toBe('x.exe')
  })

  it('returns empty maps for unparseable output rather than throwing', () => {
    expect(parseProcessTable('not json').ppidByPid.size).toBe(0)
    expect(parseProcessTable('').commandLineByPid.size).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('ancestorsOf', () => {
  const ppids = new Map([[100, 50], [50, 20], [20, 0]])

  it('returns the chain starting with the pid itself', () => {
    expect(ancestorsOf(100, ppids)).toEqual([100, 50, 20])
  })

  it('does not loop forever on a cyclic parent map', () => {
    const cyclic = new Map([[1, 2], [2, 1]])
    expect(ancestorsOf(1, cyclic)).toEqual([1, 2])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('buildProtectedPids', () => {
  const table = makeTable([
    { pid: 31544, ppid: 31524, cmd: 'node C:\\jason\\dev\\service-manager\\node_modules\\.bin\\next start -p 4000' },
    { pid: 31524, ppid: 31084, cmd: 'cmd.exe /d /s /c next start -p 4000' },
    { pid: 31084, ppid: 1, cmd: 'explorer.exe' },
    { pid: 596, ppid: 43952, cmd: 'node.exe C:\\jason\\dev\\ai-service\\backend\\terminal-daemon.cjs' },
    { pid: 43952, ppid: 1, cmd: 'cmd.exe /c node terminal-daemon.cjs' },
    { pid: 54740, ppid: 1, cmd: 'node C:\\jason\\dev\\proxy\\server.js' },
    { pid: 24068, ppid: 1, cmd: 'python main.py --port 8083' },
  ])

  const protectedPids = buildProtectedPids({
    selfPid: 31544,
    table,
    trackedPidsByServiceId: new Map([['svc-comfy', [24068]], ['svc-proxy', [54740]]]),
    ownerServiceId: 'svc-proxy',
  })

  it('protects the service manager process and every ancestor', () => {
    expect(protectedPids.has(31544)).toBe(true)
    expect(protectedPids.has(31524)).toBe(true)
    expect(protectedPids.has(31084)).toBe(true)
  })

  it('protects the claude terminal daemon and its parent', () => {
    expect(protectedPids.get(596)).toContain('claude/opencode terminal daemon')
    expect(protectedPids.has(43952)).toBe(true)
  })

  it('protects PIDs tracked for a DIFFERENT service', () => {
    expect(protectedPids.get(24068)).toContain('svc-comfy')
  })

  it('leaves the owning service own PID killable', () => {
    expect(protectedPids.has(54740)).toBe(false)
  })

  it('protects system pids 0-4', () => {
    for (const pid of [0, 1, 2, 3, 4]) expect(protectedPids.has(pid)).toBe(true)
  })

  it('waives the soft protection when the terminal daemon IS the service being acted on', () => {
    const waived = buildProtectedPids({
      selfPid: 31544,
      table,
      trackedPidsByServiceId: new Map([['svc-claude-terminal', [596]]]),
      ownerServiceId: 'svc-claude-terminal',
    })
    // Explicit Stop/Restart on that service's own card must be allowed …
    expect(waived.has(596)).toBe(false)
    // … but Service Manager itself is still untouchable.
    expect(waived.has(31544)).toBe(true)
  })

  it('still protects the terminal daemon when a DIFFERENT service is being acted on', () => {
    const other = buildProtectedPids({
      selfPid: 31544,
      table,
      trackedPidsByServiceId: new Map([['svc-claude-terminal', [596]]]),
      ownerServiceId: 'svc-proxy',
    })
    expect(other.has(596)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('partitionKillablePids', () => {
  it('splits candidates into killable and blocked with reasons', () => {
    const protectedPids = new Map([[596, 'claude terminal daemon']])
    const { killable, blocked } = partitionKillablePids([54740, 596, 24068], protectedPids)
    expect(killable).toEqual([54740, 24068])
    expect(blocked).toEqual([{ pid: 596, reason: 'claude terminal daemon' }])
  })

  it('returns everything as killable when nothing is protected', () => {
    const { killable, blocked } = partitionKillablePids([1, 2], new Map())
    expect(killable).toEqual([1, 2])
    expect(blocked).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('commandLineTargetsDir', () => {
  const dir = 'C:\\jason\\dev\\ai-proxy'

  it('matches a command that actually runs out of the directory', () => {
    expect(commandLineTargetsDir('node C:\\jason\\dev\\ai-proxy\\node_modules\\.bin\\nest --watch', dir)).toBe(true)
  })

  it('matches the bare directory at end of token', () => {
    expect(commandLineTargetsDir('cmd /c cd /d "C:\\jason\\dev\\ai-proxy"', dir)).toBe(true)
  })

  it('does NOT match a sibling directory with the same prefix', () => {
    expect(commandLineTargetsDir('node C:\\jason\\dev\\ai-proxy-old\\server.js', dir)).toBe(false)
  })

  it('is case- and separator-insensitive', () => {
    expect(commandLineTargetsDir('node c:/jason/dev/ai-proxy/server.js', dir)).toBe(true)
  })

  it('returns false for an empty dir rather than matching everything', () => {
    expect(commandLineTargetsDir('anything at all', '')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('isProtectedServiceName', () => {
  it('protects the agent terminal daemons', () => {
    expect(isProtectedServiceName('Claude Terminal Daemon')).toBe(true)
    expect(isProtectedServiceName('Opencode Terminal Daemon')).toBe(true)
  })

  it('does not protect ordinary services', () => {
    expect(isProtectedServiceName('ComfyUI')).toBe(false)
    expect(isProtectedServiceName('Proxy')).toBe(false)
    expect(isProtectedServiceName(null)).toBe(false)
  })
})
