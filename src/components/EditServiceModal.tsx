'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Save, Trash2, History, SlidersHorizontal } from 'lucide-react'
import { Service } from '@/types/service'
import { RevisionHistory } from './RevisionHistory'
import { ReasonPrompt, validateReason } from './ReasonPrompt'

interface EditServiceModalProps {
  service: Service | null
  isOpen: boolean
  activeProfileId: string | null
  onClose: () => void
  onSave: (service: Service) => void
  onDelete: (id: string) => void
}

type Tab = 'settings' | 'history'

function FieldBadge({ type }: { type: 'global' | 'profile' }) {
  return (
    <span className={`ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${
      type === 'global'
        ? 'bg-zinc-700 text-zinc-400'
        : 'bg-accent/20 text-accent'
    }`}>
      {type}
    </span>
  )
}

export function EditServiceModal({ service, isOpen, activeProfileId, onClose, onSave, onDelete }: EditServiceModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    command: '',
    startOnBoot: false,
    port: '',
    cudaDevice: '',
  })
  const [reason, setReason] = useState('')
  const [tab, setTab] = useState<Tab>('settings')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isDeletePromptOpen, setIsDeletePromptOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // A command that hard-codes CUDA_VISIBLE_DEVICES / --cuda-device owns the GPU
  // choice; the field is shown but not editable so the registration can never
  // disagree with the card the process actually gets (task-1493).
  const pinnedByCommand = service?.cudaDeviceSource === 'command'

  /** Loads the form from a service row. Shared by open, and by a revert's reload. */
  const applyService = useCallback((next: Service) => {
    setFormData({
      name: next.name,
      description: next.description || '',
      command: next.command,
      startOnBoot: next.startOnBoot,
      port: next.port ? String(next.port) : '',
      cudaDevice: next.cudaDevice || '',
    })
  }, [])

  useEffect(() => {
    if (service) applyService(service)
  }, [service, applyService])

  // The reason belongs to one specific change; it must never carry over to the next
  // edit, so it is cleared whenever a different service is opened.
  useEffect(() => {
    setReason('')
    setSaveError(null)
    setTab('settings')
  }, [service?.id])

  /** Re-reads the service after a revert so the Settings tab shows the restored config. */
  const reloadService = useCallback(async () => {
    if (!service) return
    try {
      const res = await fetch(`/api/services/${service.id}`)
      if (!res.ok) return
      const fresh: Service = await res.json()
      applyService(fresh)
      onSave(fresh)
    } catch {
      // A failed reload only means the form is stale; the poll will correct it.
    }
  }, [service, applyService, onSave])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!service || !formData.name.trim() || !formData.command.trim()) return
    const reasonProblem = validateReason(reason)
    if (reasonProblem) {
      setSaveError(`A reason is required for this change — ${reasonProblem}.`)
      return
    }

    setIsSaving(true)
    setSaveError(null)
    try {
      // Save global fields
      const globalRes = await fetch(`/api/services/${service.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          command: formData.command,
          port: formData.port ? parseInt(formData.port) : null,
          reason: reason.trim(),
        }),
      })

      if (!globalRes.ok) {
        setSaveError((await globalRes.json().catch(() => null))?.error ?? 'Failed to save service')
        return
      }

      const updated = await globalRes.json()

      // Save profile-specific fields. A command-pinned GPU is not sent — the command
      // is the source of truth for it and the server rejects a contradicting value.
      if (activeProfileId) {
        const profileRes = await fetch(`/api/profiles/${activeProfileId}/services/${service.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(pinnedByCommand ? {} : { cudaDevice: formData.cudaDevice || null }),
            startOnBoot: formData.startOnBoot,
            reason: reason.trim(),
          }),
        })
        if (!profileRes.ok) {
          setSaveError((await profileRes.json().catch(() => null))?.error ?? 'Failed to save profile settings')
          return
        }
      }

      onSave({
        ...updated,
        cudaDevice: formData.cudaDevice || null,
        startOnBoot: formData.startOnBoot,
      })
      onClose()
    } catch (error: any) {
      console.error('Failed to save service:', error)
      setSaveError(error?.message ?? 'Failed to save service')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (deleteReason: string) => {
    if (!service) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReason }),
      })
      if (!res.ok) {
        setDeleteError((await res.json().catch(() => null))?.error ?? 'Failed to delete service')
        return
      }
      setIsDeletePromptOpen(false)
      onDelete(service.id)
      onClose()
    } catch (error: any) {
      console.error('Failed to delete service:', error)
      setDeleteError(error?.message ?? 'Failed to delete service')
    } finally {
      setIsDeleting(false)
    }
  }

  if (!isOpen || !service) return null

  const reasonProblem = validateReason(reason)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="absolute inset-4 card p-6 animate-slide-up overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-zinc-100">{service.name} — Settings</h2>
          <button onClick={onClose} className="btn-ghost p-2">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-5 border-b border-zinc-800">
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === 'settings' ? 'border-accent text-accent' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <SlidersHorizontal size={14} /> Configuration
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === 'history' ? 'border-accent text-accent' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <History size={14} /> Change log
          </button>
        </div>

        {tab === 'history' ? (
          <RevisionHistory serviceId={service.id} onReverted={reloadService} />
        ) : (
        <>
        {/* Legend */}
        <div className="flex items-center gap-3 mb-5 text-xs text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded text-[10px] font-medium">global</span>
            applies to all profiles
          </span>
          <span className="flex items-center gap-1">
            <span className="bg-accent/20 text-accent px-1.5 py-0.5 rounded text-[10px] font-medium">profile</span>
            applies to current profile only
          </span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Service Name <span className="text-red-400">*</span>
                <FieldBadge type="global" />
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input-field w-full"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Description
                <FieldBadge type="global" />
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input-field w-full"
                placeholder="Optional"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Batch Script / Command <span className="text-red-400">*</span>
              <FieldBadge type="global" />
            </label>
            <textarea
              value={formData.command}
              onChange={(e) => setFormData({ ...formData, command: e.target.value })}
              className="textarea-field w-full h-[35vh]"
              placeholder="echo Hello World"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Port
                <FieldBadge type="global" />
              </label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                className="input-field w-full"
                placeholder="8080"
                min={1}
                max={65535}
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                CUDA Device
                <FieldBadge type={pinnedByCommand ? 'global' : 'profile'} />
              </label>
              <input
                type="text"
                value={formData.cudaDevice}
                onChange={(e) => setFormData({ ...formData, cudaDevice: e.target.value })}
                className="input-field w-full disabled:opacity-60"
                placeholder="0"
                disabled={pinnedByCommand}
              />
              {pinnedByCommand && (
                <p className="mt-1 text-xs text-zinc-500">
                  Pinned by the start command — edit the command to change the GPU.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.startOnBoot}
                onChange={(e) => setFormData({ ...formData, startOnBoot: e.target.checked })}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-accent focus:ring-accent/50"
              />
              <span className="text-sm text-zinc-400">
                Start on boot
                <FieldBadge type="profile" />
              </span>
            </label>
          </div>

          {/* Reasoning is required on every config change — it is recorded in the
              change log alongside the before/after config (task-1523). */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Reason for this change <span className="text-red-400">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="textarea-field w-full h-20 font-sans"
              placeholder="e.g. Raised the context size to 200k for the long-document workflow"
              required
            />
            <p className="mt-1 text-xs text-zinc-500">
              Saved to the <button type="button" className="text-accent hover:underline" onClick={() => setTab('history')}>change log</button> with
              the full before/after config, so this edit can be reviewed and reverted later.
            </p>
          </div>

          {saveError && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
              {saveError}
            </p>
          )}

          <div className="flex justify-between pt-4 border-t border-zinc-800">
            <button type="button" onClick={() => { setDeleteError(null); setIsDeletePromptOpen(true) }} className="btn-danger text-sm">
              <Trash2 size={16} />
              Delete Service
            </button>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="btn-ghost">
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || !formData.name.trim() || !formData.command.trim() || Boolean(reasonProblem)}
                className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                title={reasonProblem ? `Reason required — ${reasonProblem}` : undefined}
              >
                <Save size={16} />
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
        </>
        )}
      </div>

      <ReasonPrompt
        isOpen={isDeletePromptOpen}
        title={`Delete "${service.name}"`}
        summary="The service is stopped and removed. Its change log is kept, including this deletion and the configuration it had."
        confirmLabel="Delete service"
        danger
        error={deleteError}
        isBusy={isDeleting}
        onCancel={() => setIsDeletePromptOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  )
}
