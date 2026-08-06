import { execFile } from 'child_process'
import { promisify } from 'util'
import { snapshotProcessTable, buildProtectedPids, getTrackedPids } from '@/lib/util/processGuard'

const execFileAsync = promisify(execFile)

/** Same ceiling portHelper uses for OS probes — a hung nvidia-smi must never wedge a start. */
const PROBE_TIMEOUT_MS = 8000

/**
 * Headroom we always keep free on a GPU, on top of a service's own declared need.
 * A card driven to literally 0 free bytes is what hard-hangs the display driver
 * (task-1406), so admission always leaves this much slack.
 */
export const VRAM_SAFETY_MARGIN_MB = 512

export interface GpuMemory {
  index: number
  totalMb: number
  usedMb: number
  freeMb: number
}

/**
 * Parses `nvidia-smi --query-gpu=index,memory.total,memory.used,memory.free
 * --format=csv,noheader,nounits` output into per-device memory rows. Tolerates
 * blank lines and stray whitespace; skips any row that isn't fully numeric.
 * @param stdout - raw stdout from the nvidia-smi query
 */
export function parseGpuMemory(stdout: string): GpuMemory[] {
  const rows: GpuMemory[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map(p => p.trim())
    if (parts.length < 4) continue
    const [index, totalMb, usedMb, freeMb] = parts.map(Number)
    if (![index, totalMb, usedMb, freeMb].every(Number.isFinite)) continue
    rows.push({ index, totalMb, usedMb, freeMb })
  }
  return rows
}

/**
 * Parses a service's cudaDevice field into the list of GPU indices it will occupy.
 * Accepts a single index ("1") or a comma-separated mask ("0,1", as the dual-GPU
 * Big Comfy service uses). Returns an empty array when the service is not pinned.
 * @param cudaDevice - the effective cudaDevice value for the service
 */
export function parseCudaDevices(cudaDevice: string | null | undefined): number[] {
  if (cudaDevice === null || cudaDevice === undefined) return []
  return String(cudaDevice)
    .split(',')
    .map(part => part.trim())
    // Guard the empty segment explicitly: Number('') is 0, which would otherwise
    // make an unset/blank cudaDevice look like a pin to GPU 0.
    .filter(part => part.length > 0)
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0)
}

/**
 * Values that look like a device list but are really a shell variable reference
 * (`%CUDA_DEVICE%`, `$CUDA_DEVICE`, `${CUDA_DEVICE}`, `!CUDA_DEVICE!`). A command
 * that expands a variable is NOT hard-coding a device — it is deriving one from
 * what Service Manager injects, which is exactly the pattern we want to keep
 * working, so it must never be read as a literal pin.
 */
function isVariableReference(value: string): boolean {
  return /[%$!{]/.test(value)
}

/**
 * Removes whole comment lines from a start command. Our service commands carry long
 * REM-prefixed rationale blocks that quote flags in prose — ComfyUI's own comments
 * say "Keep --cuda-device 0 to match the mask" — so parsing the raw text would read
 * a pin out of a sentence rather than out of the command that runs.
 * @param command - the service's start command
 */
export function stripCommandComments(command: string): string {
  return command
    .split('\n')
    .filter(line => !/^\s*(rem\s|::|#)/i.test(line))
    .join('\n')
}

/**
 * Expands `%NAME%` references using `set NAME=VALUE` assignments made earlier in the
 * same command, so a command that pins its GPU indirectly (llama.cpp does
 * `set CUDA_STRING=cuda1` then `-dev %CUDA_STRING%`) still resolves to a real device.
 * Variables the command does not define — notably `%CUDA_DEVICE%`, which Service
 * Manager injects — are deliberately left unexpanded so they stay recognisable as
 * "this command defers to the registration".
 * @param command - the comment-stripped start command
 */
export function expandLocalBatchVars(command: string): string {
  const vars = new Map<string, string>()
  for (const match of command.matchAll(/^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)$/gim)) {
    vars.set(match[1].toUpperCase(), match[2].trim())
  }
  if (vars.size === 0) return command

  let expanded = command
  // Bounded passes so a self-referential assignment can never loop forever.
  for (let pass = 0; pass < 3; pass++) {
    const next = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
      const value = vars.get(name.toUpperCase())
      return value === undefined ? whole : value
    })
    if (next === expanded) break
    expanded = next
  }
  return expanded
}

