/**
 * killPort / killMatchingProcesses safety tests (task-609).
 *
 * The acceptance criterion: freeing a service's port must never kill the claude
 * terminal daemon, the Service Manager, or another service's process — and must
 * never blind tree-kill (`taskkill /T`) a process Service Manager did not spawn.
 *
 * Unlike killPort.test.ts (which drives the mocks by call ORDER), these tests
 * dispatch on the actual command so extra probe calls can be added without
 * rewriting every expectation.
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockExecAsync = jest.fn(async (_cmd: string, _opts?: any): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }))
const mockExecFileAsync = jest.fn(async (_file: string, _args: string[], _opts?: any): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }))

jest.mock('child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }))

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: (fn: Function) => {
    const { exec, execFile } = require('child_process')
    if (fn === exec) return mockExecAsync
    if (fn === execFile) return mockExecFileAsync
    return jest.requireActual('util').promisify(fn)
  },
}))

import { killPort, killMatchingProcesses, getWindowsPidsOnPort, extractServiceDir } from '@/lib/util/portHelper'
import { setTrackedPidsProvider } from '@/lib/util/processGuard'

// ── fixtures ──────────────────────────────────────────────────────────────────

const SM_PID = process.pid          // the guard protects the running process
const PROXY_PID = 54740             // the intended target on port 80
const TERMINAL_DAEMON_PID = 596     // claude terminal daemon on 8092
const COMFY_PID = 24068             // another service, on 8083
const WRAPPER_PID = 70001           // a cmd.exe wrapper SM spawned for Proxy

const NETSTAT = [
  `  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       ${PROXY_PID}`,
  `  TCP    0.0.0.0:8083           0.0.0.0:0              LISTENING       ${COMFY_PID}`,
  `  TCP    0.0.0.0:8091           0.0.0.0:0              LISTENING       53028`,
  `  TCP    127.0.0.1:8092         0.0.0.0:0              LISTENING       ${TERMINAL_DAEMON_PID}`,
  `  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       49456`,
  `  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       11111`,
  `  TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       ${SM_PID}`,
].join('\r\n')

const PROCESS_TABLE = JSON.stringify([
  { ProcessId: SM_PID, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node service-manager\\node_modules\\.bin\\next start -p 4000' },
  { ProcessId: TERMINAL_DAEMON_PID, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node.exe C:\\jason\\dev\\ai-service\\backend\\terminal-daemon.cjs' },
  { ProcessId: PROXY_PID, ParentProcessId: WRAPPER_PID, Name: 'node.exe', CommandLine: 'node C:\\jason\\dev\\proxy\\server.js' },
  { ProcessId: WRAPPER_PID, ParentProcessId: SM_PID, Name: 'cmd.exe', CommandLine: 'cmd.exe /c service-proxy.bat' },
  { ProcessId: COMFY_PID, ParentProcessId: 1, Name: 'python.exe', CommandLine: 'python main.py --port 8083' },
  { ProcessId: 90001, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\jason\\dev\\ai-proxy\\node_modules\\.bin\\nest --watch' },
  { ProcessId: 90002, ParentProcessId: 1, Name: 'claude.exe', CommandLine: 'C:\\Users\\jason\\.local\\bin\\claude.exe --cwd C:\\jason\\dev\\ai-proxy\\node_modules' },
])

/** Routes every mocked shell-out to the right canned response by command text. */
function installDispatchers(netstat = NETSTAT, processTable = PROCESS_TABLE) {
  mockExecAsync.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith('netstat')) return { stdout: netstat, stderr: '' }
    return { stdout: '', stderr: '' } // netsh portproxy show / taskkill
  })
  mockExecFileAsync.mockImplementation(async (file: string) => {
    if (file === 'powershell') return { stdout: processTable, stderr: '' }
    return { stdout: '', stderr: '' } // wsl ss / fuser / kill
  })
}

/** All taskkill commands issued during the current test. */
function taskkills(): string[] {
  return mockExecAsync.mock.calls.map(c => c[0]).filter(c => c.startsWith('taskkill'))
}

