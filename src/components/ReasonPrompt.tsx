'use client'

import { useEffect, useState } from 'react'
import { MessageSquareText, X } from 'lucide-react'

/** Mirrors the server's rule in configRevisionService.requireReason. */
export const MIN_REASON_LENGTH = 10

interface ReasonPromptProps {
  isOpen: boolean
  title: string
  /** One line describing exactly what is about to change. */
  summary: string
  confirmLabel?: string
  danger?: boolean
  /** Prefills the textarea, e.g. for a revert. */
  defaultReason?: string
  error?: string | null
  isBusy?: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

/**
 * Returns why a reason is not yet acceptable, or null when it is. Kept identical to
 * the server rule so the button enables exactly when the API would accept the value —
 * the client never decides policy, it just avoids a pointless round trip.
 * @param reason - the text currently in the box
 */
export function validateReason(reason: string): string | null {
  const value = reason.trim()
  if (value.length < MIN_REASON_LENGTH) return `${MIN_REASON_LENGTH - value.length} more character(s) needed`
  if (value.split(/\s+/).filter(Boolean).length < 2) return 'Give a real explanation, not a single word'
  return null
}

/**
 * Asks for the reasoning behind a configuration change before it is sent. Every
 * config mutation in Service Manager goes through one of these (or the Reason field
 * built into the add/edit forms), so a change can never be made without saying why.
 */
export function ReasonPrompt({ isOpen, title, summary, confirmLabel = 'Save change', danger, defaultReason, error, isBusy, onCancel, onConfirm }: ReasonPromptProps) {
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (isOpen) setReason(defaultReason ?? '')
  }, [isOpen, defaultReason])

  if (!isOpen) return null

  const problem = validateReason(reason)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative card w-full max-w-lg p-6 animate-slide-up">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <MessageSquareText size={18} className="text-accent" />
            <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
          </div>
          <button onClick={onCancel} className="btn-ghost p-1.5" aria-label="Cancel">
            <X size={18} />
          </button>
        </div>

        <p className="text-sm text-zinc-400 mb-4">{summary}</p>

        <label className="block text-sm text-zinc-400 mb-1.5">
          Why are you making this change? <span className="text-red-400">*</span>
        </label>
        <textarea
          autoFocus
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="textarea-field w-full h-28 font-sans"
          placeholder="e.g. Pinning llama to GPU 1 so ComfyUI keeps GPU 0 free for H3 renders"
        />
        <p className="mt-1.5 text-xs text-zinc-500">
          Recorded in this service&apos;s change log with the full before/after config, so it can be reviewed and reverted later.
        </p>

        {error && (
          <p className="mt-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onCancel} className="btn-ghost">Cancel</button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={Boolean(problem) || isBusy}
            className={`${danger ? 'btn-danger' : 'btn-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}
            title={problem ?? undefined}
          >
            {isBusy ? 'Saving...' : confirmLabel}
          </button>
        </div>
        {problem && <p className="mt-2 text-right text-xs text-zinc-500">{problem}</p>}
      </div>
    </div>
  )
}
