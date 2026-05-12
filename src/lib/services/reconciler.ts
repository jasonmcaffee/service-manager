import { processManager } from '@/lib/process-manager'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { snapshotWindowsListeners, snapshotWslListeners } from '@/lib/util/portHelper'
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
        if (!mem || mem.status !== 'running') continue

        const result = processManager.verifyHealthWithMaps(svc.id, svc.port ?? null, winMap, wslMap)
        if (!result.healthy) {
          processManager.markUnhealthy(svc.id, result.reason ?? 'unknown')
          await serviceRepository.update(svc.id, { status: 'stopped', pid: null })
        }
      }
    } catch (err) {
      console.error('[reconciler] tick error:', err)
    }
  }
}

export const reconciler = Reconciler.getInstance()
