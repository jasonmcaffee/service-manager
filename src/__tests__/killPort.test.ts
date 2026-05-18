/**
 * killPort unit tests.
 *
 * Verifies that killPort() kills BOTH Windows and WSL processes found on a port.
 * The old implementation stopped after killing Windows processes, leaving the
 * WSL process alive and causing EADDRINUSE on the next vllm start attempt.
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

// We test the pure logic of killPort by mocking the helpers it calls.
// getWindowsPidsOnPort, getWslPidsOnPort, killWindowsPids, killWslPids are all
// internal to portHelper so we test killPort as a black-box by mocking exec/execFile.

const mockExecAsync = jest.fn(async (cmd: string): Promise<{ stdout: string; stderr: string }> => ({
  stdout: '', stderr: '',
}))

const mockExecFileAsync = jest.fn(
  async (_file: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '', stderr: '',
  })
)

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
}))

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: (fn: Function) => {
    // Map promisified exec → mockExecAsync, execFile → mockExecFileAsync
    const { exec, execFile } = require('child_process')
    if (fn === exec) return mockExecAsync
    if (fn === execFile) return mockExecFileAsync
    return jest.requireActual('util').promisify(fn)
  },
}))

// ── helpers ───────────────────────────────────────────────────────────────────

import { killPort, isPortListening, getWindowsPidsOnPort, getWslPidsOnPort } from '@/lib/util/portHelper'

/** Builds a netstat line that looks like a real LISTENING entry */
function netstatLine(localAddr: string, pid: number): string {
  return `  TCP    ${localAddr}         0.0.0.0:0              LISTENING       ${pid}`
}

