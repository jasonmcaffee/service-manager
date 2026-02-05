'use client'

import { useState } from 'react'
import { Plus, Zap, Skull } from 'lucide-react'

interface HeaderProps {
  onAddService: () => void
  runningCount: number
  totalCount: number
}

export function Header({ 
  onAddService, 
  runningCount,
  totalCount 
}: HeaderProps) {
  const [port, setPort] = useState('')
  const [isKilling, setIsKilling] = useState(false)
  const [killResult, setKillResult] = useState<{ success: boolean; message: string } | null>(null)

  const handleKillPort = async () => {
    if (!port.trim()) return
    
    setIsKilling(true)
    setKillResult(null)
    
    try {
      const res = await fetch('/api/kill-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: parseInt(port) }),
      })
      
      const data = await res.json()
      setKillResult({
        success: res.ok,
        message: data.message || (res.ok ? 'Process killed' : 'Failed to kill process'),
      })
      
      if (res.ok) {
        setPort('')
      }
      
      // Clear message after 3 seconds
      setTimeout(() => setKillResult(null), 3000)
    } catch (error: any) {
      setKillResult({ success: false, message: error.message })
      setTimeout(() => setKillResult(null), 3000)
    } finally {
      setIsKilling(false)
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/50 bg-surface-100/80 backdrop-blur-xl">
      <div className="w-full px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Logo and title - LEFT */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-accent-dim flex items-center justify-center shadow-lg shadow-accent/20">
              <Zap size={18} className="text-surface-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-zinc-100">Service Manager</h1>
              <p className="text-xs text-zinc-500">
                {runningCount} of {totalCount} running
              </p>
            </div>
          </div>

          {/* Kill Process section - CENTER */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-surface-200/50 rounded-lg px-3 py-1.5 border border-zinc-800/50">
              <Skull size={14} className="text-red-400" />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                placeholder="Port"
                className="w-20 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleKillPort()}
              />
              <button
                onClick={handleKillPort}
                disabled={isKilling || !port.trim()}
                className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                  isKilling || !port.trim()
                    ? 'bg-zinc-700/50 text-zinc-500 cursor-not-allowed'
                    : 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                }`}
              >
                {isKilling ? 'Killing...' : 'Kill'}
              </button>
            </div>
            
            {killResult && (
              <span className={`text-xs ${killResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {killResult.message}
              </span>
            )}
          </div>

          {/* Add Service button - RIGHT */}
          <button onClick={onAddService} className="btn-primary">
            <Plus size={18} />
            Add Service
          </button>
        </div>
      </div>
    </header>
  )
}
