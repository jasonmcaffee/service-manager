import { configRevisionRepository } from '@/lib/repositories/configRevisionRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { ChangeAuthor } from '@/lib/util/changeReason'
import { ChangedField, ConfigChangeType, ConfigRevision, ConfigSnapshot } from '@/types/service'

/** A reason shorter than this is not an explanation, it is a shrug. */
export const MIN_REASON_LENGTH = 10

/** The snapshot fields a diff compares. profileId/profileName are context, not config. */
const DIFFABLE_FIELDS: Array<keyof ConfigSnapshot> = [
  'name', 'description', 'command', 'port', 'noPort', 'wsl', 'minFreeVramMb', 'cudaDevice', 'startOnBoot', 'autoRestart',
]

/** The fields a revert writes back. Runtime state (status/pid) is never restored. */
export const RESTORABLE_FIELDS = DIFFABLE_FIELDS

export const BASELINE_REASON =
  'Baseline snapshot recorded when the change log was introduced (task-1523). ' +
  'This is the configuration as it existed before changes were tracked.'

export interface ChangeProvenance {
  reason: string
  author?: ChangeAuthor | string
  /** Overrides the recorded change type — set to 'revert' when restoring a revision. */
  changeType?: ConfigChangeType
  /** The revision being restored, when this change is a revert. */
  revertedFromRevisionId?: string | null
}

/**
 * Builds the 400 thrown when a config change arrives without a usable reason. The
 * message names the action, the subject and the accepted forms, so an agent that
 * gets it wrong is told exactly how to retry instead of guessing.
 * @param action - what was being attempted, e.g. "update service"
 * @param subject - the thing being changed, e.g. the service name
 * @param detail - what specifically was wrong with the supplied reason
 */
function reasonError(action: string, subject: string, detail: string): Error {
  const err = new Error(
    `A reason is required to ${action} "${subject}" — ${detail}. ` +
    `Pass { "reason": "..." } in the body, an x-change-reason header, or ?reason=... ` +
    `explaining WHY this configuration is changing (at least ${MIN_REASON_LENGTH} characters, more than one word).`
  )
  ;(err as any).statusCode = 400
  return err
}

/**
 * Validates and normalises a change reason, throwing 400 when it is missing, too
 * short, or a single filler word. Callers MUST run this before mutating anything
 * so a rejected change can never leave a half-applied config behind.
 * @param reason - the raw reason supplied by the caller
 * @param action - what is being attempted, for the error message
 * @param subject - the service being changed, for the error message
 */
export function requireReason(reason: string | null | undefined, action: string, subject: string): string {
  const value = (reason ?? '').trim()
  if (!value) throw reasonError(action, subject, 'none was supplied')
  if (value.length < MIN_REASON_LENGTH) throw reasonError(action, subject, `"${value}" is only ${value.length} characters`)
  if (value.split(/\s+/).filter(Boolean).length < 2) throw reasonError(action, subject, `"${value}" is a single word`)
  return value
}

/**
 * Reads the effective configuration of a service: its own row merged with the
 * per-profile override (cudaDevice / startOnBoot) from the given profile, or the
 * active profile when none is named. Returns null if the service is gone.
 * @param serviceId - the service to snapshot
 * @param profileId - profile whose override to read; defaults to the active profile
 */
export async function captureSnapshot(serviceId: string, profileId?: string): Promise<ConfigSnapshot | null> {
  const service = await serviceRepository.findById(serviceId)
  if (!service) return null

  const profile = profileId
    ? await runProfileRepository.findById(profileId)
    : await runProfileRepository.findActive()
  const override = profile ? await runProfileRepository.findProfileService(profile.id, serviceId) : null

  return {
    name: service.name,
    description: service.description ?? null,
    command: service.command,
    port: service.port ?? null,
    noPort: Boolean((service as any).noPort),
    wsl: Boolean((service as any).wsl),
    minFreeVramMb: (service as any).minFreeVramMb ?? null,
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? null,
    cudaDevice: override?.cudaDevice ?? null,
    startOnBoot: override?.startOnBoot ?? false,
    autoRestart: override?.autoRestart ?? false,
  }
}

/**
 * Lists the fields that differ between two snapshots. Used to decide whether a
 * change is worth recording at all and to render the History tab's diff without
 * the UI having to re-derive it.
 * @param before - config before the change (null for a create)
 * @param after - config after the change (null for a delete)
 */
export function diffSnapshots(before: ConfigSnapshot | null, after: ConfigSnapshot | null): ChangedField[] {
  if (!before || !after) return []
  const changed: ChangedField[] = []
  for (const field of DIFFABLE_FIELDS) {
    const from = before[field] ?? null
    const to = after[field] ?? null
    if (from !== to) changed.push({ field, from, to })
  }
  return changed
}