/**
 * Extracts the GPU pin a start command hard-codes for itself, or null when it
 * does not hard-code one.
 *
 * Recognises the three ways our services actually pin a card:
 *   - `CUDA_VISIBLE_DEVICES=1 cmd` / `export …` / `set …` / `$env:… = "1"`
 *   - `--cuda-device 0` (ComfyUI)
 *   - `-dev cuda1,cuda0` (llama.cpp)
 *
 * This exists because a service can silently disagree with its own `cudaDevice`
 * registration: the Unsloth trainer was registered as GPU 0 while its command ran
 * `CUDA_VISIBLE_DEVICES=1`, so the admission guard reserved and policed a card the
 * job never touched — it admitted the job when the wrong card had room, and
 * reported the wrong occupant when it did not (task-1493). The command is what the
 * process actually gets, so when it states a device literally, it is the truth.
 *
 * Returns the raw device string (e.g. "1" or "0,1") so it can be compared with and
 * substituted for a stored `cudaDevice`, or null when the command leaves the choice
 * to Service Manager.
 * @param command - the service's start command
 */
export function extractCudaDevicesFromCommand(rawCommand: string | null | undefined): string | null {
  if (!rawCommand) return null
  const command = expandLocalBatchVars(stripCommandComments(rawCommand))

  const patterns = [
    // CUDA_VISIBLE_DEVICES=1 / export CUDA_VISIBLE_DEVICES=1 / set CUDA_VISIBLE_DEVICES=1
    /CUDA_VISIBLE_DEVICES\s*=\s*"?([^\s"'\r\n]+)"?/gi,
    // PowerShell: $env:CUDA_VISIBLE_DEVICES = "1"
    /\$env:CUDA_VISIBLE_DEVICES\s*=\s*"?([^\s"'\r\n]+)"?/gi,
    // ComfyUI: --cuda-device 0
    /--cuda-device[\s=]+"?([^\s"'\r\n]+)"?/gi,
  ]

  // Later assignments win — the last one to run is what the process launches with.
  let found: string | null = null
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (!value || isVariableReference(value)) continue
      if (parseCudaDevices(value).length === 0) continue
      found = value
    }
  }
  if (found) return found

  // llama.cpp: -dev cuda1 / --device CUDA0,CUDA1
  for (const match of command.matchAll(/(?:^|\s)(?:-dev|--device)\s+"?((?:cuda\d+)(?:\s*,\s*cuda\d+)*)"?/gi)) {
    const indices = [...match[1].matchAll(/cuda(\d+)/gi)].map(m => m[1])
    if (indices.length > 0) found = indices.join(',')
  }
  return found
}

/**
 * Returns the GPU indices a service will actually occupy: the pin its own command
 * hard-codes when it has one, else the registered/profile `cudaDevice`. Callers use
 * this instead of the stored field so the guard can never police a different card
 * from the one the process is masked to.
 * @param cudaDevice - the stored (profile-merged) cudaDevice for the service
 * @param command - the service's start command
 */
export function resolveGuardedCudaDevice(cudaDevice: string | null | undefined, command: string | null | undefined): string | null {
  return extractCudaDevicesFromCommand(command) ?? (cudaDevice ?? null)
}

/**
 * Compares a stored cudaDevice against the pin its command hard-codes and returns a
 * human-readable warning when they disagree, else null. Surfaced in the service's own
 * output so a misregistration is visible instead of silently guarding the wrong card.
 * @param cudaDevice - the stored (profile-merged) cudaDevice
 * @param command - the service's start command
 */
