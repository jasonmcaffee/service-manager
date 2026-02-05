'use client'

import { ServiceStatus } from '@/types/service'

interface StatusBadgeProps {
  status: ServiceStatus
  pid?: number
}

const statusConfig = {
  running: {
    color: 'bg-green-500',
    text: 'Running',
    textColor: 'text-green-400',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
  },
  stopped: {
    color: 'bg-zinc-500',
    text: 'Stopped',
    textColor: 'text-zinc-400',
    bgColor: 'bg-zinc-500/10',
    borderColor: 'border-zinc-500/30',
  },
  starting: {
    color: 'bg-amber-500',
    text: 'Starting',
    textColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30',
  },
  error: {
    color: 'bg-red-500',
    text: 'Error',
    textColor: 'text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30',
  },
}

export function StatusBadge({ status, pid }: StatusBadgeProps) {
  const config = statusConfig[status]

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border ${config.bgColor} ${config.borderColor}`}>
      <span className="relative flex h-2.5 w-2.5">
        {status === 'running' && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75 animate-ping`} />
        )}
        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.color}`} />
      </span>
      <span className={`text-xs font-medium ${config.textColor}`}>
        {config.text}
        {pid && status === 'running' && (
          <span className="ml-1 opacity-60">PID: {pid}</span>
        )}
      </span>
    </div>
  )
}
