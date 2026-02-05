'use client'

import { useState } from 'react'
import { Plus, Play, Square, RefreshCw, Zap } from 'lucide-react'

interface HeaderProps {
  onAddService: () => void
  onStartAll: () => void
  onStopAll: () => void
  onRefresh: () => void
  runningCount: number
  totalCount: number
}

export function Header({ 
  onAddService, 
  onStartAll, 
  onStopAll, 
  onRefresh,
  runningCount,
  totalCount 
}: HeaderProps) {
  const [isStartingAll, setIsStartingAll] = useState(false)

  const handleStartAll = async () => {
    setIsStartingAll(true)
    await onStartAll()
    setIsStartingAll(false)
  }

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/50 bg-surface-100/80 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          {/* Logo and title */}
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-accent-dim flex items-center justify-center shadow-lg shadow-accent/20">
              <Zap size={22} className="text-surface-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-zinc-100">Service Manager</h1>
              <p className="text-sm text-zinc-500">
                {runningCount} of {totalCount} services running
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button onClick={onRefresh} className="btn-ghost" title="Refresh">
              <RefreshCw size={18} />
            </button>
            
            <div className="w-px h-6 bg-zinc-700" />
            
            <button
              onClick={handleStartAll}
              disabled={isStartingAll}
              className="btn-success text-sm"
              title="Start all auto-start services"
            >
              <Play size={16} className={isStartingAll ? 'animate-pulse' : ''} />
              {isStartingAll ? 'Starting...' : 'Start All'}
            </button>
            
            <button onClick={onStopAll} className="btn-danger text-sm" title="Stop all services">
              <Square size={16} />
              Stop All
            </button>
            
            <div className="w-px h-6 bg-zinc-700" />
            
            <button onClick={onAddService} className="btn-primary">
              <Plus size={18} />
              Add Service
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
