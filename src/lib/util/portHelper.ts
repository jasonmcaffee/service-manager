import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import {
  parseNetstatListeners, snapshotProcessTable, buildProtectedPids, partitionKillablePids,
  getTrackedPids, commandLineTargetsDir, ancestorsOf, ProcessTable,
} from '@/lib/util/processGuard'

export interface KillPortOptions {
  /** Service whose port is being freed — its own tracked PIDs remain killable. */
  ownerServiceId?: string
  /** PIDs Service Manager spawned for that service; only these may be tree-killed. */
  spawnedPids?: number[]
}

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// Hard ceiling for any OS-probe shell-out (netstat / wsl / tasklist). Without a
// timeout a single hung `wsl` or `tasklist` invocation (e.g. WSL cold/unresponsive)
// blocks the single-flight init Promise forever, wedging /api/services and the
// whole UI. On timeout the child is killed and the call rejects, which every
// caller already degrades gracefully (snapshot → null, process name → '').
const PROBE_TIMEOUT_MS = 8000

// `netstat -ano` on a busy machine easily exceeds exec's default 1 MB buffer.
const NETSTAT_MAX_BUFFER = 16 * 1024 * 1024

// Windows system processes used as WSL port-forwarding proxies — never the
// actual service, so we skip them during adoption to prevent false positives.
const WSL_PROXY_PROCESS_NAMES = new Set(['svchost', 'system'])

/**
 * Returns the lowercase process name for a Windows PID, or empty string if not found.
 * Used to detect WSL port-forwarding proxy processes (svchost) during adoption.
 * @param pid - Windows PID to look up
 */
export async function getWindowsProcessName(pid: number): Promise<string> {
  const { stdout } = await execAsync(
    `tasklist /fi "PID eq ${pid}" /fo csv /nh`, { timeout: PROBE_TIMEOUT_MS }
  ).catch(() => ({ stdout: '' }))
  const match = stdout.match(/"([^"]+\.exe)"/)
  return match ? match[1].replace(/\.exe$/i, '').toLowerCase() : ''
}

/**
 * Returns true if the Windows PID belongs to a known WSL port-forwarding proxy
 * (e.g. svchost via iphlpsvc). Such processes must be skipped during adoption.
 * @param pid - Windows PID to check
 */
export async function isWslProxyPid(pid: number): Promise<boolean> {
  const name = await getWindowsProcessName(pid)
  return WSL_PROXY_PROCESS_NAMES.has(name)
}

/**
 * Finds PIDs of Windows processes listening on EXACTLY the given port.
 *
 * Deliberately does not use `findstr ":<port>"` — that is a substring match, so
 * port 80 also matched 8080/8081/8091/8092 and every one of those PIDs was then
 * force-tree-killed, taking down the claude terminal daemon and unrelated
 * services (task-609). The netstat local-address column is parsed and the port
 * compared numerically instead.
 * @param port - TCP port number to check
 */
export async function getWindowsPidsOnPort(port: number): Promise<number[]> {
  const { stdout } = await execAsync(
    'netstat -ano', { timeout: PROBE_TIMEOUT_MS, maxBuffer: NETSTAT_MAX_BUFFER }
  ).catch(() => ({ stdout: '' }))

  if (!stdout.trim()) return []
  return parseNetstatListeners(stdout).get(port) ?? []
}

/**
 * Finds PIDs of WSL processes bound to the given port — checks both LISTEN-state
 * sockets (via ss) and any other state (via fuser) so TIME_WAIT / CLOSE_WAIT
 * sockets that would still block a bind() are not missed.
 * @param port - TCP port number to check
 */
export async function getWslPidsOnPort(port: number): Promise<number[]> {
  const [ssOut, fuserOut] = await Promise.all([
    execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp'], { timeout: PROBE_TIMEOUT_MS }).catch(() => ({ stdout: '' })),
    execFileAsync('wsl', ['-e', 'bash', '-c', `fuser ${port}/tcp 2>/dev/null || true`], { timeout: PROBE_TIMEOUT_MS }).catch(() => ({ stdout: '' })),
  ])

  const ssPids = ssOut.stdout.split('\n')
    .filter(l => l.includes(`:${port} `))
    .flatMap(l => [...l.matchAll(/pid=(\d+)/g)])
    .map(m => parseInt(m[1]))

  const fuserPids = fuserOut.stdout.trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0)

  return [...new Set([...ssPids, ...fuserPids])]
}

