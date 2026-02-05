'use client'

import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'

interface TerminalOutputProps {
  output: string[]
  onClear: () => void
  isLoading?: boolean
}

export function TerminalOutput({ output, onClear, isLoading }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [output])

  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current
      shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50
    }
  }

  return (
    <div className="relative h-full rounded-lg overflow-hidden border border-zinc-800/50 bg-surface-300 flex flex-col">
      {/* Clear button */}
      <button
        onClick={onClear}
        className="absolute top-2 right-2 z-10 p-1.5 text-zinc-600 hover:text-zinc-400 hover:bg-zinc-700/50 rounded transition-colors"
        title="Clear output"
      >
        <Trash2 size={12} />
      </button>

      {/* Output content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 p-3 overflow-y-auto terminal-output text-zinc-400 text-[11px]"
      >
        {output.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
            {isLoading ? 'Starting...' : 'No output'}
          </div>
        ) : (
          output.map((line, i) => (
            <div key={i} className="hover:bg-white/5 leading-relaxed">
              {line || '\u00A0'}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
