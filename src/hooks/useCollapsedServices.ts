import { useState, useCallback } from 'react'

const STORAGE_KEY = 'service-manager:collapsed'

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveCollapsed(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* storage may be disabled */ }
}

/**
 * Tracks per-service collapsed state, persisted to localStorage.
 * isCollapsed returns true when a service card's terminal should be hidden.
 * toggle flips the state for a single service.
 */
export function useCollapsedServices(): {
  isCollapsed: (id: string) => boolean
  toggle: (id: string) => void
} {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed())

  const toggle = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [id]: !prev[id] }
      saveCollapsed(next)
      return next
    })
  }, [])

  const isCollapsed = useCallback((id: string) => !!collapsed[id], [collapsed])

  return { isCollapsed, toggle }
}