/**
 * Snapshots all Windows LISTENING ports in a single netstat call.
 * Returns a Map of port number to array of PIDs, or null if the
 * netstat command itself failed (so callers can distinguish a real
 * empty result from a snapshot failure).
 */
export async function snapshotWindowsListeners(): Promise<Map<number, number[]> | null> {
  let stdout: string
  try {
    const res = await execAsync('netstat -ano', { timeout: PROBE_TIMEOUT_MS, maxBuffer: NETSTAT_MAX_BUFFER })
    stdout = res.stdout
  } catch (err: any) {
    console.warn('[portHelper] snapshotWindowsListeners failed:', err.message)
    return null
  }

  return parseNetstatListeners(stdout)
}

/**
 * Snapshots all WSL LISTENING ports in a single `wsl ss` call.
 * Returns a Map of port number to array of WSL PIDs, or null if the
 * `wsl` command itself failed. The null return lets the reconciler
 * skip verification rather than incorrectly marking a healthy service
 * as stopped when WSL is briefly unresponsive (e.g. on cold boot).
 */
export async function snapshotWslListeners(): Promise<Map<number, number[]> | null> {
  let stdout: string
  try {
    const res = await execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp 2>/dev/null'], { timeout: PROBE_TIMEOUT_MS })
    stdout = res.stdout
  } catch (err: any) {
    console.warn('[portHelper] snapshotWslListeners failed:', err.message)
    return null
  }

  const result = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    // e.g. LISTEN 0 128 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=123,fd=3))
    const portMatch = line.match(/:(\d+)\s/)
    const pidMatches = [...line.matchAll(/pid=(\d+)/g)]
    if (!portMatch || pidMatches.length === 0) continue
    const port = parseInt(portMatch[1])
    if (isNaN(port)) continue
    const pids = pidMatches.map(m => parseInt(m[1]))
    const existing = result.get(port) ?? []
    existing.push(...pids)
    result.set(port, existing)
  }
  return result
}

/**
 * Kills the given Windows PIDs with taskkill.
 *
 * `/T` (kill the whole descendant tree) is applied ONLY to PIDs Service Manager
 * itself spawned for this service — tree-killing a foreign/adopted PID is how a
 * single over-broad match previously cascaded into unrelated process trees.
 * @param pids - Windows process IDs to kill
 * @param treePids - subset of pids that Service Manager spawned and may tree-kill
 */
async function killWindowsPids(pids: number[], treePids: Set<number> = new Set()): Promise<number[]> {
  const killed: number[] = []
  for (const pid of pids) {
    const treeFlag = treePids.has(pid) ? ' /T' : ''
    try {
      await execAsync(`taskkill /PID ${pid}${treeFlag} /F`)
      killed.push(pid)
    } catch (err: any) {
      if (!err.message?.includes('not found')) {
        console.error(`Failed to kill Windows PID ${pid}:`, err.message)
      }
    }
  }
  return killed
}

/**
 * Builds the never-kill PID map for a kill operation against the live process table.
 * Returns an empty map when the process-table probe fails, in which case only the
 * static/self-pid protections apply.
 * @param ownerServiceId - the service whose port is being freed (its own pids stay killable)
 */
async function resolveProtectedPids(ownerServiceId?: string): Promise<{ protectedPids: Map<number, string>; table: ProcessTable }> {
  const table = await snapshotProcessTable()
  const protectedPids = buildProtectedPids({
    selfPid: process.pid,
    table,
    trackedPidsByServiceId: getTrackedPids(),
    ownerServiceId,
  })
  return { protectedPids, table }
}

