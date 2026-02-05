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
  },
  stopped: {
    color: 'bg-zinc-500',
    text: 'Stopped',
    textColor: 'text-zinc-500',
  },
  starting: {
    color: 'bg-amber-500',
    text: 'Starting',
    textColor: 'text-amber-400',
  },
  error: {
    color: 'bg-red-500',
    text: 'Error',
    textColor: 'text-red-400',
  },
}

export function StatusBadge({ status, pid }: StatusBadgeProps) {
  const config = statusConfig[status]

  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {status === 'running' && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75 animate-ping`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.color}`} />
      </span>
      <span className={`text-[10px] font-medium ${config.textColor}`}>
        {config.text}
        {pid && status === 'running' && (
          <span className="ml-1 opacity-60">:{pid}</span>
        )}
      </span>
    </div>
  )
}
