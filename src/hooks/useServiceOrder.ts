import { useState, useCallback } from 'react'
import { Service } from '@/types/service'

const STORAGE_KEY = 'service-manager:order'

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch { /* storage may be disabled */ }
}

/**
 * Sorts services by a persisted localStorage order, appending unknown IDs
 * (newly created services) at the end. Exposes setOrder to persist a new arrangement.
 * @param services - raw service list from the API
 */
export function useServiceOrder(services: Service[]): {
  orderedServices: Service[]
  setOrder: (newIds: string[]) => void
} {
  const [order, setOrderState] = useState<string[]>(() => loadOrder())

  const setOrder = useCallback((newIds: string[]) => {
    setOrderState(newIds)
    saveOrder(newIds)
  }, [])

  const orderedServices = [...services].sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1   // unknown IDs go to the end
    if (bi === -1) return -1
    return ai - bi
  })

  return { orderedServices, setOrder }
}
