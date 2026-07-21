import fs from 'fs'
import { processManager } from '@/lib/process-manager'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { snapshotWindowsListeners, snapshotWslListeners, isWslProxyPid } from '@/lib/util/portHelper'
import { getLogFilePath } from '@/lib/util/logTailer'
import { onShutdown } from '@/lib/lifecycle'

const TICK_INTERVAL_MS = 10_000

// A noPort service has no port to probe, so log-file freshness is the only
// available liveness signal. Matches the window init uses at boot.
const LOG_FRESHNESS_MS = 30 * 60 * 1000

const globalForReconciler = globalThis as unknown as { reconcilerInstance: Reconciler | undefined }

/**
 * Orders services so active-profile autostart entries are reconciled first.
 * Ensures port/PID claims go to the intended owner when two services share a port.
 * @param services - all services from the DB
 * @param activeProfileId - active profile id (undefined = no ranking)
 */
async function rankByAutostartPriority(services: any[], activeProfileId: string | undefined): Promise<any[]> {
  if (!activeProfileId) return services
  const autoStartEntries = await runProfileRepository.findAutoStartServices(activeProfileId)
  const autostartIds = new Set(autoStartEntries.map((e: any) => e.serviceId))
  return [...services].sort((a, b) => Number(autostartIds.has(b.id)) - Number(autostartIds.has(a.id)))
}

class Reconciler {
  private interval: ReturnType<typeof setInterval> | undefined

  static getInstance(): Reconciler {
    if (!globalForReconciler.reconcilerInstance || !(globalForReconciler.reconcilerInstance instanceof Reconciler)) {
      if (globalForReconciler.reconcilerInstance) {
        try { (globalForReconciler.reconcilerInstance as any).stop?.() } catch { /* best-effort */ }
      }
      globalForReconciler.reconcilerInstance = new Reconciler()
    }
    return globalForReconciler.reconcilerInstance
  }

  /**
   * Starts the background reconcile loop. Safe to call multiple times — idempotent.
   */
  start(): void {
    if (this.interval) return
    onShutdown('reconciler', () => this.stop())
    // Run first tick immediately (async, don't block boot)
    void this.tick()
    this.interval = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
  }

  /**
   * Stops the reconcile loop.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }

  /**
   * Single reconcile pass: snapshot OS listeners once, then make backend state
   * match OS reality for every service with a port. The OS is the source of
   * truth — if a process is listening on a service's port, the service is
   * running; if no process is listening, the service is stopped. The only
   * exception is a spawned child still alive in our process map (mid-startup
   * before the port is bound), which we trust until its exit event fires.
   *
   * This is deliberately one-way: backend updates DB to match OS. The UI then
   * paints whatever the backend says. No state lives only in the frontend.
   */
  async tick(): Promise<void> {
    try {
      const [winMap, wslMap] = await Promise.all([
        snapshotWindowsListeners(),
        snapshotWslListeners(),
      ])

      const services = await serviceRepository.findAll()
      const active = await runProfileRepository.findActive()
      const ranked = await rankByAutostartPriority(services, active?.id)

      // Per-tick claim tracking: prevents two services that share a port from
      // both adopting the same PID. Autostart services rank first, so the
      // intended owner wins. Matches the logic in init's adoptRunningServices.
      const claimedPorts = new Set<number>()
      const claimedPids = new Set<string>()

      for (const svc of ranked) {
        // Per-service isolation: one service throwing (a huge log file, a locked
        // file handle, a DB hiccup) must never abort reconciliation for the rest
        // of the list — that left healthy services painted "stopped" in the UI.
        try {
          if (svc.port) {
            await this.reconcileFromOS(svc, winMap, wslMap, claimedPorts, claimedPids)
          } else {
            await this.reconcileNoPortService(svc)
          }
        } catch (err: any) {
          console.error(`[reconciler] "${svc.name}" reconcile failed (continuing):`, err?.message ?? err)
        }
      }
    } catch (err) {
      console.error('[reconciler] tick error:', err)
    }
  }

  /**
   * Reconciles a service that has no port, using log-file freshness as the
   * liveness signal. A live spawned child is trusted over the log. Never kills
   * anything — it only adopts or marks state so the UI matches reality.
   * @param svc - service row from the DB (noPort or port-less)
   */
  async reconcileNoPortService(svc: any): Promise<void> {
    const mem = processManager.getStatus(svc.id)

    // Spawned child still alive — its exit event owns the lifecycle.
    if (mem?.process && !mem.process.killed && mem.process.exitCode === null) return

    const logFile = getLogFilePath(svc.id)
    const fresh = fs.existsSync(logFile) && (Date.now() - fs.statSync(logFile).mtimeMs) <= LOG_FRESHNESS_MS

    if (fresh) {
      if (mem?.status !== 'running') {
        console.log(`[reconciler] "${svc.name}" (noPort) → running via fresh log`)
        processManager.adoptNoPort(svc.id)
      }
      if (svc.status !== 'running') {
        await serviceRepository.update(svc.id, { status: 'running', pid: null })
      }
      return
    }

    if (mem?.status === 'running') {
      processManager.markUnhealthy(svc.id, 'log-stale')
    }
    if (svc.status === 'running') {
      console.log(`[reconciler] "${svc.name}" (noPort) log stale — marking stopped`)
      await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
    }
  }