export function describeCudaDeviceConflict(cudaDevice: string | null | undefined, command: string | null | undefined): string | null {
  const commandPin = extractCudaDevicesFromCommand(command)
  if (!commandPin) return null
  const stored = (cudaDevice ?? '').trim()
  if (!stored) return null
  const same =
    parseCudaDevices(stored).join(',') === parseCudaDevices(commandPin).join(',')
  if (same) return null
  return (
    `cudaDevice is registered as "${stored}" but the start command pins GPU "${commandPin}". ` +
    `The command wins — VRAM admission and occupancy are being checked against GPU ${commandPin}.`
  )
}

/**
 * Reads current per-GPU memory from nvidia-smi. Returns null when nvidia-smi is
 * missing or fails, so callers fail OPEN — a machine with no NVIDIA tooling must
 * still be able to start its services.
 */
export async function queryGpuMemory(): Promise<GpuMemory[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: PROBE_TIMEOUT_MS }
    )
    const rows = parseGpuMemory(stdout)
    return rows.length > 0 ? rows : null
  } catch (err: any) {
    console.warn('[gpuGuard] nvidia-smi probe failed, allowing start:', err?.message)
    return null
  }
}

export interface GpuComputeApp {
  /** GPU index the process has a context on, or null when the uuid could not be mapped. */
  index: number | null
  pid: number
  /** Executable name as nvidia-smi reports it, e.g. "llama-server.exe". */
  processName: string
  /**
   * Per-process VRAM in MB, or null when the driver will not report it. On Windows
   * WDDM this column is always `[N/A]`, so callers must never present a missing
   * value as "holding 0 MB" — the card-level free-memory reading is the evidence.
   */
  usedMemoryMb: number | null
}

/**
 * Parses `nvidia-smi --query-gpu=index,uuid` into a uuid to index lookup. The
 * compute-apps query reports a gpu_uuid rather than an index, and that uuid is the
 * only reliable way to say which card a process has a context on — passing
 * `-i <index>` to the compute-apps query returns every desktop process on this
 * machine, not just that card's.
 * @param stdout - raw stdout of the index/uuid query
 */
export function parseGpuUuidIndex(stdout: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(',').map(p => p.trim())
    if (parts.length < 2) continue
    const index = Number(parts[0])
    if (!Number.isInteger(index)) continue
    map.set(parts[1], index)
  }
  return map
}

/**
 * Parses `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory`
 * rows into structured entries. The process_name column is a full path on Windows so
 * only its basename is kept, and `[N/A]` memory becomes null rather than zero.
 * @param stdout - raw stdout from the compute-apps query
 * @param uuidToIndex - uuid to GPU index lookup from parseGpuUuidIndex
 */
