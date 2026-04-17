'use client'

import { useState } from 'react'
import { Plus, Zap, Skull, ChevronDown, PlusCircle } from 'lucide-react'
import { RunProfile } from '@/types/service'

interface HeaderProps {
  onAddService: () => void
  runningCount: number
  totalCount: number
  profiles: RunProfile[]
  activeProfile: RunProfile | null
  onSwitchProfile: (profileId: string) => void
  onCreateProfile: () => void
  onRenameProfile: (profileId: string, name: string) => void
}

export function Header({
  onAddService,
  runningCount,
  totalCount,
  profiles,
  activeProfile,
  onSwitchProfile,
  onCreateProfile,
  onRenameProfile,
}: HeaderProps) {
  const [port, setPort] = useState('')
  const [isKilling, setIsKilling] = useState(false)
  const [killResult, setKillResult] = useState<{ success: boolean; message: string } | null>(null)
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

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

      if (res.ok) setPort('')
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

          {/* Center controls */}
          <div className="flex items-center gap-3">
            {/* Profile selector */}
            <div className="relative flex items-center gap-1">
              <div className="relative">
                <button
                  onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
                  className="flex items-center gap-2 bg-surface-200/50 rounded-lg px-3 py-1.5 border border-zinc-800/50 text-sm text-zinc-200 hover:border-zinc-700 transition-colors"
                >
                  <span className="text-zinc-400 text-xs">Profile:</span>
                  <span className="max-w-[160px] truncate">{activeProfile?.name ?? '…'}</span>
                  <ChevronDown size={14} className="text-zinc-500 shrink-0" />
                </button>

                {profileDropdownOpen && (
                  <div className="absolute top-full mt-1 left-0 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 py-1">
                    {profiles.map(p => (
                      <div key={p.id} className="flex items-center group px-2 py-1 hover:bg-zinc-800 transition-colors">
                        {renamingId === p.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && renameValue.trim()) {
                                onRenameProfile(p.id, renameValue.trim())
                                setRenamingId(null)
                              } else if (e.key === 'Escape') {
                                setRenamingId(null)
                              }
                            }}
                            onBlur={() => {
                              if (renameValue.trim()) onRenameProfile(p.id, renameValue.trim())
                              setRenamingId(null)
                            }}
                            className="flex-1 bg-zinc-800 border border-accent/50 rounded px-2 py-0.5 text-sm text-zinc-100 outline-none"
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <button
                              className={`flex-1 text-left px-1 py-1 text-sm ${p.isActive ? 'text-accent font-medium' : 'text-zinc-300'}`}
                              onClick={() => {
                                setProfileDropdownOpen(false)
                                if (p.id !== activeProfile?.id) onSwitchProfile(p.id)
                              }}
                            >
                              {p.isActive && <span className="mr-1.5">✓</span>}
                              {p.name}
                            </button>
                            <button
                              title="Rename"
                              className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-zinc-200 transition-all text-xs"
                              onClick={e => {
                                e.stopPropagation()
                                setRenamingId(p.id)
                                setRenameValue(p.name)
                              }}
                            >
                              ✎
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={onCreateProfile}
                title="Clone current profile"
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border border-zinc-800/50"
              >
                <PlusCircle size={16} />
              </button>
            </div>

            {/* Kill Process */}
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

      {/* Close dropdown on outside click */}
      {profileDropdownOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setProfileDropdownOpen(false)} />
      )}
    </header>
  )
}
