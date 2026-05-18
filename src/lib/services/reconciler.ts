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
   * Single reconcile pass: snapshot OS listeners once, then verify every running service.
   * Marks unhealthy services as stopped so the UI reflects reality within one tick.
   * If a snapshot returns null (command failed), skips services whose kind depends on
   * that snapshot — a brief `wsl` or `netstat` hiccup must NOT downgrade a healthy
   * adopted service to stopped.
   */
  async tick(): Promise<void> {
    try {
      const [winMap, wslMap] = await Promise.all([
        snapshotWindowsListeners(),
        snapshotWslListeners(),
      ])

      const services = await serviceRepository.findAll()

      for (const svc of services) {
        const mem = processManager.getStatus(svc.id)

        // Case 1: DB says running but processManager has nothing — adoption never
        // succeeded for this service. Try to adopt it now using fresh snapshots
        // so a transient `wsl` failure at boot doesn't leave the service permanently
        // stranded as "stopped" in the UI.
        if (!mem && svc.status === 'running' && svc.port) {
          await this.tryLateAdopt(svc, winMap, wslMap)
          continue
        }

        // Case 2: nothing to verify.
        if (!mem || mem.status !== 'running') continue

        // Case 3: snapshot for this service's kind failed — skip this tick.
        const adoption = mem.adoption
        if (adoption === 'wsl' && wslMap === null) continue
        if (adoption !== 'wsl' && winMap === null) continue

        const result = processManager.verifyHealthWithMaps(
          svc.id,
          svc.port ?? null,
          winMap ?? new Map(),
          wslMap ?? new Map(),
        )
        if (!result.healthy) {
          processManager.markUnhealthy(svc.id, result.reason ?? 'unknown')
          await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
        }
      }
    } catch (err) {
      console.error('[reconciler] tick error:', err)
    }
  }

  /**
   * Attempts a late adoption for a service that DB says is running but is
   * absent from processManager (e.g. boot-time `wsl ss` failed). If the port
   * has a listener of the right kind we adopt; if both snapshots are fine yet
   * the port is empty, the service is genuinely gone — mark stopped.
   * @param svc - service from the DB
   * @param winMap - Windows listener snapshot (null = snapshot failed)
   * @param wslMap - WSL listener snapshot (null = snapshot failed)
   */
  async tryLateAdopt(
    svc: any,
    winMap: Map<number, number[]> | null,
    wslMap: Map<number, number[]> | null,
  ): Promise<void> {
    const port = svc.port as number
    const isWsl = !!svc.wsl

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
      console.log(`[reconciler] late-adopting "${svc.name}" pid=${candidate.pid} kind=${candidate.kind}`)
      processManager.adoptExternal(svc.id, candidate.pid, candidate.kind)
      await serviceRepository.update(svc.id, { status: 'running', pid: candidate.pid })
    } else {
      console.log(`[reconciler] "${svc.name}" not found on port ${port} — marking stopped`)
      await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
    }
  }
}

export const reconciler = Reconciler.getInstance()