/** Builds a wsl ss output line with a PID */
function ssLine(port: number, pid: number): string {
  return `LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:* users:(("some-proc",pid=${pid},fd=3))`
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('getWindowsPidsOnPort', () => {
  it('returns PIDs from netstat LISTENING lines on the given port', async () => {
    mockExecAsync.mockResolvedValue({
      stdout: [
        netstatLine('0.0.0.0:8080', 1234),
        netstatLine('127.0.0.1:8080', 5678),
      ].join('\n'),
      stderr: '',
    })
    const pids = await getWindowsPidsOnPort(8080)
    expect(pids).toContain(1234)
    expect(pids).toContain(5678)
  })

  it('returns empty array when nothing is listening on the port', async () => {
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' })
    const pids = await getWindowsPidsOnPort(9999)
    expect(pids).toEqual([])
  })

  it('returns empty array when exec throws', async () => {
    mockExecAsync.mockRejectedValue(new Error('command failed'))
    const pids = await getWindowsPidsOnPort(8080)
    expect(pids).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('getWslPidsOnPort', () => {
  it('returns WSL PIDs from ss output for the given port', async () => {
    // First call: ss -tlnp; second call: fuser (nothing extra)
    mockExecFileAsync
      .mockResolvedValueOnce({
        stdout: [ssLine(8080, 9001), ssLine(8080, 9002)].join('\n'),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fuser — nothing extra
    const pids = await getWslPidsOnPort(8080)
    expect(pids).toContain(9001)
    expect(pids).toContain(9002)
  })

  it('returns PIDs found by fuser even if ss shows nothing (non-LISTEN socket states)', async () => {
    // ss finds nothing (LISTEN state); fuser finds a process in CLOSE_WAIT
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })       // ss — nothing
      .mockResolvedValueOnce({ stdout: '42424', stderr: '' })  // fuser — PID in CLOSE_WAIT
    const pids = await getWslPidsOnPort(8080)
    expect(pids).toContain(42424)
  })

  it('returns empty array when no WSL process is on the port', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(9999, 1111), stderr: '' }) // ss — wrong port
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                  // fuser — nothing
    const pids = await getWslPidsOnPort(8080)
    expect(pids).toEqual([])
  })

  it('returns empty array when wsl is unavailable', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('wsl: command not found'))
    const pids = await getWslPidsOnPort(8080)
    expect(pids).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('isPortListening', () => {
  it('returns true when a Windows process is listening on the port', async () => {
    mockExecAsync.mockResolvedValue({ stdout: netstatLine('0.0.0.0:8080', 111), stderr: '' })
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    expect(await isPortListening(8080)).toBe(true)
  })

  it('returns true when only a WSL process is listening (no Windows process)', async () => {
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(8080, 222), stderr: '' }) // ss call
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // fuser call
    expect(await isPortListening(8080)).toBe(true)
  })

  it('returns false when nothing is listening on the port', async () => {
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    expect(await isPortListening(9999)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('killPort — kills BOTH Windows and WSL processes', () => {
  it('kills Windows PID when only a Windows process is present', async () => {
    // netstat finds a Windows PID, wsl ss finds nothing
    mockExecAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                  // deletePortProxyRulesOnPort — no rules
      .mockResolvedValueOnce({ stdout: netstatLine('0.0.0.0:8080', 5000), stderr: '' }) // getWindowsPidsOnPort
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // taskkill success
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' }) // wsl ss — nothing

    const result = await killPort(8080)

    expect(result.killed).toBe(true)
    expect(result.pids).toContain(5000)
    expect(result.wsl).toBe(false)
  })

  it('kills WSL PID when only a WSL process is present', async () => {
    // netstat finds nothing, wsl ss finds a WSL PID
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' }) // netstat + taskkill + portproxy show
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(8080, 7001), stderr: '' }) // getWslPidsOnPort — ss
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // getWslPidsOnPort — fuser
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // wsl kill -9

    const result = await killPort(8080)

    expect(result.killed).toBe(true)
    expect(result.pids).toContain(7001)
    expect(result.wsl).toBe(true)
  })

  it('kills BOTH Windows svchost AND WSL process when both are present (vllm scenario)', async () => {
    // vllm: svchost (port proxy) sits on 8080 on Windows AND vllm itself is in WSL
    const WIN_PID = 9999  // svchost
    const WSL_PID = 8888  // vllm inside WSL

    mockExecAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                    // deletePortProxyRulesOnPort — no rules
      .mockResolvedValueOnce({ stdout: netstatLine('0.0.0.0:8080', WIN_PID), stderr: '' }) // getWindowsPidsOnPort
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // taskkill WIN_PID
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(8080, WSL_PID), stderr: '' }) // getWslPidsOnPort — ss
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // getWslPidsOnPort — fuser
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // wsl kill -9 WSL_PID

    const result = await killPort(8080)

    expect(result.killed).toBe(true)
    expect(result.pids).toContain(WIN_PID)
    expect(result.pids).toContain(WSL_PID)
    expect(result.wsl).toBe(true)  // at least one WSL PID was killed
  })

  it('returns wsl=true when at least one WSL process was killed', async () => {
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(8080, 5555), stderr: '' }) // ss
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                  // fuser
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                  // wsl kill -9

    const result = await killPort(8080)

    expect(result.wsl).toBe(true)
  })

  it('returns wsl=false when only Windows processes were killed', async () => {
    mockExecAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                   // deletePortProxyRulesOnPort — no rules
      .mockResolvedValueOnce({ stdout: netstatLine('0.0.0.0:8080', 1234), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })

    const result = await killPort(8080)

    expect(result.wsl).toBe(false)
  })

  it('returns killed=false when no process is found on the port', async () => {
    mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })

    const result = await killPort(9999)

    expect(result.killed).toBe(false)
    expect(result.pids).toEqual([])
  })

  it('still kills WSL process even if Windows taskkill fails', async () => {
    const WSL_PID = 7777
    mockExecAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                  // deletePortProxyRulesOnPort — no rules
      .mockResolvedValueOnce({ stdout: netstatLine('0.0.0.0:8080', 4444), stderr: '' }) // getWindowsPids
      .mockRejectedValueOnce(new Error('taskkill: process not found'))                  // taskkill fails
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ssLine(8080, WSL_PID), stderr: '' }) // getWslPids — ss
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // getWslPids — fuser
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // wsl kill succeeds

    const result = await killPort(8080)

    // WSL process was killed even though Windows kill failed
    expect(result.pids).toContain(WSL_PID)
    expect(result.killed).toBe(true)
    expect(result.wsl).toBe(true)
  })
})
