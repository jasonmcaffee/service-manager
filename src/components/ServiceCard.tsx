'use client'

import { useState, useEffect, useCallback } from 'react'
import { Service } from '@/types/service'
import { StatusBadge } from './StatusBadge'
import { TerminalOutput } from './TerminalOutput'
import { Settings } from 'lucide-react'

interface ServiceCardProps {
  service: Service
  onUpdate: (service: Service) => void
  onRefresh: () => void
  onEditClick: (service: Service) => void
}

export function ServiceCard({ service, onUpdate, onRefresh, onEditClick }: ServiceCardProps) {
  const [output, setOutput] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Fetch output periodically
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
    fetchOutput()
    const interval = setInterval(fetchOutput, 1000)
    return () => clearInterval(interval)
  }, [fetchOutput])

  const handleTogglePower = async () => {
    const action = isRunning ? 'stop' : 'start'
    setIsLoading(true)
    try {
      const res = await fetch(`/api/services/${service.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        onRefresh()
      }
    } catch (error) {
      console.error(`Failed to ${action} service:`, error)
    } finally {
      setIsLoading(false)
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
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...service, startOnBoot: !service.startOnBoot }),
      })
      if (res.ok) {
        const data = await res.json()
        onUpdate(data)
      }
    } catch (error) {
      console.error('Failed to update service:', error)
    }
  }

  const isRunning = service.status === 'running'
  const isStarting = service.status === 'starting'

  return (
    <div 
      className={`card flex flex-col transition-all duration-300 animate-fade-in ${
        isRunning ? 'glow-success' : ''
      } ${service.status === 'error' ? 'glow-error' : ''}`}
    >
      {/* Header */}
      <div className="p-3 flex items-center gap-3 border-b border-zinc-800/50">
        {/* Power button - Start/Stop */}
        <button
          onClick={handleTogglePower}
          disabled={isLoading || isStarting}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
            isRunning 
              ? 'bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400' 
              : 'bg-zinc-700/30 text-zinc-500 hover:bg-green-500/20 hover:text-green-400'
          } ${isLoading || isStarting ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
          title={isRunning ? 'Stop service' : 'Start service'}
        >
          <svg 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            className={`w-4 h-4 ${isStarting ? 'animate-pulse' : ''}`}
          >
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        </button>
        
        {/* Name and description */}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm text-zinc-100 truncate">{service.name}</h3>
          {service.description && (
            <p className="text-xs text-zinc-500 truncate">{service.description}</p>
          )}
        </div>

        {/* Edit button */}
        <button
          onClick={() => onEditClick(service)}
          className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded transition-colors"
          title="Edit settings"
        >
          <Settings size={14} />
        </button>
      </div>

      {/* Status bar */}
      <div className="px-3 py-2 flex items-center justify-between bg-surface-200/50 border-b border-zinc-800/30">
        <StatusBadge status={service.status || 'stopped'} pid={service.pid ?? undefined} />
        
        <button
          onClick={handleToggleStartOnBoot}
          className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
            service.startOnBoot
              ? 'bg-accent/20 text-accent border border-accent/30'
              : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
          }`}
          title={service.startOnBoot ? 'Starts on boot' : 'Does not start on boot'}
        >
          Auto-start
        </button>
      </div>

      {/* Terminal output - always visible, fixed height */}
      <div className="p-3 h-[280px]">
        <TerminalOutput 
          output={output} 
          onClear={handleClearOutput}
          isLoading={isStarting}
        />
      </div>
    </div>
  )
}
