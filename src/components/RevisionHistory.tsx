'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, History, Loader2, RotateCcw } from 'lucide-react'
import { ChangedField, ConfigRevision, ConfigSnapshot } from '@/types/service'
import { ReasonPrompt } from './ReasonPrompt'

interface RevisionHistoryProps {
  serviceId: string
  /** Called after a successful revert so the settings form can reload. */
  onReverted: () => void
}

const CHANGE_TYPE_STYLES: Record<string, string> = {
  create: 'bg-green-500/15 text-green-400 border-green-500/30',
  update: 'bg-accent/15 text-accent border-accent/30',
  revert: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  delete: 'bg-red-500/15 text-red-400 border-red-500/30',
  baseline: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  command: 'Command',
  port: 'Port',
  noPort: 'No-port',
  wsl: 'WSL',
  minFreeVramMb: 'Min free VRAM (MB)',
  cudaDevice: 'CUDA device',
  startOnBoot: 'Start on boot',
}

/** Renders a config value for display, keeping empty/unset visibly distinct from a value. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}

/** One-line summary of what a revision changed, used in the collapsed row. */
function summarize(revision: ConfigRevision): string {
  if (revision.changeType === 'baseline') return 'Configuration as it stood before change tracking'
  if (revision.changeType === 'create') return 'Service registered'
  if (revision.changeType === 'delete') return 'Service deleted'
  if (revision.changedFields.length === 0) return 'No field changes recorded'
  return revision.changedFields.map(f => FIELD_LABELS[f.field] ?? f.field).join(', ')
}

/** Long values (a start command) need their own block; short ones read better inline. */
function isLongValue(value: unknown): boolean {
  return typeof value === 'string' && (value.length > 60 || value.includes('\n'))
}

function ChangedFieldRow({ change }: { change: ChangedField }) {
  const long = isLongValue(change.from) || isLongValue(change.to)
  return (
    <div className="py-2 border-b border-zinc-800/60 last:border-b-0">
      <div className="text-xs font-medium text-zinc-300 mb-1">{FIELD_LABELS[change.field] ?? change.field}</div>
      <div className={long ? 'space-y-1' : 'flex items-center gap-2 text-xs'}>
        <pre className="flex-1 text-xs text-red-300/80 bg-red-500/5 border border-red-500/20 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono">
          {formatValue(change.from)}
        </pre>
        {!long && <span className="text-zinc-600">→</span>}
        <pre className="flex-1 text-xs text-green-300/80 bg-green-500/5 border border-green-500/20 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono">
          {formatValue(change.to)}
        </pre>
      </div>
    </div>
  )
}

