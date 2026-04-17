'use client'

import { useState, useEffect } from 'react'
import { X, Save, Trash2 } from 'lucide-react'
import { Service } from '@/types/service'

interface EditServiceModalProps {
  service: Service | null
  isOpen: boolean
  activeProfileId: string | null
  onClose: () => void
  onSave: (service: Service) => void
  onDelete: (id: string) => void
}

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
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (service) {
      setFormData({
        name: service.name,
        description: service.description || '',
        command: service.command,
        startOnBoot: service.startOnBoot,
        port: service.port ? String(service.port) : '',
        cudaDevice: service.cudaDevice || '',
      })
    }
  }, [service])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!service || !formData.name.trim() || !formData.command.trim()) return

    setIsSaving(true)
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
        }),
      })

      if (!globalRes.ok) return

      const updated = await globalRes.json()

      // Save profile-specific fields
      if (activeProfileId) {
        await fetch(`/api/profiles/${activeProfileId}/services/${service.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cudaDevice: formData.cudaDevice || null,
            startOnBoot: formData.startOnBoot,
          }),
        })
      }

      onSave({
        ...updated,
        cudaDevice: formData.cudaDevice || null,
        startOnBoot: formData.startOnBoot,
      })
      onClose()
    } catch (error) {
      console.error('Failed to save service:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!service) return
    if (!confirm(`Are you sure you want to delete "${service.name}"?`)) return

    try {
      const res = await fetch(`/api/services/${service.id}`, { method: 'DELETE' })
      if (res.ok) {
        onDelete(service.id)
        onClose()
      }
    } catch (error) {
      console.error('Failed to delete service:', error)
    }
  }

  if (!isOpen || !service) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="absolute inset-4 card p-6 animate-slide-up overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-zinc-100">Edit Service</h2>
          <button onClick={onClose} className="btn-ghost p-2">
            <X size={20} />
          </button>
        </div>

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
              className="textarea-field w-full h-[50vh]"
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
                <FieldBadge type="profile" />
              </label>
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
              <span className="text-sm text-zinc-400">
                Start on boot
                <FieldBadge type="profile" />
              </span>
            </label>
          </div>

          <div className="flex justify-between pt-4 border-t border-zinc-800">
            <button type="button" onClick={handleDelete} className="btn-danger text-sm">
              <Trash2 size={16} />
              Delete Service
            </button>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="btn-ghost">
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || !formData.name.trim() || !formData.command.trim()}
                className="btn-primary"
              >
                <Save size={16} />
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
