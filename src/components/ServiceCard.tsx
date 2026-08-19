'use client'

import { useState, useEffect, useCallback } from 'react'
import { Service } from '@/types/service'
import { StatusBadge } from './StatusBadge'
import { TerminalOutput } from './TerminalOutput'
import { ReasonPrompt } from './ReasonPrompt'
import { Settings, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react'

interface ServiceCardProps {
  service: Service
  isCollapsed: boolean
  onToggleCollapse: () => void
  onUpdate: (service: Service) => void
  onPatch: (patch: Partial<Service> & { id: string }) => void
  onEditClick: (service: Service) => void
  dragHandleProps?: Record<string, any>
}

/** A flag flip waiting on its reason before it is sent. */
interface PendingToggle {
  field: 'wsl' | 'noPort' | 'startOnBoot' | 'autoRestart'
  label: string
  next: boolean
}

export function ServiceCard({ service, isCollapsed, onToggleCollapse, onUpdate, onPatch, onEditClick, dragHandleProps }: ServiceCardProps) {
  const [output, setOutput] = useState<string[]>([])
  // Service-Manager events that outlive the run log: why the last run ended, refused
  // starts, profile-switch stops, auto-restart attempts (task-1593).
  const [events, setEvents] = useState<string[]>([])
  const [isEventsOpen, setIsEventsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [isTogglePending, setIsTogglePending] = useState(false)

  const fetchOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${service.id}/output`)
      if (res.ok) {
        const data = await res.json()
        setOutput(data.output || [])
        setEvents(data.events || [])
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
        const result = await res.json()
        // Patch only this card — no full grid refetch
        onPatch({ id: service.id, status: result.status, pid: result.pid ?? null })
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

  /**
   * Sends the pending toggle with the reason the user just gave. A one-click flag flip
   * is still a configuration change, so it takes the same route (and the same audit
   * entry) as an edit in the settings modal.
   * @param reason - why this flag is being flipped
   */
  const handleConfirmToggle = async (reason: string) => {
    if (!pendingToggle) return
    setIsTogglePending(true)
    setToggleError(null)
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [pendingToggle.field]: pendingToggle.next, reason }),
      })
      if (!res.ok) {
        setToggleError((await res.json().catch(() => null))?.error ?? 'Failed to update service')
        return
      }
      const data = await res.json()
      onUpdate(data)
      setPendingToggle(null)
    } catch (error: any) {
      console.error('Failed to update service:', error)
      setToggleError(error?.message ?? 'Failed to update service')
    } finally {
      setIsTogglePending(false)
    }
  }

  const isRunning = service.status === 'running'
  const isStarting = service.status === 'starting'
  // noPort services: treat error state as stopped visually (scheduler/daemon with no port binding)
  const displayStatus = (service.noPort && service.status === 'error') ? 'stopped' : service.status
  const showPortWarning = service.port == null && !service.noPort

  return (
    <div
      className={`card flex flex-col transition-all duration-300 animate-fade-in ${
        isRunning ? 'glow-success' : ''
      } ${displayStatus === 'error' ? 'glow-error' : ''}`}
    >
      {/* Header — drag handle area */}
      <div
        className="p-3 flex items-center gap-3 border-b border-zinc-800/50 cursor-grab active:cursor-grabbing"
        {...dragHandleProps}
      >
        {/* Power button */}
        <button
          onClick={e => { e.stopPropagation(); handleTogglePower() }}
          disabled={isLoading || isStarting}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${
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

        {/* Collapse toggle */}
        <button
          onClick={e => { e.stopPropagation(); onToggleCollapse() }}
          className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded transition-colors"
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>

        {/* Edit button */}
        <button
          onClick={e => { e.stopPropagation(); onEditClick(service) }}
          className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded transition-colors"
          title="Edit settings"
        >
          <Settings size={14} />
        </button>
      </div>

      {/* Status bar */}
      <div className="px-3 py-2 flex items-center justify-between bg-surface-200/50 border-b border-zinc-800/30">
        <div className="flex items-center gap-2">
          <StatusBadge status={displayStatus || 'stopped'} pid={service.pid ?? undefined} />
          {showPortWarning && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/30"
              title="No port configured — service won't be auto-adopted on restart. Set a port in Edit."
            >
              <AlertTriangle size={10} />
              no port
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setToggleError(null); setPendingToggle({ field: 'wsl', label: 'WSL mode', next: !service.wsl }) }}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
              service.wsl
                ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
            }`}
            title={service.wsl ? 'WSL service: health checked via WSL port map only' : 'Enable for services running inside WSL'}
          >
            WSL
          </button>
          <button
            onClick={() => { setToggleError(null); setPendingToggle({ field: 'noPort', label: 'No-port mode', next: !service.noPort }) }}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
              service.noPort
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
            }`}
            title={service.noPort ? 'No-port mode: service runs without a port' : 'Enable no-port mode for services with no HTTP port'}
          >
            No-port
          </button>
          <button
            onClick={() => { setToggleError(null); setPendingToggle({ field: 'startOnBoot', label: 'Start on boot', next: !service.startOnBoot }) }}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
              service.startOnBoot
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
            }`}
            title={service.startOnBoot ? 'Starts on boot' : 'Does not start on boot'}
          >
            Auto-start
          </button>
          <button
            onClick={() => { setToggleError(null); setPendingToggle({ field: 'autoRestart', label: 'Auto-restart', next: !service.autoRestart }) }}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
              service.autoRestart
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:border-zinc-600'
            }`}
            title={service.autoRestart
              ? 'Comes back on its own if it dies. A deliberate Stop still keeps it stopped.'
              : 'Stays down if it dies — nothing will restart it'}
          >
            Auto-restart
          </button>
        </div>
      </div>

      {/* Service Manager's own history for this service. Kept out of the terminal because
          it is not the service's output — and kept at all because every start truncates
          the run log, which used to erase the note explaining the death that preceded it. */}
      {!isCollapsed && events.length > 0 && (
        <div className="px-3 pt-2">
          <button
            onClick={() => setIsEventsOpen(v => !v)}
            className="w-full text-left text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {isEventsOpen ? '▾' : '▸'} Service Manager events ({events.length})
          </button>
          {isEventsOpen && (
            <div className="mt-1 max-h-28 overflow-y-auto rounded bg-zinc-900/60 border border-zinc-800 p-2 space-y-0.5">
              {events.map((line, i) => (
                <div key={i} className="text-[10px] font-mono text-zinc-400 break-words">{line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Terminal output — hidden when collapsed */}
      {!isCollapsed && (
        <div className="p-3 h-[280px]">
          <TerminalOutput
            output={output}
            onClear={handleClearOutput}
            isLoading={isStarting}
          />
        </div>
      )}

      <ReasonPrompt
        isOpen={pendingToggle !== null}
        title={`${pendingToggle?.next ? 'Enable' : 'Disable'} ${pendingToggle?.label ?? ''}`}
        summary={`Changing "${service.name}" — ${pendingToggle?.label} ${pendingToggle?.next ? 'on' : 'off'}.`}
        confirmLabel="Apply change"
        error={toggleError}
        isBusy={isTogglePending}
        onCancel={() => setPendingToggle(null)}
        onConfirm={handleConfirmToggle}
      />
    </div>
  )
}
