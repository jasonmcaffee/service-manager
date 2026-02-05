'use client'

import { useState, useEffect, useCallback } from 'react'
import { Service } from '@/types/service'
import { StatusBadge } from './StatusBadge'
import { TerminalOutput } from './TerminalOutput'
import {
  Play,
  Square,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Settings,
  Save,
  Trash2,
  Power,
} from 'lucide-react'

interface ServiceCardProps {
  service: Service
  onUpdate: (service: Service) => void
  onDelete: (id: string) => void
  onRefresh: () => void
}

export function ServiceCard({ service, onUpdate, onDelete, onRefresh }: ServiceCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const [localService, setLocalService] = useState(service)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Fetch output periodically when expanded
  const fetchOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${service.id}/output`)
      if (res.ok) {
        const data = await res.json()
        setOutput(data.output || [])
      }
    } catch (error) {
      console.error('Failed to fetch output:', error)
    }
  }, [service.id])

  useEffect(() => {
    if (isExpanded) {
      fetchOutput()
      const interval = setInterval(fetchOutput, 1000)
      return () => clearInterval(interval)
    }
  }, [isExpanded, fetchOutput])

  // Only sync from props when NOT editing to prevent overwriting user input
  useEffect(() => {
    if (!isEditing) {
      setLocalService(service)
    }
  }, [service, isEditing])

  const handleControl = async (action: 'start' | 'stop' | 'restart') => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/services/${service.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        onRefresh()
        if (action === 'start' || action === 'restart') {
          setIsExpanded(true)
        }
      }
    } catch (error) {
      console.error(`Failed to ${action} service:`, error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localService),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdate(updated)
        setIsEditing(false)
      }
    } catch (error) {
      console.error('Failed to save service:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${service.name}"?`)) return
    
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        onDelete(service.id)
      }
    } catch (error) {
      console.error('Failed to delete service:', error)
    }
  }

  const handleClearOutput = async () => {
    try {
      await fetch(`/api/services/${service.id}/output`, { method: 'DELETE' })
      setOutput([])
    } catch (error) {
      console.error('Failed to clear output:', error)
    }
  }

  const handleToggleStartOnBoot = async () => {
    const updated = { ...service, startOnBoot: !service.startOnBoot }
    
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
      if (res.ok) {
        const data = await res.json()
        onUpdate(data)
      }
    } catch (error) {
      console.error('Failed to update service:', error)
    }
  }

  const handleCancelEdit = () => {
    setLocalService(service) // Reset to original
    setIsEditing(false)
  }

  const isRunning = service.status === 'running'
  const isStarting = service.status === 'starting'

  return (
    <div 
      className={`card transition-all duration-300 animate-fade-in ${
        isRunning ? 'glow-success' : ''
      } ${service.status === 'error' ? 'glow-error' : ''}`}
    >
      {/* Header */}
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div 
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
              isRunning 
                ? 'bg-green-500/20 text-green-400' 
                : 'bg-zinc-700/30 text-zinc-500'
            }`}
          >
            <Power size={20} />
          </div>
          
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-zinc-100 truncate">{service.name}</h3>
            {service.description && (
              <p className="text-sm text-zinc-500 truncate">{service.description}</p>
            )}
          </div>

          <StatusBadge status={service.status || 'stopped'} pid={service.pid ?? undefined} />
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 ml-4">
          {/* Start on boot toggle */}
          <button
            onClick={handleToggleStartOnBoot}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              service.startOnBoot
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
            }`}
            title={service.startOnBoot ? 'Starts on boot' : 'Does not start on boot'}
          >
            Auto-start
          </button>

          {/* Control buttons */}
          {isRunning ? (
            <>
              <button
                onClick={() => handleControl('restart')}
                disabled={isLoading}
                className="btn-ghost text-amber-400 hover:bg-amber-500/10"
                title="Restart"
              >
                <RotateCcw size={18} className={isLoading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => handleControl('stop')}
                disabled={isLoading}
                className="btn-ghost text-red-400 hover:bg-red-500/10"
                title="Stop"
              >
                <Square size={18} />
              </button>
            </>
          ) : (
            <button
              onClick={() => handleControl('start')}
              disabled={isLoading || isStarting}
              className="btn-ghost text-green-400 hover:bg-green-500/10"
              title="Start"
            >
              <Play size={18} className={isStarting ? 'animate-pulse' : ''} />
            </button>
          )}

          {/* Expand/collapse */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="btn-ghost"
          >
            {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-zinc-800/50 p-4 space-y-4 animate-slide-up">
          {/* Terminal output */}
          <TerminalOutput 
            output={output} 
            onClear={handleClearOutput}
            isLoading={isStarting}
          />

          {/* Edit mode toggle */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="btn-ghost text-sm"
            >
              <Settings size={16} />
              {isEditing ? 'Hide Settings' : 'Edit Settings'}
            </button>

            {isEditing && (
              <div className="flex items-center gap-2">
                <button onClick={handleDelete} className="btn-danger text-sm py-1.5">
                  <Trash2 size={14} />
                  Delete
                </button>
                <button onClick={handleCancelEdit} className="btn-ghost text-sm py-1.5">
                  Cancel
                </button>
                <button 
                  onClick={handleSave} 
                  disabled={isSaving}
                  className="btn-success text-sm py-1.5"
                >
                  <Save size={14} />
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>

          {/* Edit form - simplified */}
          {isEditing && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1.5">Service Name</label>
                  <input
                    type="text"
                    value={localService.name}
                    onChange={(e) => setLocalService({ ...localService, name: e.target.value })}
                    className="input-field w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1.5">Description</label>
                  <input
                    type="text"
                    value={localService.description || ''}
                    onChange={(e) => setLocalService({ ...localService, description: e.target.value })}
                    className="input-field w-full"
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">
                  Batch Script / Command
                </label>
                <textarea
                  value={localService.command}
                  onChange={(e) => setLocalService({ ...localService, command: e.target.value })}
                  className="textarea-field w-full h-48"
                  placeholder="echo Hello World"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