export function parseGpuComputeApps(stdout: string, uuidToIndex: Map<string, number>): GpuComputeApp[] {
  const apps: GpuComputeApp[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map(p => p.trim())
    if (parts.length < 4) continue
    const pid = Number(parts[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const used = Number(parts[3])
    const processName = parts[2].replace(/\\/g, '/').split('/').pop() ?? parts[2]
    apps.push({
      index: uuidToIndex.get(parts[0]) ?? null,
      pid,
      processName,
      usedMemoryMb: Number.isFinite(used) ? used : null,
    })
  }
  return apps
}

/**
 * Lists the processes that currently hold a GPU context, with the card each is on.
 * Returns an empty array when nvidia-smi is unavailable so callers degrade to
 * "nothing to report" rather than throwing inside a stop path.
 */
export async function queryGpuComputeApps(): Promise<GpuComputeApp[]> {
  try {
    const [uuids, apps] = await Promise.all([
      execFileAsync('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader,nounits'], { timeout: PROBE_TIMEOUT_MS }),
      execFileAsync(
        'nvidia-smi',
        ['--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'],
        { timeout: PROBE_TIMEOUT_MS }
      ),
    ])
    return parseGpuComputeApps(apps.stdout, parseGpuUuidIndex(uuids.stdout))
  } catch (err: any) {
    console.warn('[gpuGuard] compute-apps probe failed:', err?.message)
    return []
  }
}

/**
 * Executable names too generic to attribute to one service. A stray `python.exe`
 * holding VRAM could belong to anything on the machine, so it is only ever
 * reported, never killed.
 */
const GENERIC_EXECUTABLES = new Set([
  'python.exe', 'python3.exe', 'pythonw.exe', 'node.exe', 'cmd.exe', 'powershell.exe',
  'pwsh.exe', 'conhost.exe', 'java.exe', 'wsl.exe', 'wslhost.exe', 'bash.exe', 'sh.exe',
])

/**
 * Returns the distinct executable basenames a start command launches, lowercased.
 * Used to tell "this leftover llama-server.exe is ours" from "something else is on
 * the card", without ever needing to guess from the port alone.
 * @param command - the service's start command
 */
export function extractExecutableNames(command: string | null | undefined): string[] {
  if (!command) return []
  const names = new Set<string>()
  for (const match of command.matchAll(/([A-Za-z0-9_.-]+\.exe)/g)) {
    names.add(match[1].toLowerCase())
  }
  return [...names]
}

export interface GpuSurvivorArgs {
  /** Every process currently holding a GPU context. */
  apps: GpuComputeApp[]
  /** GPU indices the stopped service was pinned to. */
  devices: number[]
  /** The stopped service's start command, used to attribute survivors to it. */
  command: string | null | undefined
  /** PIDs that must never be killed (Service Manager, agent terminals, other services). */
  protectedPids: Map<number, string>
  /** Executable name to owning service name, for every OTHER registered service. */
  knownExecutables?: Map<string, string>
}

export interface GpuSurvivors {
  /** Leftovers of THIS service, safe to reap: named by its command and unprotected. */
  reapable: GpuComputeApp[]
  /** Other REGISTERED services' processes on the same cards — reported, never killed. */
  reportOnly: Array<GpuComputeApp & { owner: string }>
}

/**
 * Splits the processes on a stopped service's GPUs into the ones that are its own
 * leftovers (reapable) and the ones belonging to another registered service
 * (report-only).
 *
 * A survivor is only attributed to the service when its executable is named in that
 * service's own start command AND that executable is specific enough to identify
 * (never a bare `python.exe`) AND the PID is not protected. That is what makes
 * "stopping Llama.cpp Server leaves no llama-server.exe holding VRAM" safe to do
 * automatically: a 16.7 GB orphan whose wrapper is long gone still matches by name,
 * while an unrelated CUDA process on the same card is never touched (task-1493).
 *
 * Everything nvidia-smi lists that belongs to no registered service is dropped
 * entirely. On this Windows box the per-process table includes every compositing
 * desktop app — explorer, Chrome, Teams — so reporting "still on the card" for all of
 * them would bury the one line that matters.
 * @param args - the process list, the service's devices/command and the never-kill set
 */
export function classifyGpuSurvivors(args: GpuSurvivorArgs): GpuSurvivors {
  const { apps, devices, command, protectedPids, knownExecutables } = args
  const owned = new Set(
    extractExecutableNames(command).filter(name => !GENERIC_EXECUTABLES.has(name))
  )
  // A process whose card could not be resolved is still considered: dropping it
  // would silently skip the very orphan we are looking for.
  const onOurCards = apps.filter(app => app.index === null || devices.includes(app.index))

  const reapable: GpuComputeApp[] = []
  const reportOnly: Array<GpuComputeApp & { owner: string }> = []
  for (const app of onOurCards) {
    const name = app.processName.toLowerCase()
    if (owned.has(name)) {
      if (!protectedPids.has(app.pid)) reapable.push(app)
      else reportOnly.push({ ...app, owner: 'protected process' })
      continue
    }
    const owner = knownExecutables?.get(name)
    if (owner) reportOnly.push({ ...app, owner })
  }
  return { reapable, reportOnly }
}

/**
 * Builds an executable-name to service-name lookup from other services' commands, so
 * a process left on a shared card can be named ("that is ComfyUI") instead of being
 * reported as an anonymous pid or dropped as noise.
 * @param services - the other registered services (name + command)
 * @param excludeName - the service being stopped, whose own binaries are handled separately
 */
export function buildKnownExecutables(services: Array<{ name: string; command: string }>, excludeName?: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const service of services) {
    if (service.name === excludeName) continue
    for (const exe of extractExecutableNames(service.command)) {
      if (GENERIC_EXECUTABLES.has(exe)) continue
      if (!map.has(exe)) map.set(exe, service.name)
    }
  }
  return map
}

