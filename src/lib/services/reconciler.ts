import { processManager } from '@/lib/process-manager'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { snapshotWindowsListeners, snapshotWslListeners, isWslProxyPid } from '@/lib/util/portHelper'
import { onShutdown } from '@/lib/lifecycle'

const TICK_INTERVAL_MS = 10_000

const globalForReconciler = globalThis as unknown as { reconcilerInstance: Reconciler | undefined }

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

      for (const svc of services) {
        if (!svc.port) continue // noPort services use log-freshness, handled at init
        await this.reconcileFromOS(svc, winMap, wslMap)
      }
    } catch (err) {
      console.error('[reconciler] tick error:', err)
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
  ): Promise<void> {
    const port = svc.port as number
    const isWsl = !!svc.wsl
    const mem = processManager.getStatus(svc.id)

    // Spawned-child grace: the child cmd.exe may still be loading the model
    // before binding the port. Its exit event will mark the service stopped
    // when it dies — don't override that lifecycle here.
    if (mem?.process && !mem.process.killed && mem.process.exitCode === null) return

    // Skip when the snapshot we'd need is unavailable; the next tick can decide.
    if (isWsl && wslMap === null) return
    if (!isWsl && winMap === null && wslMap === null) return

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
      // Listener present — service IS running. Adopt (or re-adopt if the pid
      // changed via internal restart) so processManager + DB reflect reality.
      const memMatches = mem?.adoption && mem.pid === candidate.pid && mem.status === 'running'
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