/**
 * Logs every PID a kill operation refused to touch, so a port that stays occupied
 * is diagnosable instead of silently failing.
 * @param context - short description of the operation for the log line
 * @param blocked - the protected PIDs with their reasons
 */
function logBlockedPids(context: string, blocked: Array<{ pid: number; reason: string }>): void {
  for (const b of blocked) {
    console.warn(`[portHelper] ${context}: refused to kill PID ${b.pid} — ${b.reason}`)
  }
}

/**
 * Kills WSL processes by PID using wsl kill -9.
 * Uses execFile to avoid cmd.exe shell interpretation issues.
 * @param pids - WSL process IDs to kill
 */
export async function killWslPids(pids: number[]): Promise<number[]> {
  const killed: number[] = []
  for (const pid of pids) {
    try {
      await execFileAsync('wsl', ['-e', 'bash', '-c', `kill -9 ${pid}`])
      killed.push(pid)
    } catch (err: any) {
      console.error(`Failed to kill WSL PID ${pid}:`, err.message)
    }
  }
  return killed
}

/**
 * Returns all netsh portproxy v4tov4 rules that listen on the given port.
 * Reading portproxy config requires no elevation; deletion does.
 * @param port - TCP port number to query
 */
export async function getPortProxyRulesOnPort(port: number): Promise<Array<{ listenAddr: string; listenPort: number; connectAddr: string; connectPort: number }>> {
  const { stdout } = await execAsync('netsh interface portproxy show all').catch(() => ({ stdout: '' }))
  const rules: Array<{ listenAddr: string; listenPort: number; connectAddr: string; connectPort: number }> = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    // columns: listenAddr listenPort connectAddr connectPort
    if (parts.length < 4) continue
    const lPort = parseInt(parts[1])
    if (isNaN(lPort) || lPort !== port) continue
    rules.push({ listenAddr: parts[0], listenPort: lPort, connectAddr: parts[2], connectPort: parseInt(parts[3]) })
  }
  return rules
}

/**
 * Returns the current WSL IP address (e.g. eth0 LAN IP).
 * In NAT mode this differs from the Windows host IP; in mirrored mode they are identical.
 */
export async function getWslIp(): Promise<string | null> {
  // In NAT mode the routable IP is on eth0; in mirrored mode it may be on eth1.
  // Try eth0 first; if it returns the same IP as Windows (mirrored), try eth1.
  const { stdout } = await execFileAsync('wsl', ['-e', 'bash', '-c',
    "ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 || " +
    "ip addr show eth1 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1"
  ]).catch(() => ({ stdout: '' }))
  const ip = stdout.trim().split('\n')[0]
  return ip || null
}

/**
 * Returns true when WSL2 is in mirrored networking mode (WSL shares the Windows
 * host IP). In mirrored mode, portproxy to the WSL IP self-loops and must NOT be
 * created; the WSL localhost relay handles access instead.
 */
async function isWslMirroredNetworking(): Promise<boolean> {
  const wslIp = await getWslIp()
  if (!wslIp) return false
  const { stdout } = await execAsync('ipconfig').catch(() => ({ stdout: '' }))
  return stdout.includes(wslIp)
}

/**
 * Attempts to delete ALL stale netsh portproxy v4tov4 rules on the given port.
 * Requires elevation — logs a remediation command if it fails with Access Denied.
 * @param port - TCP port number whose proxy rules should be removed
 */
export async function deletePortProxyRulesOnPort(port: number): Promise<void> {
  const rules = await getPortProxyRulesOnPort(port)
  for (const rule of rules) {
    console.log(`[portHelper] deleting stale portproxy ${rule.listenAddr}:${rule.listenPort} → ${rule.connectAddr}:${rule.connectPort}`)
    try {
      await execAsync(`netsh interface portproxy delete v4tov4 listenaddress=${rule.listenAddr} listenport=${rule.listenPort}`)
      console.log(`[portHelper] deleted portproxy rule for port ${port}`)
    } catch (err: any) {
      console.error(
        `[portHelper] cannot delete portproxy for port ${port} (requires admin).\n` +
        `  Run as admin: netsh interface portproxy delete v4tov4 listenaddress=${rule.listenAddr} listenport=${rule.listenPort}`,
        err.message
      )
    }
  }
}

