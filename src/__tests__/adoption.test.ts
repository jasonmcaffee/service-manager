/**
 * Adoption integration tests.
 *
 * Tests the real OS snapshot helpers using a real Node http server for the
 * Windows listener tests. No real processes are spawned via processManager.
 *
 * WSL tests are skipped automatically if WSL is unavailable on the host.
 */

import http from 'http'
import net from 'net'
import { processManager } from '@/lib/process-manager'
import { snapshotWindowsListeners, snapshotWslListeners } from '@/lib/util/portHelper'
import { logTailer, getLogFilePath } from '@/lib/util/logTailer'
import fs from 'fs'

// ── helpers ─────────────────────────────────────────────────────────────────

function startServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_, res) => res.end('ok'))
    server.listen(port, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

// ── snapshotWindowsListeners ──────────────────────────────────────────────

describe('snapshotWindowsListeners', () => {
  let server: http.Server
  let port: number

  beforeAll(async () => {
    port = await findFreePort()
    server = await startServer(port)
  })

  afterAll(async () => {
    await stopServer(server)
  })

  it('includes a port occupied by a running Node server', async () => {
    const map = await snapshotWindowsListeners()
    expect(map).not.toBeNull()
    expect(map!.has(port)).toBe(true)
    expect(map!.get(port)!.length).toBeGreaterThan(0)
  })

  it('does not include a port that is not listening', async () => {
    const freePort = await findFreePort()
    const map = await snapshotWindowsListeners()
    expect(map).not.toBeNull()
    expect(map!.has(freePort)).toBe(false)
  })
})

// ── processManager.adoptExternal ─────────────────────────────────────────

describe('processManager.adoptExternal', () => {
  const SERVICE_ID = 'adopt-test-svc'

  afterEach(() => {
    // Clean up via public API only — no direct map mutation
    logTailer.stop(SERVICE_ID)
    processManager.markUnhealthy(SERVICE_ID, 'test-cleanup')
  })

  it('marks the service as running with the given PID and kind=windows', () => {
    const livePid = process.pid
    processManager.adoptExternal(SERVICE_ID, livePid, 'windows')
    expect(processManager.isRunning(SERVICE_ID)).toBe(true)
    expect(processManager.getPid(SERVICE_ID)).toBe(livePid)
    expect(processManager.getStatus(SERVICE_ID)?.adoption).toBe('windows')
  })

  it('does NOT write an adoption marker to the log file (avoids duplicate entries on HMR cycles)', () => {
    const logFile = getLogFilePath(SERVICE_ID)
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

    processManager.adoptExternal(SERVICE_ID, 12345, 'windows')

    // No marker written — log stays clean across re-adoptions
    expect(fs.existsSync(logFile)).toBe(false)
  })

  it('shows recent log history after adoption so terminal is not blank', () => {
    const logFile = getLogFilePath(SERVICE_ID)
    fs.writeFileSync(logFile, 'historical line 1\nhistorical line 2\n')

    processManager.adoptExternal(SERVICE_ID, 55555, 'windows')

    const output = processManager.getOutput(SERVICE_ID)
    expect(output.some(l => l.includes('historical line 1'))).toBe(true)
  })

  it('streams new lines written after adoption', async () => {
    const logFile = getLogFilePath(SERVICE_ID)
    fs.writeFileSync(logFile, '')

    processManager.adoptExternal(SERVICE_ID, 77777, 'windows')

    await new Promise(r => setTimeout(r, 100))
    fs.appendFileSync(logFile, 'new line after adoption\n')

    await new Promise(r => setTimeout(r, 400))

    const output = processManager.getOutput(SERVICE_ID)
    expect(output.some(l => l.includes('new line after adoption'))).toBe(true)
  })
})

// ── verifyHealthWithMaps ────────────────────────────────────────────────────

describe('processManager.verifyHealthWithMaps', () => {
  const SERVICE_ID = 'health-test-svc'

  afterEach(() => {
    logTailer.stop(SERVICE_ID)
    processManager.markUnhealthy(SERVICE_ID, 'test-cleanup')
  })

  it('returns healthy=true when PID is alive and port is in the map', () => {
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')
    const winMap = new Map([[9999, [process.pid]]])
    const result = processManager.verifyHealthWithMaps(SERVICE_ID, 9999, winMap, new Map())
    expect(result.healthy).toBe(true)
  })

  it('returns port-not-bound when no PID is on the configured port', () => {
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')
    // Empty map — nothing on port 9999
    const result = processManager.verifyHealthWithMaps(SERVICE_ID, 9999, new Map(), new Map())
    expect(result.healthy).toBe(false)
    expect(result.reason).toBe('port-not-bound')
  })

  it('returns port-taken-by-other-pid when a different PID owns the port', () => {
    // Use a live PID so pid-dead check passes; then verify port is bound by someone else
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')
    const winMap = new Map([[9999, [99999]]])  // 99999 ≠ process.pid
    const result = processManager.verifyHealthWithMaps(SERVICE_ID, 9999, winMap, new Map())
    expect(result.healthy).toBe(false)
    expect(result.reason).toBe('port-taken-by-other-pid')
  })

  it('returns healthy=true when port is null (no port check needed)', () => {
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')
    const result = processManager.verifyHealthWithMaps(SERVICE_ID, null, new Map(), new Map())
    expect(result.healthy).toBe(true)
  })
})

// ── adoptNoPort ──────────────────────────────────────────────────────────────

describe('processManager.adoptNoPort', () => {
  const SERVICE_ID = 'noport-adopt-svc'

  afterEach(() => {
    logTailer.stop(SERVICE_ID)
    processManager.markUnhealthy(SERVICE_ID, 'test-cleanup')
  })

  it('marks service as running without a PID', () => {
    processManager.adoptNoPort(SERVICE_ID)
    expect(processManager.isRunning(SERVICE_ID)).toBe(true)
    expect(processManager.getPid(SERVICE_ID)).toBeUndefined()
  })

  it('does NOT write an adoption marker to the log file (avoids duplicate entries on HMR cycles)', () => {
    const logFile = getLogFilePath(SERVICE_ID)
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

    processManager.adoptNoPort(SERVICE_ID)

    // No marker written — log stays clean across re-adoptions
    expect(fs.existsSync(logFile)).toBe(false)
  })

  it('shows recent log history after noPort adoption', () => {
    const logFile = getLogFilePath(SERVICE_ID)
    fs.writeFileSync(logFile, 'noport line 1\nnoport line 2\n')

    processManager.adoptNoPort(SERVICE_ID)

    const output = processManager.getOutput(SERVICE_ID)
    expect(output.some(l => l.includes('noport line 1'))).toBe(true)
  })
})

// ── adoptExternal — previously-spawned service ───────────────────────────────

describe('adoptExternal after re-adoption (HMR simulation)', () => {
  const SERVICE_ID = 're-adopt-svc'

  afterEach(() => {
    logTailer.stop(SERVICE_ID)
    processManager.markUnhealthy(SERVICE_ID, 'test-cleanup')
  })

  it('shows log file content from the previous run after re-adoption', () => {
    const logFile = getLogFilePath(SERVICE_ID)
    fs.writeFileSync(logFile, 'prev run line A\nprev run line B\n')

    // Simulates the case where a spawned service survived HMR (log file has content)
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')

    const output = processManager.getOutput(SERVICE_ID)
    expect(output.some(l => l.includes('prev run line A'))).toBe(true)
    expect(output.some(l => l.includes('prev run line B'))).toBe(true)
  })

  it('re-adoption after markUnhealthy shows fresh log content', async () => {
    const logFile = getLogFilePath(SERVICE_ID)
    fs.writeFileSync(logFile, 'first run\n')

    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')
    processManager.markUnhealthy(SERVICE_ID, 'test-interim')
    logTailer.stop(SERVICE_ID)

    // Write new content (simulates service restarting)
    fs.writeFileSync(logFile, 'second run after restart\n')
    processManager.adoptExternal(SERVICE_ID, process.pid, 'windows')

    await new Promise(r => setTimeout(r, 50))
    const output = processManager.getOutput(SERVICE_ID)
    expect(output.some(l => l.includes('second run after restart'))).toBe(true)
  })
})

// ── snapshotWslListeners ──────────────────────────────────────────────────

describe('snapshotWslListeners', () => {
  let wslAvailable = false

  beforeAll(async () => {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
      await execFileAsync('wsl', ['--status'])
      wslAvailable = true
    } catch {
      wslAvailable = false
    }
  })

  it('returns a Map (empty or with entries) without throwing', async () => {
    if (!wslAvailable) {
      console.log('WSL not available — skipping WSL snapshot test')
      return
    }
    const map = await snapshotWslListeners()
    expect(map).toBeInstanceOf(Map)
  })
})
