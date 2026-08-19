import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { appendServiceNote } from '@/lib/util/logTailer'

/**
 * Brings back a service whose process has died while the box still wants it running.
 *
 * Before this existed, `startOnBoot` fired exactly once — when Service Manager itself
 * booted — and the reconciler was deliberately observe-only, so a service that died at
 * any other time stayed dead until a person happened to notice. For a public website
 * that meant the domain was down until someone visited it (task-1593: jasonmcaffee.com
 * and media.jasonmcaffee.com were both down for ~12 hours with nothing reporting it).
 *
 * The supervisor only ever acts on a service that is BOTH opted in (`autoRestart` on the
 * active profile's override row) and wanted up (`desiredStatus === 'running'`), so a
 * deliberate stop — the Stop button, a profile switch, a deploy's stop/start — is never
 * fought. Every attempt is written into the service's own log, and repeated failures back
 * off so a service that cannot start is retried patiently rather than hammered.
 */

/** Delay before each successive attempt. The last value repeats forever after that. */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]

/** A service seen listening for at least this long is healthy again; clear its backoff. */
const STABLE_RESET_MS = 120_000

interface RestartState {
  attempts: number
  nextAttemptAt: number
  /** When the service was first observed running since the last attempt. */
  healthySince: number | null
  /** True while an attempt is in flight, so one tick cannot overlap the next. */
  inFlight: boolean
}

const globalForSupervisor = globalThis as unknown as {
  autoRestartState: Map<string, RestartState> | undefined
}

function stateFor(serviceId: string): RestartState {
  if (!globalForSupervisor.autoRestartState) globalForSupervisor.autoRestartState = new Map()
  let state = globalForSupervisor.autoRestartState.get(serviceId)
  if (!state) {
    state = { attempts: 0, nextAttemptAt: 0, healthySince: null, inFlight: false }
    globalForSupervisor.autoRestartState.set(serviceId, state)
  }
  return state
}

/** Delay to wait before attempt number `attempts` (0-based). */
function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
}

/**
 * Builds the set of service ids the active profile has opted into auto-restart.
 * A service with no override row, or no active profile at all, is not opted in.
 */
export async function loadAutoRestartServiceIds(): Promise<Set<string>> {
  const active = await runProfileRepository.findActive()
  if (!active) return new Set()
  const entries = await runProfileRepository.findAutoRestartServices(active.id)
  return new Set(entries.map((e: any) => e.serviceId))
}

/**
 * Called by the reconciler for every service it just observed as RUNNING. Clears the
 * backoff once the service has stayed up long enough to count as recovered, and records
 * that the box's intent for it is "running" so a later death is treated as a failure
 * rather than as something somebody turned off.
 * @param serviceId - the service observed listening
 * @param persistedDesiredStatus - desiredStatus currently stored on the row
 */
export async function noteServiceRunning(serviceId: string, persistedDesiredStatus: string): Promise<void> {
  const state = stateFor(serviceId)
  if (state.healthySince === null) state.healthySince = Date.now()

  if (state.attempts > 0 && Date.now() - state.healthySince >= STABLE_RESET_MS) {
    appendServiceNote(serviceId, `Auto-restart: recovered — stable for ${Math.round(STABLE_RESET_MS / 1000)}s, retry counter reset.`)
    state.attempts = 0
    state.nextAttemptAt = 0
  }

  if (persistedDesiredStatus !== 'running') {
    await serviceRepository.setDesiredStatus(serviceId, 'running')
  }
}

/**
 * Called by the reconciler for every service it just observed as NOT running. Decides
 * whether this is a death worth reversing and, if so, starts the service again.
 *
 * Deliberately takes the start function as a parameter: the supervisor lives below
 * serviceService in the layering, and importing it directly would be a cycle.
 * @param svc - the service row, including desiredStatus
 * @param optedIn - whether the active profile has auto-restart on for this service
 * @param startService - performs the actual guarded start (serviceService.startService)
 */
export async function considerRestart(
  svc: any,
  optedIn: boolean,
  startService: (id: string) => Promise<unknown>,
): Promise<void> {
  const state = stateFor(svc.id)
  state.healthySince = null

  if (!optedIn) return
  if (state.inFlight) return

  // The one signal that separates "it died" from "somebody stopped it" — re-read rather
  // than trusting the row loaded at the top of the tick. A Stop issued mid-tick would
  // otherwise be judged against a snapshot taken before it, and the guarantee this
  // feature makes ("Stop keeps it stopped") has to hold on every tick, not most of them.
  const fresh = await serviceRepository.findById(svc.id)
  if ((fresh?.desiredStatus ?? svc.desiredStatus) !== 'running') {
    // Also drop any attempt scheduled before the stop landed.
    state.nextAttemptAt = 0
    return
  }

  const now = Date.now()
  if (state.nextAttemptAt === 0) {
    // First tick that saw it down — schedule the first attempt rather than firing
    // instantly, so a service mid-restart isn't started underneath itself.
    state.nextAttemptAt = now + backoffFor(0)
    appendServiceNote(svc.id, `Auto-restart: service is down but should be running — first attempt in ${Math.round(backoffFor(0) / 1000)}s.`)
    return
  }
  if (now < state.nextAttemptAt) return

  state.inFlight = true
  state.attempts += 1
  const attempt = state.attempts
  try {
    appendServiceNote(svc.id, `Auto-restart: attempt ${attempt} — starting "${svc.name}".`)
    console.log(`[auto-restart] attempt ${attempt} for "${svc.name}"`)
    await startService(svc.id)
    appendServiceNote(svc.id, `Auto-restart: attempt ${attempt} issued; waiting for port ${svc.port ?? '(none)'} to bind.`)
    // Give the service room to bind before the next tick judges it, and schedule the
    // following attempt at the backed-off delay in case this start does not take.
    state.nextAttemptAt = Date.now() + backoffFor(attempt)
  } catch (err: any) {
    const wait = backoffFor(attempt)
    state.nextAttemptAt = Date.now() + wait
    appendServiceNote(svc.id, `Auto-restart: attempt ${attempt} FAILED — ${err?.message ?? err}. Next attempt in ${Math.round(wait / 1000)}s.`)
    console.error(`[auto-restart] "${svc.name}" attempt ${attempt} failed:`, err?.message ?? err)
  } finally {
    state.inFlight = false
  }
}

/** Test/diagnostic hook: forget all backoff state. */
export function resetAutoRestartState(): void {
  globalForSupervisor.autoRestartState = new Map()
}
