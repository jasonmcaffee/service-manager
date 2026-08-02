import { execFile } from 'child_process'
import { promisify } from 'util'

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
