'use client'

import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { validateReason } from './ReasonPrompt'

interface AddServiceModalProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (service: any) => void
}

export function AddServiceModal({ isOpen, onClose, onAdd }: AddServiceModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    command: '',
    startOnBoot: false,
    autoRestart: false,
    port: '',
    cudaDevice: '',
  })
  const [reason, setReason] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim() || !formData.command.trim()) return
    const reasonProblem = validateReason(reason)
    if (reasonProblem) {
      setSubmitError(`A reason is required to register a service — ${reasonProblem}.`)
      return
    }

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          port: formData.port ? parseInt(formData.port) : null,
          cudaDevice: formData.cudaDevice || null,
          reason: reason.trim(),
        }),
      })

      if (res.ok) {
        const service = await res.json()
        onAdd(service)
        setFormData({
          name: '',
          description: '',
          command: '',
          startOnBoot: false,
          autoRestart: false,
          port: '',
          cudaDevice: '',
        })
        setReason('')
        onClose()
      } else {
        setSubmitError((await res.json().catch(() => null))?.error ?? 'Failed to add service')
      }
    } catch (error: any) {
      console.error('Failed to add service:', error)
      setSubmitError(error?.message ?? 'Failed to add service')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-2xl card p-6 animate-slide-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-zinc-100">Add New Service</h2>
          <button onClick={onClose} className="btn-ghost p-2">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Service Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input-field w-full"
                placeholder="My Service"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">Description</label>
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
            </label>
            <textarea
              value={formData.command}
              onChange={(e) => setFormData({ ...formData, command: e.target.value })}
              className="textarea-field w-full h-48"
              placeholder="echo Hello World&#10;cd /d C:\myapp&#10;npm start"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">Port</label>
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
              <label className="block text-sm text-zinc-400 mb-1.5">CUDA Device</label>
              <input
                type="text"
                value={formData.cudaDevice}
                onChange={(e) => setFormData({ ...formData, cudaDevice: e.target.value })}
                className="input-field w-full"
                placeholder="0"
              />
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
              <span className="text-sm text-zinc-400">Start on boot</span>
            </label>
          </div>

          <div className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.autoRestart}
                onChange={(e) => setFormData({ ...formData, autoRestart: e.target.checked })}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-accent focus:ring-accent/50"
              />
              <span className="text-sm text-zinc-400">Auto-restart if it dies</span>
            </label>
          </div>

          {/* Every configuration change carries its reasoning, registration included
              — it becomes the first entry in the service's change log (task-1523). */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Why are you adding this service? <span className="text-red-400">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="textarea-field w-full h-20 font-sans"
              placeholder="e.g. Registering the second ComfyUI instance so the H3 batch can render on GPU 1"
              required
            />
          </div>

          {submitError && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-zinc-800">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !formData.name.trim() || !formData.command.trim() || Boolean(validateReason(reason))}
              className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
              title={validateReason(reason) ?? undefined}
            >
              <Plus size={18} />
              {isSubmitting ? 'Adding...' : 'Add Service'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