function SnapshotView({ snapshot }: { snapshot: ConfigSnapshot }) {
  const scalarFields: Array<keyof ConfigSnapshot> = ['name', 'description', 'port', 'noPort', 'wsl', 'cudaDevice', 'startOnBoot', 'minFreeVramMb']
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {scalarFields.map(field => (
          <div key={field} className="flex justify-between gap-2 text-xs border-b border-zinc-800/40 py-1">
            <span className="text-zinc-500">{FIELD_LABELS[field] ?? field}</span>
            <span className="text-zinc-300 font-mono truncate" title={formatValue(snapshot[field])}>{formatValue(snapshot[field])}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="text-xs text-zinc-500 mb-1">Command</div>
        <pre className="text-[11px] text-zinc-300 bg-surface-300 border border-zinc-800 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
          {snapshot.command}
        </pre>
      </div>
      {snapshot.profileName && (
        <p className="text-[11px] text-zinc-500">Profile-scoped values captured under profile <span className="text-zinc-400">{snapshot.profileName}</span>.</p>
      )}
    </div>
  )
}

/**
 * The History tab of the service settings modal: every recorded configuration change,
 * newest first. A row expands to show the reasoning behind the change, exactly which
 * fields moved, and the full configuration at that point — and offers to restore it.
 */
export function RevisionHistory({ serviceId, onReverted }: RevisionHistoryProps) {
  const [revisions, setRevisions] = useState<ConfigRevision[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revertTarget, setRevertTarget] = useState<ConfigRevision | null>(null)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [isReverting, setIsReverting] = useState(false)

  const fetchRevisions = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${serviceId}/revisions`)
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to load history')
      const data = await res.json()
      setRevisions(data.revisions ?? [])
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load history')
    } finally {
      setIsLoading(false)
    }
  }, [serviceId])

  useEffect(() => { fetchRevisions() }, [fetchRevisions])

  const handleRevert = async (reason: string) => {
    if (!revertTarget) return
    setIsReverting(true)
    setRevertError(null)
    try {
      const res = await fetch(`/api/services/${serviceId}/revisions/${revertTarget.id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) {
        setRevertError((await res.json().catch(() => null))?.error ?? 'Revert failed')
        return
      }
      setRevertTarget(null)
      await fetchRevisions()
      onReverted()
    } catch (err: any) {
      setRevertError(err?.message ?? 'Revert failed')
    } finally {
      setIsReverting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-500 gap-2">
        <Loader2 size={18} className="animate-spin" /> Loading change log...
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</p>
  }

  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
        <History size={28} className="mb-2 text-zinc-600" />
        <p className="text-sm">No configuration changes recorded yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">
        {revisions.length} recorded change{revisions.length === 1 ? '' : 's'}, newest first. Click one to see the reasoning and the full configuration at that point.
      </p>

      {revisions.map(revision => {
        const isExpanded = expandedId === revision.id
        return (
          <div key={revision.id} className="border border-zinc-800 rounded-lg overflow-hidden bg-surface-200/40">
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : revision.id)}
              className="w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-white/5 transition-colors"
            >
              {isExpanded ? <ChevronDown size={16} className="mt-0.5 text-zinc-500 flex-shrink-0" /> : <ChevronRight size={16} className="mt-0.5 text-zinc-500 flex-shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${CHANGE_TYPE_STYLES[revision.changeType] ?? CHANGE_TYPE_STYLES.update}`}>
                    {revision.changeType}
                  </span>
                  <span className="text-xs text-zinc-400">{new Date(revision.createdAt).toLocaleString()}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{revision.author}</span>
                  {revision.profileName && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{revision.profileName}</span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 mt-1 truncate">{summarize(revision)}</p>
                {!isExpanded && <p className="text-xs text-zinc-400 mt-1 truncate italic">&ldquo;{revision.reason}&rdquo;</p>}
              </div>
            </button>

            {isExpanded && (
              <div className="px-3 pb-3 pt-1 space-y-4 border-t border-zinc-800/60">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Reasoning</div>
                  <p className="text-sm text-zinc-200 bg-surface-300 border border-zinc-800 rounded p-2.5 whitespace-pre-wrap">{revision.reason}</p>
                  {revision.revertedFromRevisionId && (
                    <p className="text-[11px] text-purple-300/80 mt-1">Restored the configuration from an earlier revision.</p>
                  )}
                </div>

                {revision.changedFields.length > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">What changed</div>
                    <div className="bg-surface-300 border border-zinc-800 rounded px-2.5">
                      {revision.changedFields.map(change => <ChangedFieldRow key={change.field} change={change} />)}
                    </div>
                  </div>
                )}

                {revision.snapshot ? (
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">Configuration after this change</div>
                    <SnapshotView snapshot={revision.snapshot} />
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">The service was deleted at this point — there is no configuration to restore.</p>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => { setRevertError(null); setRevertTarget(revision) }}
                    disabled={!revision.snapshot}
                    className="btn-ghost text-xs border border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <RotateCcw size={14} />
                    Revert to this config
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <ReasonPrompt
        isOpen={revertTarget !== null}
        title="Revert to an earlier configuration"
        summary={revertTarget
          ? `Restores the configuration from ${new Date(revertTarget.createdAt).toLocaleString()}. This is recorded as a new change — nothing is erased, and the service is not restarted.`
          : ''}
        confirmLabel="Revert config"
        defaultReason={revertTarget ? `Reverting to the configuration from ${new Date(revertTarget.createdAt).toLocaleString()} because ` : ''}
        error={revertError}
        isBusy={isReverting}
        onCancel={() => setRevertTarget(null)}
        onConfirm={handleRevert}
      />
    </div>
  )
}
