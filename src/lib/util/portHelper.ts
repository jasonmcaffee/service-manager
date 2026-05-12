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
 * Finds PIDs of WSL processes listening on the given port via ss.
 * Uses execFile to avoid cmd.exe intercepting the pipe in the bash command.
 * @param port - TCP port number to check
 */
export async function getWslPidsOnPort(port: number): Promise<number[]> {
  const { stdout } = await execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp'])
    .catch(() => ({ stdout: '' }))

  const portLines = stdout.split('\n').filter(l => l.includes(`:${port} `))
  const matches = portLines.flatMap(l => [...l.matchAll(/pid=(\d+)/g)])
  return [...new Set(matches.map(m => parseInt(m[1])))]
}

/**
 * Snapshots all Windows LISTENING ports in a single netstat call.
 * Returns a Map of port number to array of PIDs.
 */
export async function snapshotWindowsListeners(): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>()
  const { stdout } = await execAsync('netstat -ano').catch(() => ({ stdout: '' }))

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
 * Returns a Map of port number to array of WSL PIDs.
 */
export async function snapshotWslListeners(): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>()
  const { stdout } = await execFileAsync('wsl', ['-e', 'bash', '-c', 'ss -tlnp 2>/dev/null'])
    .catch(() => ({ stdout: '' }))

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
 * Kills ALL processes (Windows and WSL) listening on the given port.
 * Both are killed in parallel — necessary for WSL services where a Windows
 * svchost port-proxy sits on the same port as the actual WSL process.
 * Killing only the svchost left vllm running and caused EADDRINUSE on restart.
 * @param port - TCP port number to kill
 */
export async function killPort(port: number): Promise<{ killed: boolean; pids: number[]; wsl: boolean }> {
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
 * Returns true if any process (Windows or WSL) is listening on the given port.
 * @param port - TCP port number to check
 */
export async function isPortListening(port: number): Promise<boolean> {
  const windowsPids = await getWindowsPidsOnPort(port)
  if (windowsPids.length > 0) return true
  const wslPids = await getWslPidsOnPort(port)
  return wslPids.length > 0
}
