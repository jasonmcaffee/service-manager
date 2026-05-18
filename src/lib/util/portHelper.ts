import { exec, execFile } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

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
    `tasklist /fi "PID eq ${pid}" /fo csv /nh`
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
 * Finds PIDs of Windows processes listening on the given port via netstat.
 * @param port - TCP port number to check
 */
export async function getWindowsPidsOnPort(port: number): Promise<number[]> {
  const { stdout } = await execAsync(
    `netstat -ano | findstr ":${port}" | findstr "LISTENING"`
  ).catch(() => ({ stdout: '' }))

  if (!stdout.trim()) return []

  const pidSet = new Set<number>()
  for (const line of stdout.trim().split('\n')) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[parts.length - 1])
    if (!isNaN(pid)) pidSet.add(pid)
  }
  return Array.from(pidSet)
}

/**
 * Finds PIDs of WSL processes bound to the given port — checks both LISTEN-state
 * sockets (via ss) and any other state (via fuser) so TIME_WAIT / CLOSE_WAIT
 * sockets that would still block a bind() are not missed.
 * @param port - TCP port number to check
 */
export async function getWslPidsOnPort(port: number): Promise<number[]> {
  const [ssOut, fuserOut] = await Promise.all([
    execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp']).catch(() => ({ stdout: '' })),
    execFileAsync('wsl', ['-e', 'bash', '-c', `fuser ${port}/tcp 2>/dev/null || true`]).catch(() => ({ stdout: '' })),
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
    const res = await execAsync('netstat -ano')
    stdout = res.stdout
  } catch (err: any) {
    console.warn('[portHelper] snapshotWindowsListeners failed:', err.message)
    return null
  }

  const result = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    // parts: [Proto, LocalAddress, ForeignAddress, State, PID]
    if (parts.length < 5) continue
    const localAddr = parts[1]
    const pid = parseInt(parts[4])
    if (isNaN(pid)) continue
    const colonIdx = localAddr.lastIndexOf(':')
    if (colonIdx === -1) continue
    const port = parseInt(localAddr.slice(colonIdx + 1))
    if (isNaN(port)) continue
    const existing = result.get(port) ?? []
    existing.push(pid)
    result.set(port, existing)
  }
  return result
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
    const res = await execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp 2>/dev/null'])
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
 * Kills all Windows processes on the given port using taskkill.
 * @param pids - Windows process IDs to kill
 */
async function killWindowsPids(pids: number[]): Promise<number[]> {
  const killed: number[] = []
  for (const pid of pids) {
    try {
      await execAsync(`taskkill /PID ${pid} /T /F`)
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
 * @param port - TCP port number to kill
 */
export async function killPort(port: number): Promise<{ killed: boolean; pids: number[]; wsl: boolean }> {
  await deletePortProxyRulesOnPort(port)

  const [windowsPids, wslPids] = await Promise.all([
    getWindowsPidsOnPort(port),
    getWslPidsOnPort(port),
  ])

  const [killedWindows, killedWsl] = await Promise.all([
    windowsPids.length > 0 ? killWindowsPids(windowsPids) : Promise.resolve([] as number[]),
    wslPids.length > 0 ? killWslPids(wslPids) : Promise.resolve([] as number[]),
  ])

  const allKilled = [...killedWindows, ...killedWsl]
  return { killed: allKilled.length > 0, pids: allKilled, wsl: killedWsl.length > 0 }
}

/**
 * Extracts the working directory from a service start command (the path after "cd" or "cd /d").
 * Returns null if no cd command is found.
 * @param command - the service start command string
 */
export function extractServiceDir(command: string): string | null {
  const match = command.match(/cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s\r\n]+))/i)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

/**
 * Kills all Windows node/npm/cmd processes whose command line contains both dirFragment
 * and cmdFragment. Targets zombie watch-mode processes (nest --watch, nodemon, etc.) that
 * survive stopService because they are the PARENT of the port-holding process — treeKill
 * only kills descendants, so the watcher parent stays alive and immediately restarts the app.
 * @param dir - service working directory (e.g. "C:\\jason\\dev\\ai-proxy")
 * @param cmdFragment - secondary pattern to avoid killing unrelated processes (e.g. "node_modules")
 */
export async function killMatchingProcesses(dir: string, cmdFragment: string): Promise<void> {
  const script = [
    'Get-CimInstance Win32_Process',
    `| Where-Object { $_.CommandLine -like '*${dir}*' -and $_.CommandLine -like '*${cmdFragment}*' }`,
    '| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }',
  ].join(' ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    .catch((err: any) => console.error('[portHelper] killMatchingProcesses failed:', err.message))
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
