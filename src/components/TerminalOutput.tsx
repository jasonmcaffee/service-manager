'use client'

import { useEffect, useRef } from 'react'
import { Trash2, ArrowDown } from 'lucide-react'

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

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      shouldAutoScroll.current = true
    }
  }

  return (
    <div className="relative h-64 rounded-lg overflow-hidden border border-zinc-800/50 bg-surface-300">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 py-2 bg-surface-200/90 backdrop-blur-sm border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-red-500/80" />
            <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <span className="w-3 h-3 rounded-full bg-green-500/80" />
          </div>
          <span className="text-xs text-zinc-500 font-mono ml-2">output</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={scrollToBottom}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={14} />
          </button>
          <button
            onClick={onClear}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 rounded transition-colors"
            title="Clear output"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Output content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full pt-10 pb-2 px-3 overflow-y-auto terminal-output text-zinc-300"
      >
        {output.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            {isLoading ? 'Starting service...' : 'No output yet'}
          </div>
        ) : (
          output.map((line, i) => (
            <div key={i} className="hover:bg-white/5 px-1 -mx-1 rounded">
              {line || '\u00A0'}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