  /**
   * Forces a service's tracked state to match what the OS shows on its port.
   * Adopts (or re-adopts with a new pid) when a matching listener is found;
   * marks stopped when no listener exists; skips when the relevant snapshot
   * is unavailable so a transient command failure doesn't flap state.
   * @param svc - service row from the DB
   * @param winMap - Windows listener snapshot (null = snapshot failed)
   * @param wslMap - WSL listener snapshot (null = snapshot failed)
   */
  async reconcileFromOS(
    svc: any,
    winMap: Map<number, number[]> | null,
    wslMap: Map<number, number[]> | null,
    claimedPorts: Set<number>,
    claimedPids: Set<string>,
  ): Promise<void> {
    const port = svc.port as number
    const isWsl = !!svc.wsl
    const mem = processManager.getStatus(svc.id)

    // Spawned-child grace: the child cmd.exe may still be loading the model
    // before binding the port. Its exit event will mark the service stopped
    // when it dies — don't override that lifecycle here. Reserve the port so
    // a lower-priority service on the same port doesn't try to adopt it.
    if (mem?.process && !mem.process.killed && mem.process.exitCode === null) {
      claimedPorts.add(port)
      if (mem.pid) claimedPids.add(`${mem.adoption ?? 'windows'}:${mem.pid}`)
      return
    }

    // Skip when the snapshot we'd need is unavailable; the next tick can decide.
    if (isWsl && wslMap === null) return
    if (!isWsl && winMap === null && wslMap === null) return

    // Another service earlier in the ranked list already claimed this port —
    // typically vllm and Llama.cpp sharing 8080 with only vllm in the active
    // profile. Mark this one stopped instead of letting it adopt the same PID.
    if (claimedPorts.has(port)) {
      if (mem?.status === 'running') {
        console.log(`[reconciler] "${svc.name}" — port ${port} already claimed by another service, marking stopped`)
        processManager.markUnhealthy(svc.id, 'port-claimed-by-other-service')
      }
      if (svc.status === 'running') {
        await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
      }
      return
    }

    const rawWinPid = winMap?.get(port)?.[0]
    const wslPid = wslMap?.get(port)?.[0]
    const winPid = rawWinPid !== undefined && await isWslProxyPid(rawWinPid)
      ? undefined
      : rawWinPid

    const candidate = isWsl
      ? (wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid } : null)
      : winPid !== undefined ? { kind: 'windows' as const, pid: winPid }
        : wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid }
        : null

    if (candidate) {
      const key = `${candidate.kind}:${candidate.pid}`
      // PID-level claim: a PID can only belong to one service per tick. Prevents
      // both vllm and Llama.cpp adopting the same WSL PID when they share port.
      if (claimedPids.has(key)) {
        if (mem?.status === 'running') {
          console.log(`[reconciler] "${svc.name}" — pid ${candidate.pid} already claimed by another service, marking stopped`)
          processManager.markUnhealthy(svc.id, 'pid-claimed-by-other-service')
        }
        if (svc.status === 'running') {
          await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
        }
        return
      }

      // Listener present — service IS running. Adopt (or re-adopt if the pid
      // changed via internal restart) so processManager + DB reflect reality.
      const memMatches = mem?.adoption && mem.pid === candidate.pid && mem.status === 'running'
      claimedPorts.add(port)
      claimedPids.add(key)

      if (memMatches) return

      console.log(`[reconciler] reconciling "${svc.name}" → running pid=${candidate.pid} kind=${candidate.kind} (was ${mem?.status ?? 'untracked'})`)
      processManager.adoptExternal(svc.id, candidate.pid, candidate.kind)
      if (svc.status !== 'running' || svc.pid !== candidate.pid) {
        await serviceRepository.update(svc.id, { status: 'running', pid: candidate.pid })
      }
    } else {
      // No listener — service is NOT running on the OS. Mark it stopped unless
      // it's already in an 'error' state we'd be clobbering.
      if (mem?.status === 'running') {
        processManager.markUnhealthy(svc.id, 'port-not-bound')
      }
      if (svc.status === 'running') {
        console.log(`[reconciler] "${svc.name}" not found on port ${port} — marking stopped`)
        await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
      }
    }
  }
}

export const reconciler = Reconciler.getInstance()
