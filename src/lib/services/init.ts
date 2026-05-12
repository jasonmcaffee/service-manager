import fs from 'fs'
import { processManager } from '@/lib/process-manager'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { snapshotWindowsListeners, snapshotWslListeners, isWslProxyPid } from '@/lib/util/portHelper'
import { getLogFilePath } from '@/lib/util/logTailer'
import { reconciler } from '@/lib/services/reconciler'

const globalForInit = globalThis as unknown as { smInitPromise?: Promise<void> }

/**
 * Known port defaults for services that don't store a port in the DB.
 * Only applied when the service's port is currently NULL.
 */
const KNOWN_PORT_DEFAULTS: Record<string, number> = {
  'Speaches STT & TTS': 8000,
}

/**
 * Creates the Default profile and migrates any legacy cudaDevice/startOnBoot
 * columns if no profiles exist yet.
 */
export async function ensureDefaultProfile(): Promise<void> {
  const count = await runProfileRepository.count()
  if (count > 0) return

  const profile = await runProfileRepository.create('Default')
  await runProfileRepository.setActive(profile.id)

  const services = await serviceRepository.findAll()
  for (const service of services) {
    await runProfileRepository.upsertProfileService(profile.id, service.id, {
      cudaDevice: (service as any).cudaDevice ?? null,
      startOnBoot: (service as any).startOnBoot ?? false,
    })
  }
}

/**
 * Backfills known port defaults for services with port=NULL.
 * Only runs when the port is actually NULL so user overrides are preserved.
 */
async function backfillKnownPorts(): Promise<void> {
  for (const [name, port] of Object.entries(KNOWN_PORT_DEFAULTS)) {
    const svc = await serviceRepository.findByName(name)
    if (svc && svc.port == null) {
      await serviceRepository.update(svc.id, { port })
      console.log(`[init] backfilled port=${port} for "${name}"`)
    }
  }
}

/**
 * Returns services sorted so active-profile autostart services come first.
 * This ensures that when two services share a port, the intended one adopts.
 * @param services - all services from DB
 * @param activeProfileId - active profile id (undefined = no active profile)
 */
async function rankByAutostartPriority(services: any[], activeProfileId: string | undefined): Promise<any[]> {
  if (!activeProfileId) return services
  const autoStartEntries = await runProfileRepository.findAutoStartServices(activeProfileId)
  const autostartIds = new Set(autoStartEntries.map((e: any) => e.serviceId))
  return [...services].sort((a, b) => Number(autostartIds.has(b.id)) - Number(autostartIds.has(a.id)))
}

export interface AdoptionReport {
  adopted: Array<{ serviceId: string; pid: number; kind: string }>
  conflicts: Array<{ serviceId: string; port: number; pid: number }>
  skipped: Array<{ serviceId: string; reason: string }>
}

/**
 * Scans OS listeners once (Windows + WSL) and adopts any service whose port
 * is already occupied — preventing EADDRINUSE on service-manager restarts.
 * Uses claim-tracking to ensure one PID is never adopted by two services.
 */
async function adoptRunningServices(): Promise<AdoptionReport> {
  const [winMap, wslMap] = await Promise.all([
    snapshotWindowsListeners(),
    snapshotWslListeners(),
  ])

  const services = await serviceRepository.findAll()
  const active = await runProfileRepository.findActive()
  const ranked = await rankByAutostartPriority(services, active?.id)

  const claimed = new Set<string>()
  const claimedPorts = new Set<number>()
  const report: AdoptionReport = { adopted: [], conflicts: [], skipped: [] }

  for (const svc of ranked) {
    if (!svc.port) {
      report.skipped.push({ serviceId: svc.id, reason: 'no-port' })
      continue
    }
    if (processManager.isRunning(svc.id)) continue

    // Port-level claim: even if two services resolve to different PIDs/maps on
    // the same port (e.g. a WSL service and the Windows port-forwarding proxy),
    // only one service may hold a given port at a time.
    if (claimedPorts.has(svc.port)) {
      report.conflicts.push({ serviceId: svc.id, port: svc.port, pid: 0 })
      console.warn(`[init] adoption conflict: "${svc.name}" (port ${svc.port}) — port already claimed by another service`)
      continue
    }

    const rawWinPid = winMap.get(svc.port)?.[0]
    const wslPid = wslMap.get(svc.port)?.[0]

    // Filter out Windows PIDs that belong to svchost (WSL's port-forwarding proxy
    // via iphlpsvc). svchost stays on the port even when the WSL service has stopped,
    // so adopting it would keep the service falsely marked as running forever.
    const winPid = (rawWinPid !== undefined && await isWslProxyPid(rawWinPid))
      ? undefined
      : rawWinPid

    // WSL services: only adopt from the WSL process map.
    // The Windows port-forwarding proxy stays alive even when the WSL service has
    // stopped, so using it as the health signal gives a false positive.
    const candidate = (svc as any).wsl
      ? (wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid } : null)
      : winPid !== undefined ? { kind: 'windows' as const, pid: winPid }
        : wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid }
        : null

    if (!candidate) continue

    const key = `${candidate.kind}:${candidate.pid}`
    if (claimed.has(key)) {
      report.conflicts.push({ serviceId: svc.id, port: svc.port, pid: candidate.pid })
      console.warn(`[init] adoption conflict: "${svc.name}" (port ${svc.port}) — pid ${candidate.pid} already claimed by another service`)
      continue
    }
    claimed.add(key)
    claimedPorts.add(svc.port)

    processManager.adoptExternal(svc.id, candidate.pid, candidate.kind)
    await serviceRepository.update(svc.id, { status: 'running', pid: candidate.pid })
    report.adopted.push({ serviceId: svc.id, pid: candidate.pid, kind: candidate.kind })
    console.log(`[init] adopted "${svc.name}" (port ${svc.port}) pid=${candidate.pid} kind=${candidate.kind}`)
  }

  if (report.conflicts.length > 0) {
    console.warn(`[init] ${report.conflicts.length} port conflict(s) detected — check for services sharing the same port`)
  }

  return report
}

const LOG_FRESHNESS_MS = 30 * 60 * 1000 // 30 minutes

/**
 * For noPort services, uses log file freshness as the signal that the process is still
 * running. If the log file was written within LOG_FRESHNESS_MS, the service is adopted
 * without a PID — the logTailer watches the file so new output is captured.
 */
async function adoptNoPortServices(): Promise<void> {
  const services = await serviceRepository.findAll()

  for (const svc of services) {
    if (!(svc as any).noPort) continue
    if (processManager.isRunning(svc.id)) continue

    const logFile = getLogFilePath(svc.id)
    if (!fs.existsSync(logFile)) continue

    const stat = fs.statSync(logFile)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > LOG_FRESHNESS_MS) continue

    processManager.adoptNoPort(svc.id)
    await serviceRepository.update(svc.id, { status: 'running', pid: null })
    console.log(`[init] adopted noPort service "${svc.name}" via log freshness (age=${Math.round(ageMs / 1000)}s)`)
  }
}

/**
 * Single-flight initialization: backfills ports, ensures a default profile exists,
 * adopts already-running services, and starts the reconciler.
 * Safe to call concurrently — all callers share the same Promise.
 */
export function initializeIfNeeded(): Promise<void> {
  if (!globalForInit.smInitPromise) {
    globalForInit.smInitPromise = (async () => {
      await backfillKnownPorts()
      await ensureDefaultProfile()
      await adoptRunningServices()
      await adoptNoPortServices()
      reconciler.start()
    })()
  }
  return globalForInit.smInitPromise
}
