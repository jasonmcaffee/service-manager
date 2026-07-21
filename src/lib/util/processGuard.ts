import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Same ceiling used by portHelper's OS probes — a hung PowerShell must never
// wedge a service start.
const PROBE_TIMEOUT_MS = 8000

// The process table JSON can be a few hundred KB on a busy machine; the default
// 1 MB exec buffer is too tight to rely on.
const PROCESS_TABLE_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Command-line fragments identifying processes Service Manager must NEVER kill,
 * no matter what a port scan or command-line sweep turns up. These are the agent
 * terminals (killing one takes down the Claude Code session that is driving SM),
 * the Service Manager process itself, and Windows/WSL infrastructure that would
 * destabilise the machine. Matched case-insensitively as substrings.
 */
export const PROTECTED_COMMAND_PATTERNS: Array<{ pattern: string; reason: string }> = [
  { pattern: 'terminal-daemon.cjs', reason: 'claude/opencode terminal daemon' },
  { pattern: '\\claude.exe', reason: 'claude code CLI' },
  { pattern: '\\claude-skip', reason: 'claude code CLI launcher' },
  { pattern: 'opencode', reason: 'opencode agent' },
  { pattern: 'service-manager\\node_modules', reason: 'service manager itself' },
  { pattern: '\\system32\\svchost.exe', reason: 'windows service host' },
  { pattern: '\\system32\\services.exe', reason: 'windows service control manager' },
  { pattern: 'wslhost.exe', reason: 'wsl relay host' },
  { pattern: 'wslservice.exe', reason: 'wsl service' },
]

/**
 * Service names Service Manager must never stop or restart as a side effect of a
 * profile switch. These host the agent terminals that drive Service Manager — a
 * profile change must never be able to take the operator's session down.
 */
export const PROTECTED_SERVICE_NAME_PATTERNS = ['claude terminal daemon', 'opencode terminal daemon']

/**
 * Returns true when a service is infrastructure that profile switching must leave
 * alone (matched case-insensitively against PROTECTED_SERVICE_NAME_PATTERNS).
 * @param name - service name from the DB
 */
export function isProtectedServiceName(name: string | null | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return PROTECTED_SERVICE_NAME_PATTERNS.some(p => lower.includes(p))
}

export interface ProcessTableRow {
  pid: number
  ppid: number
  name: string
  commandLine: string
}

export interface ProcessTable {
  ppidByPid: Map<number, number>
  commandLineByPid: Map<number, string>
}

export const EMPTY_PROCESS_TABLE: ProcessTable = {
  ppidByPid: new Map(),
  commandLineByPid: new Map(),
}

type TrackedPidsProvider = () => Map<string, number[]>

let trackedPidsProvider: TrackedPidsProvider = () => new Map()

/**
 * Registers the callback that reports which PIDs Service Manager currently tracks
 * per service. Injected (rather than imported) so this module never depends on the
 * process manager, which itself depends on portHelper.
 * @param provider - returns a Map of serviceId to the PIDs tracked for it
 */
export function setTrackedPidsProvider(provider: TrackedPidsProvider): void {
  trackedPidsProvider = provider
}

/**
 * Returns the currently registered serviceId to PIDs map, or an empty map when
 * no provider has been registered (e.g. in unit tests).
 */
export function getTrackedPids(): Map<string, number[]> {
  try {
    return trackedPidsProvider() ?? new Map()
  } catch {
    return new Map()
  }
}

/**
 * Parses raw `netstat -ano` output into a port to PIDs map, comparing the port
 * NUMERICALLY against the local-address column. This replaces the old
 * `findstr ":<port>"` substring match, which matched :80 against :8080/:8092 and
 * caused Service Manager to force-kill unrelated processes (task-609).
 * @param stdout - raw stdout of `netstat -ano`
 */
export function parseNetstatListeners(stdout: string): Map<number, number[]> {
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
    if (!existing.includes(pid)) existing.push(pid)
    result.set(port, existing)
  }
  return result
}

/**
 * Parses the JSON emitted by the Get-CimInstance process-table probe into lookup maps.
 * Tolerates PowerShell's single-object (non-array) JSON shape.
 * @param json - raw stdout from the process-table PowerShell probe
 */
export function parseProcessTable(json: string): ProcessTable {
  const table: ProcessTable = { ppidByPid: new Map(), commandLineByPid: new Map() }
  if (!json.trim()) return table
  let rows: any
  try {
    rows = JSON.parse(json)
  } catch {
    return table
  }
  const list: any[] = Array.isArray(rows) ? rows : [rows]
  for (const row of list) {
    const pid = Number(row?.ProcessId)
    if (!Number.isFinite(pid)) continue
    const ppid = Number(row?.ParentProcessId)
    table.ppidByPid.set(pid, Number.isFinite(ppid) ? ppid : 0)
    const cmd = typeof row?.CommandLine === 'string' && row.CommandLine.length > 0
      ? row.CommandLine
      : String(row?.Name ?? '')
    table.commandLineByPid.set(pid, cmd)
  }
  return table
}

/**
 * Snapshots the Windows process table (pid, ppid, name, command line) in one
 * PowerShell call. Returns empty maps on failure so callers degrade to
 * "no extra protection information" rather than throwing.
 */