export interface GpuReapResult {
  /** Processes this service left behind that were killed. */
  reaped: GpuComputeApp[]
  /** Processes still on the service's cards that were deliberately not killed. */
  survivors: Array<GpuComputeApp & { owner: string }>
  /** One line per outcome, suitable for the service's own output. Empty when the cards are clear. */
  notes: string[]
}

/**
 * Formats one GPU process for a human reading the service's output. The memory figure
 * is omitted when the driver does not report per-process usage (always the case on
 * Windows WDDM) rather than being printed as a misleading 0 MB.
 * @param app - the compute process to describe
 */
function describeApp(app: GpuComputeApp): string {
  const where = app.index === null ? '' : ` on GPU ${app.index}`
  const held = app.usedMemoryMb === null ? '' : ` holding ${app.usedMemoryMb} MB`
  return `${app.processName} (pid ${app.pid})${held}${where}`
}

export interface ReapGpuSurvivorsArgs {
  /** GPU indices the service is pinned to. */
  devices: number[]
  /** The service's start command, used to attribute survivors to it. */
  command: string | null | undefined
  /** The service being started/stopped; its own tracked pids stay killable. */
  ownerServiceId?: string
  /** Executable to service-name lookup for the OTHER registered services. */
  knownExecutables?: Map<string, string>
}

/**
 * After a service is stopped, checks the GPUs it was pinned to for processes still
 * holding VRAM, kills the ones that are unambiguously its own leftovers, and reports
 * everything else.
 *
 * Stopping "Llama.cpp Server" used to report success while a second
 * `llama-server.exe` from an earlier start still held 30 GB on GPU 1 — invisible in
 * the service list, and only findable in `nvidia-smi -i 1`'s per-process table. The
 * next start then failed admission for a card nothing was supposed to be using
 * (task-1493). Attribution is by executable name from the service's own command, and
 * protected PIDs are never touched, so this can only ever reap the service's own
 * orphans.
 *
 * @param args - the service's devices/command/id plus the other services' executables
 */