/**
 * Ensures a WSL service is reachable from Windows on the given port.
 * In NAT mode: creates a portproxy forwarding localhost:port → WSL-IP:port.
 * In mirrored mode: portproxy self-loops (WSL shares Windows IP), so instead logs
 * the remediation steps if the WSL localhost relay hasn't created a Windows socket.
 * @param port - TCP port number the WSL service is listening on
 */
export async function ensureWslPortProxy(port: number): Promise<void> {
  // If Windows already has a listener (WSL relay socket or existing portproxy), nothing to do.
  const windowsPids = await getWindowsPidsOnPort(port)
  if (windowsPids.length > 0) {
    console.log(`[portHelper] port ${port} already accessible from Windows, no portproxy needed`)
    return
  }

  const mirrored = await isWslMirroredNetworking()
  if (mirrored) {
    // Portproxy self-loops in mirrored mode (WSL shares Windows IP). The WSL localhost
    // relay (wslhost.exe) should handle access automatically — if it doesn't, switch
    // ~/.wslconfig to networkingMode=nat so portproxy can reach WSL's separate IP.
    console.warn(
      `[portHelper] WSL service on port ${port}: mirrored networking detected, portproxy skipped.\n` +
      `  The WSL relay (wslhost.exe) should forward localhost:${port} to WSL automatically.\n` +
      `  If the service is unreachable, switch to networkingMode=nat in ~/.wslconfig.`
    )
    return
  }

  // NAT mode: create portproxy to the separate WSL IP.
  const wslIp = await getWslIp()
  if (!wslIp) {
    console.warn(`[portHelper] ensureWslPortProxy: could not determine WSL IP for port ${port}`)
    return
  }

  console.log(`[portHelper] creating portproxy 0.0.0.0:${port} → ${wslIp}:${port} (NAT mode WSL relay)`)
  try {
    await execAsync(`netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslIp} connectport=${port}`)
    console.log(`[portHelper] portproxy created for port ${port}`)
  } catch (err: any) {
    console.error(
      `[portHelper] cannot create portproxy for port ${port} (requires admin).\n` +
      `  Run as admin: netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslIp} connectport=${port}`,
      err.message
    )
  }
}

/**
 * Kills ALL processes (Windows and WSL) listening on the given port.
 * Both are killed in parallel — necessary for WSL services where a Windows
 * svchost port-proxy sits on the same port as the actual WSL process.
 * Killing only the svchost left vllm running and caused EADDRINUSE on restart.
 *
 * PIDs in the never-kill set (Service Manager and its ancestors, the claude /
 * opencode terminal daemons, and PIDs tracked for a different service) are always
 * skipped and logged — freeing a port must never take out infrastructure.
 * @param port - TCP port number to kill
 * @param opts - owning service id and the PIDs Service Manager spawned for it
 */
export async function killPort(port: number, opts: KillPortOptions = {}): Promise<{ killed: boolean; pids: number[]; wsl: boolean }> {
  await deletePortProxyRulesOnPort(port)

  const [windowsPids, wslPids, guard] = await Promise.all([
    getWindowsPidsOnPort(port),
    getWslPidsOnPort(port),
    resolveProtectedPids(opts.ownerServiceId),
  ])

  const { killable, blocked } = partitionKillablePids(windowsPids, guard.protectedPids)
  logBlockedPids(`killPort(${port})`, blocked)

  // Only PIDs Service Manager spawned for THIS service may be tree-killed.
  const treePids = new Set<number>()
  for (const spawned of opts.spawnedPids ?? []) {
    for (const pid of killable) {
      if (pid === spawned || ancestorsOf(pid, guard.table.ppidByPid).includes(spawned)) treePids.add(pid)
    }
    if (killable.includes(spawned)) treePids.add(spawned)
  }

  const [killedWindows, killedWsl] = await Promise.all([
    killable.length > 0 ? killWindowsPids(killable, treePids) : Promise.resolve([] as number[]),
    wslPids.length > 0 ? killWslPids(wslPids) : Promise.resolve([] as number[]),
  ])

  const allKilled = [...killedWindows, ...killedWsl]
  return { killed: allKilled.length > 0, pids: allKilled, wsl: killedWsl.length > 0 }
}