export interface RecordChangeInput {
  serviceId: string
  serviceName: string
  changeType: ConfigChangeType
  provenance: ChangeProvenance
  previous: ConfigSnapshot | null
  snapshot: ConfigSnapshot | null
  revertedFromRevisionId?: string | null
  /** Skip the write when an update turned out to change nothing. Default true. */
  skipWhenUnchanged?: boolean
}

/**
 * Appends one revision to a service's change log. Runs AFTER the mutation it
 * describes and never throws: an audit write that failed must not undo or mask a
 * change that already succeeded — it is logged loudly instead. Validation happens
 * up front in requireReason, which does throw.
 * @param input - the change being recorded, with both snapshots
 */
export async function recordChange(input: RecordChangeInput): Promise<void> {
  try {
    const changedFields = diffSnapshots(input.previous, input.snapshot)
    const skipWhenUnchanged = input.skipWhenUnchanged ?? true
    if (skipWhenUnchanged && input.previous && input.snapshot && changedFields.length === 0) return

    const profileSource = input.snapshot ?? input.previous
    await configRevisionRepository.create({
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      profileId: profileSource?.profileId ?? null,
      profileName: profileSource?.profileName ?? null,
      changeType: input.changeType,
      author: String(input.provenance.author ?? 'ui'),
      reason: input.provenance.reason,
      snapshot: input.snapshot ? JSON.stringify(input.snapshot) : null,
      previous: input.previous ? JSON.stringify(input.previous) : null,
      changedFields: JSON.stringify(changedFields),
      revertedFromRevisionId: input.revertedFromRevisionId ?? null,
    })
  } catch (err: any) {
    console.error('[configRevision] failed to record change:', err?.message)
  }
}

/** Parses a stored JSON column back into a value, tolerating corrupt rows. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Converts a stored revision row into the shape the UI consumes. */
function toRevision(row: any): ConfigRevision {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    profileId: row.profileId ?? null,
    profileName: row.profileName ?? null,
    changeType: row.changeType as ConfigChangeType,
    author: row.author,
    reason: row.reason,
    snapshot: parseJson<ConfigSnapshot | null>(row.snapshot, null),
    previous: parseJson<ConfigSnapshot | null>(row.previous, null),
    changedFields: parseJson<ChangedField[]>(row.changedFields, []),
    revertedFromRevisionId: row.revertedFromRevisionId ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

/**
 * Returns a service's change log, newest first.
 * @param serviceId - the service whose history to read
 * @param limit - maximum rows to return
 */
export async function listRevisions(serviceId: string, limit = 50): Promise<ConfigRevision[]> {
  await ensureBaselineRevisions()
  const rows = await configRevisionRepository.listByService(serviceId, limit)
  return rows.map(toRevision)
}

/**
 * Loads a single revision, scoped to its service so a caller cannot reach another
 * service's history by guessing an id.
 * @param serviceId - the service the revision must belong to
 * @param revisionId - the revision to load
 */
export async function getRevision(serviceId: string, revisionId: string): Promise<ConfigRevision | null> {
  const row = await configRevisionRepository.findById(revisionId)
  if (!row || row.serviceId !== serviceId) return null
  return toRevision(row)
}

/**
 * Gives every service that predates the change log exactly one `baseline` revision
 * holding its current configuration, so the History tab is never empty and the
 * first real change has something to diff against. Idempotent — a service with any
 * history is left alone.
 */
export async function ensureBaselineRevisions(): Promise<number> {
  try {
    const [services, withHistory] = await Promise.all([
      serviceRepository.findAll(),
      configRevisionRepository.listServiceIdsWithRevisions(),
    ])

    let created = 0
    for (const service of services) {
      if (withHistory.has(service.id)) continue
      const snapshot = await captureSnapshot(service.id)
      await configRevisionRepository.create({
        serviceId: service.id,
        serviceName: service.name,
        profileId: snapshot?.profileId ?? null,
        profileName: snapshot?.profileName ?? null,
        changeType: 'baseline',
        author: 'api',
        reason: BASELINE_REASON,
        snapshot: snapshot ? JSON.stringify(snapshot) : null,
        previous: null,
        changedFields: '[]',
      })
      created++
    }
    if (created > 0) console.log(`[configRevision] backfilled ${created} baseline revision(s)`)
    return created
  } catch (err: any) {
    console.error('[configRevision] baseline backfill failed:', err?.message)
    return 0
  }
}

export const configRevisionService = {
  requireReason,
  captureSnapshot,
  diffSnapshots,
  recordChange,
  listRevisions,
  getRevision,
  ensureBaselineRevisions,
}