export async function reapGpuSurvivors(args: ReapGpuSurvivorsArgs): Promise<GpuReapResult> {
  const { devices, command, ownerServiceId, knownExecutables } = args
  const empty: GpuReapResult = { reaped: [], survivors: [], notes: [] }
  if (devices.length === 0) return empty

  const apps = await queryGpuComputeApps()
  if (apps.length === 0) return empty

  const table = await snapshotProcessTable()
  const protectedPids = buildProtectedPids({
    selfPid: process.pid,
    table,
    trackedPidsByServiceId: getTrackedPids(),
    ownerServiceId,
  })

  const { reapable, reportOnly } = classifyGpuSurvivors({ apps, devices, command, protectedPids, knownExecutables })

  const reaped: GpuComputeApp[] = []
  const notes: string[] = []
  for (const app of reapable) {
    try {
      await execFileAsync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { timeout: PROBE_TIMEOUT_MS })
      reaped.push(app)
      notes.push(`Reaped leftover GPU process: ${describeApp(app)}.`)
    } catch (err: any) {
      notes.push(`WARNING: could not kill leftover ${describeApp(app)} — ${err?.message ?? 'taskkill failed'}.`)
    }
  }

  for (const app of reportOnly) {
    notes.push(`Still on this service's GPU: ${describeApp(app)} — belongs to ${app.owner}, left running.`)
  }

  // Per-process VRAM is unavailable on Windows WDDM, so the card-level reading is the
  // only honest evidence of whether the stop actually freed the memory.
  if (notes.length > 0 || reaped.length > 0) {
    const gpus = await queryGpuMemory()
    for (const index of devices) {
      const gpu = gpus?.find(g => g.index === index)
      if (gpu) notes.push(`GPU ${index} now has ${gpu.freeMb} MB free of ${gpu.totalMb} MB.`)
    }
  }

  return { reaped, survivors: reportOnly, notes }
}

export interface VramAdmissionArgs {
  /** Name of the service being started, used in the refusal message. */
  serviceName: string
  /** Effective cudaDevice for this service (profile override wins over the service row). */
  cudaDevice: string | null | undefined
  /** How much free VRAM this service needs on each GPU it is pinned to. Null = unchecked. */
  minFreeVramMb: number | null | undefined
  /** Current per-GPU memory, or null when nvidia-smi was unavailable. */
  gpus: GpuMemory[] | null
  /** Names of already-running services pinned to each GPU index, for the message. */
  occupantsByDevice: Map<number, string[]>
}

export interface VramAdmissionResult {
  allowed: boolean
  reason?: string
}

/**
 * Decides whether a service may start given the GPUs it is pinned to and how much
 * free VRAM it declares it needs.
 *
 * Fails OPEN in every ambiguous case — no cudaDevice, no declared requirement, no
 * nvidia-smi reading, or an unknown device index — because refusing to start a
 * service on incomplete information is worse than allowing it. It only ever blocks
 * on a measured shortfall.
 *
 * This exists because starting a second heavy CUDA service on a GPU another service
 * already fills does not OOM cleanly: ComfyUI is masked to one device with
 * `CUDA_VISIBLE_DEVICES` and told `--disable-dynamic-vram`, so it believes the whole
 * card is free, over-allocates, and hard-hangs the machine (task-1406).
 *
 * @param args - the service's pinning/requirement plus the current GPU readings
 */
export function checkVramAdmission(args: VramAdmissionArgs): VramAdmissionResult {
  const { serviceName, cudaDevice, minFreeVramMb, gpus, occupantsByDevice } = args

  const devices = parseCudaDevices(cudaDevice)
  if (devices.length === 0) return { allowed: true }
  if (!minFreeVramMb || minFreeVramMb <= 0) return { allowed: true }
  if (!gpus || gpus.length === 0) return { allowed: true }

  const required = minFreeVramMb + VRAM_SAFETY_MARGIN_MB

  for (const index of devices) {
    const gpu = gpus.find(g => g.index === index)
    if (!gpu) continue
    if (gpu.freeMb >= required) continue

    const occupants = occupantsByDevice.get(index) ?? []
    const heldBy = occupants.length > 0
      ? ` It is currently held by: ${occupants.join(', ')}.`
      : ''
    return {
      allowed: false,
      reason:
        `Refusing to start "${serviceName}": GPU ${index} has only ${gpu.freeMb} MB free of ` +
        `${gpu.totalMb} MB, but this service needs ${minFreeVramMb} MB ` +
        `(+${VRAM_SAFETY_MARGIN_MB} MB safety margin = ${required} MB).${heldBy} ` +
        `Stop the service holding GPU ${index}, or switch to a profile that does not run both on the same GPU.`,
    }
  }

  return { allowed: true }
}