export async function snapshotProcessTable(): Promise<ProcessTable> {
  const script = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    '| ConvertTo-Json -Compress -Depth 2',
  ].join(' ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROCESS_TABLE_MAX_BUFFER }
    )
    return parseProcessTable(stdout)
  } catch (err: any) {
    console.warn('[processGuard] snapshotProcessTable failed:', err.message)
    return EMPTY_PROCESS_TABLE
  }
}

/**
 * Returns the ancestor chain for a PID, starting with the PID itself.
 * Cycle-safe and depth-bounded so a corrupt ppid map can never loop forever.
 * @param pid - the process to walk up from
 * @param ppidByPid - pid to parent-pid lookup
 */
export function ancestorsOf(pid: number, ppidByPid: Map<number, number>): number[] {
  const chain: number[] = []
  const seen = new Set<number>()
  let current = pid
  while (Number.isFinite(current) && current > 0 && !seen.has(current) && chain.length < 64) {
    chain.push(current)
    seen.add(current)
    const parent = ppidByPid.get(current)
    if (parent === undefined || parent <= 0) break
    current = parent
  }
  return chain
}

export interface BuildProtectedPidsArgs {
  selfPid: number
  table: ProcessTable
  trackedPidsByServiceId: Map<string, number[]>
  /** The service whose port is being freed — its own tracked PIDs stay killable. */
  ownerServiceId?: string
}

/**
 * Builds the never-kill set for a kill operation: the Service Manager process and
 * every one of its ancestors, every process whose command line matches a protected
 * pattern (plus that process's ancestors), and every PID currently tracked for a
 * DIFFERENT service. Values are human-readable reasons used in the refusal log.
 * @param args - self pid, process table, tracked pids and the owning service
 */
export function buildProtectedPids(args: BuildProtectedPidsArgs): Map<number, string> {
  const { selfPid, table, trackedPidsByServiceId, ownerServiceId } = args
  const protectedPids = new Map<number, string>()

  const add = (pid: number, reason: string) => {
    if (!Number.isFinite(pid) || pid <= 0) return
    if (!protectedPids.has(pid)) protectedPids.set(pid, reason)
  }

  // Hard protections can never be waived, not even for the service being acted
  // on: killing these takes down Service Manager or the OS itself.
  const hardProtected = new Set<number>([0, 1, 2, 3, 4])
  for (const pid of [0, 1, 2, 3, 4]) protectedPids.set(pid, 'system process')
  for (const pid of ancestorsOf(selfPid, table.ppidByPid)) {
    hardProtected.add(pid)
    add(pid, 'service manager process or ancestor')
  }

  for (const [pid, commandLine] of table.commandLineByPid) {
    const lower = commandLine.toLowerCase()
    const hit = PROTECTED_COMMAND_PATTERNS.find(p => lower.includes(p.pattern.toLowerCase()))
    if (!hit) continue
    for (const ancestor of ancestorsOf(pid, table.ppidByPid)) {
      add(ancestor, `${hit.reason} (pid ${pid})`)
    }
  }

  for (const [serviceId, pids] of trackedPidsByServiceId) {
    if (serviceId === ownerServiceId) continue
    for (const pid of pids) add(pid, `tracked pid of another service (${serviceId})`)
  }

  // Deliberately acting on a service waives the soft protections for ITS OWN
  // processes — otherwise Stop/Restart on the Claude Terminal Daemon card (an
  // explicit user action) would be silently refused by the pattern rule.
  for (const pid of trackedPidsByServiceId.get(ownerServiceId ?? '') ?? []) {
    if (!hardProtected.has(pid)) protectedPids.delete(pid)
  }

  return protectedPids
}

export interface ProtectedPid {
  pid: number
  reason: string
}

/**
 * Splits candidate PIDs into the ones that may be killed and the ones that are
 * protected (with the reason, so the refusal can be logged).
 * @param candidates - PIDs a port scan or command sweep produced
 * @param protectedPids - never-kill map from buildProtectedPids
 */
export function partitionKillablePids(
  candidates: number[],
  protectedPids: Map<number, string>
): { killable: number[]; blocked: ProtectedPid[] } {
  const killable: number[] = []
  const blocked: ProtectedPid[] = []
  for (const pid of candidates) {
    const reason = protectedPids.get(pid)
    if (reason) blocked.push({ pid, reason })
    else killable.push(pid)
  }
  return { killable, blocked }
}

/**
 * Returns true when the command line refers to the given directory as a real path
 * segment (dir followed by a separator, quote, or end of token) rather than an
 * arbitrary substring. Prevents `killMatchingProcesses` from matching a claude PTY
 * that merely happens to have the service directory as its cwd mention.
 * @param commandLine - full process command line
 * @param dir - the service working directory
 */
export function commandLineTargetsDir(commandLine: string, dir: string): boolean {
  if (!dir) return false
  const normalizedDir = dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  if (!normalizedDir) return false
  const normalizedCmd = commandLine.replace(/\//g, '\\').toLowerCase()
  let from = 0
  for (;;) {
    const idx = normalizedCmd.indexOf(normalizedDir, from)
    if (idx === -1) return false
    const next = normalizedCmd[idx + normalizedDir.length]
    if (next === undefined || next === '\\' || next === '"' || next === "'" || next === ' ') return true
    from = idx + 1
  }
}