beforeEach(() => {
  jest.clearAllMocks()
  setTrackedPidsProvider(() => new Map())
  installDispatchers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('getWindowsPidsOnPort — exact port only', () => {
  it('returns only the port-80 PID, never the 80xx bystanders', async () => {
    const pids = await getWindowsPidsOnPort(80)
    expect(pids).toEqual([PROXY_PID])
    expect(pids).not.toContain(TERMINAL_DAEMON_PID)
    expect(pids).not.toContain(COMFY_PID)
  })

  it('does not match :3000 against :30000', async () => {
    expect(await getWindowsPidsOnPort(3000)).toEqual([49456])
  })

  it('never shells out to findstr (substring matching is the bug)', async () => {
    await getWindowsPidsOnPort(80)
    expect(mockExecAsync.mock.calls.some(c => String(c[0]).includes('findstr'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('killPort — never kills protected processes', () => {
  it('kills only the exact-port listener when restarting Proxy on port 80', async () => {
    const result = await killPort(80, { ownerServiceId: 'svc-proxy' })

    expect(result.pids).toEqual([PROXY_PID])
    expect(taskkills()).toHaveLength(1)
    expect(taskkills()[0]).toContain(`/PID ${PROXY_PID}`)
  })

  it('never issues a taskkill for the claude terminal daemon', async () => {
    await killPort(80, { ownerServiceId: 'svc-proxy' })
    expect(taskkills().some(c => c.includes(`/PID ${TERMINAL_DAEMON_PID}`))).toBe(false)
  })

  it('refuses to kill the service manager process itself', async () => {
    const result = await killPort(4000, { ownerServiceId: 'svc-whatever' })
    expect(result.pids).not.toContain(SM_PID)
    expect(taskkills()).toHaveLength(0)
  })

  it('refuses to kill a PID tracked for a different service', async () => {
    setTrackedPidsProvider(() => new Map([['svc-comfy', [COMFY_PID]]]))
    const result = await killPort(8083, { ownerServiceId: 'svc-something-else' })
    expect(result.killed).toBe(false)
    expect(taskkills()).toHaveLength(0)
  })

  it('still kills the PID when it belongs to the service being restarted', async () => {
    setTrackedPidsProvider(() => new Map([['svc-comfy', [COMFY_PID]]]))
    const result = await killPort(8083, { ownerServiceId: 'svc-comfy' })
    expect(result.pids).toEqual([COMFY_PID])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('killPort — tree-kill scoping', () => {
  it('does NOT pass /T for a foreign/adopted PID', async () => {
    await killPort(8083, { ownerServiceId: 'svc-comfy' })
    expect(taskkills()[0]).toBe(`taskkill /PID ${COMFY_PID} /F`)
    expect(taskkills()[0]).not.toContain('/T')
  })

  it('passes /T for a PID descended from a wrapper Service Manager spawned', async () => {
    await killPort(80, { ownerServiceId: 'svc-proxy', spawnedPids: [WRAPPER_PID] })
    expect(taskkills()[0]).toBe(`taskkill /PID ${PROXY_PID} /T /F`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('killMatchingProcesses — bounded sweep', () => {
  it('kills the watch-mode process that really runs from the service directory', async () => {
    await killMatchingProcesses('C:\\jason\\dev\\ai-proxy', 'node_modules', 'svc-ai-proxy')
    expect(taskkills().some(c => c.includes('/PID 90001'))).toBe(true)
  })

  it('does not kill a claude CLI process that merely mentions the directory', async () => {
    await killMatchingProcesses('C:\\jason\\dev\\ai-proxy', 'node_modules', 'svc-ai-proxy')
    expect(taskkills().some(c => c.includes('/PID 90002'))).toBe(false)
  })

  it('never tree-kills during the sweep', async () => {
    await killMatchingProcesses('C:\\jason\\dev\\ai-proxy', 'node_modules', 'svc-ai-proxy')
    expect(taskkills().every(c => !c.includes('/T'))).toBe(true)
  })

  it('kills nothing when the process table cannot be read', async () => {
    installDispatchers(NETSTAT, '')
    await killMatchingProcesses('C:\\jason\\dev\\ai-proxy', 'node_modules', 'svc-ai-proxy')
    expect(taskkills()).toHaveLength(0)
  })

  it('does not pipe the directory straight into a PowerShell Stop-Process sweep', async () => {
    await killMatchingProcesses('C:\\jason\\dev\\ai-proxy', 'node_modules', 'svc-ai-proxy')
    const psScripts = mockExecFileAsync.mock.calls
      .filter(c => c[0] === 'powershell')
      .map(c => Buffer.from(String(c[1][c[1].length - 1]), 'base64').toString('utf16le'))
    expect(psScripts.some(s => s.includes('Stop-Process'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('extractServiceDir — no unbounded kill filters', () => {
  it('extracts an absolute path after cd /d', () => {
    expect(extractServiceDir('cd /d C:\\jason\\dev\\ai-proxy\nnpm start')).toBe('C:\\jason\\dev\\ai-proxy')
  })

  it('extracts a quoted absolute path', () => {
    expect(extractServiceDir('cd "C:\\Program Files\\thing"\nrun.exe')).toBe('C:\\Program Files\\thing')
  })

  it('returns null for a relative path (too broad to use as a kill filter)', () => {
    expect(extractServiceDir('cd ..\\sibling\nnpm start')).toBeNull()
  })

  it('does not treat "cd" inside another word as a cd command', () => {
    expect(extractServiceDir('abcd C:\\jason\\dev\\thing')).toBeNull()
  })

  it('returns null when there is no cd at all', () => {
    expect(extractServiceDir('npm run start:dev')).toBeNull()
  })
})