/**
 * Extracts the working directory from a service start command (the path after "cd" or "cd /d").
 * The `cd` token is anchored to a statement/word boundary so it cannot match the
 * letters "cd" inside another word, and only absolute paths are accepted — a bogus
 * relative fragment used as a kill filter would have an unbounded blast radius.
 * Returns null if no usable directory is found.
 * @param command - the service start command string
 */
export function extractServiceDir(command: string): string | null {
  const match = command.match(/(?:^|[\s&|(])cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s\r\n]+))/i)
  const dir = match?.[1] ?? match?.[2] ?? match?.[3] ?? null
  if (!dir) return null
  const trimmed = dir.trim()
  const isAbsolute = /^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed)
  return isAbsolute ? trimmed : null
}

/**
 * Kills all Windows node/npm/cmd processes whose command line contains both dirFragment
 * and cmdFragment. Targets zombie watch-mode processes (nest --watch, nodemon, etc.) that
 * survive stopService because they are the PARENT of the port-holding process — treeKill
 * only kills descendants, so the watcher parent stays alive and immediately restarts the app.
 * @param dir - service working directory (e.g. "C:\\jason\\dev\\ai-proxy")
 * @param cmdFragment - secondary pattern to avoid killing unrelated processes (e.g. "node_modules")
 */
export async function killMatchingProcesses(dir: string, cmdFragment: string, ownerServiceId?: string): Promise<void> {
  if (!dir) return

  const table = await snapshotProcessTable()
  if (table.commandLineByPid.size === 0) {
    console.warn('[portHelper] killMatchingProcesses: process table unavailable — killing nothing')
    return
  }

  const fragment = cmdFragment.toLowerCase()
  const candidates: number[] = []
  for (const [pid, commandLine] of table.commandLineByPid) {
    if (!commandLine.toLowerCase().includes(fragment)) continue
    if (!commandLineTargetsDir(commandLine, dir)) continue
    candidates.push(pid)
  }
  if (candidates.length === 0) return

  const protectedPids = buildProtectedPids({
    selfPid: process.pid,
    table,
    trackedPidsByServiceId: getTrackedPids(),
    ownerServiceId,
  })
  const { killable, blocked } = partitionKillablePids(candidates, protectedPids)
  logBlockedPids(`killMatchingProcesses(${dir})`, blocked)

  for (const pid of killable) {
    await execAsync(`taskkill /PID ${pid} /F`).catch((err: any) => {
      if (!err.message?.includes('not found')) {
        console.error(`[portHelper] killMatchingProcesses: failed to kill PID ${pid}:`, err.message)
      }
    })
  }
}

/**
 * Shuts down the WSL VM via `wsl --shutdown`, clearing all stale Windows-side
 * relay sockets created by iphlpsvc for mirrored-networking mode. Required when
 * taskkill cannot kill the svchost process holding the relay (Access is denied).
 * After shutdown, the next `wsl` invocation restarts the VM automatically.
 */
export async function shutdownWsl(): Promise<void> {
  console.log('[portHelper] shutting down WSL to clear stale mirrored-networking relay sockets')
  await execFileAsync('wsl', ['--shutdown']).catch((err: any) => {
    console.error('[portHelper] wsl --shutdown failed:', err.message)
  })
}

/**
 * Returns true if any process (Windows or WSL) is listening on the given port.
 * @param port - TCP port number to check
 */
export async function isPortListening(port: number): Promise<boolean> {
  const windowsPids = await getWindowsPidsOnPort(port)
  if (windowsPids.length > 0) return true
  const wslPids = await getWslPidsOnPort(port)
  return wslPids.length > 0
}
