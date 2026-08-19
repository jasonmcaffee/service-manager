'use client'

import { useState, useEffect, useCallback, memo } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Service, RunProfile } from '@/types/service'
import { ServiceCard } from '@/components/ServiceCard'
import { AddServiceModal } from '@/components/AddServiceModal'
import { EditServiceModal } from '@/components/EditServiceModal'
import { Header } from '@/components/Header'
import { useServiceOrder } from '@/hooks/useServiceOrder'
import { useCollapsedServices } from '@/hooks/useCollapsedServices'
import { Loader2, ServerOff } from 'lucide-react'

interface SortableServiceCardProps {
  service: Service
  isCollapsed: boolean
  onToggleCollapse: () => void
  onUpdate: (service: Service) => void
  onPatch: (patch: Partial<Service> & { id: string }) => void
  onEditClick: (service: Service) => void
}

/** Wraps ServiceCard with dnd-kit sortable behaviour. Memoized to prevent sibling re-renders. */
const SortableServiceCard = memo(function SortableServiceCard({ service, isCollapsed, onToggleCollapse, onUpdate, onPatch, onEditClick }: SortableServiceCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: service.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <ServiceCard
        service={service}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onUpdate={onUpdate}
        onPatch={onPatch}
        onEditClick={onEditClick}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  )
}, (prev, next) => {
  // Only re-render when this card's own data or collapse state changes.
  // Callback references are deliberately excluded — they are re-created on each
  // parent render but their identity doesn't affect the rendered output.
  return (
    prev.service.id === next.service.id &&
    prev.service.status === next.service.status &&
    prev.service.pid === next.service.pid &&
    prev.service.port === next.service.port &&
    prev.service.noPort === next.service.noPort &&
    prev.service.wsl === next.service.wsl &&
    prev.service.name === next.service.name &&
    prev.service.description === next.service.description &&
    prev.service.command === next.service.command &&
    prev.service.cudaDevice === next.service.cudaDevice &&
    prev.service.startOnBoot === next.service.startOnBoot &&
    prev.service.autoRestart === next.service.autoRestart &&
    prev.isCollapsed === next.isCollapsed
  )
})

export default function Home() {
  const [services, setServices] = useState<Service[]>([])
  const [profiles, setProfiles] = useState<RunProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<RunProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingService, setEditingService] = useState<Service | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { orderedServices, setOrder } = useServiceOrder(services)
  const { isCollapsed, toggle: toggleCollapse } = useCollapsedServices()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const fetchServices = useCallback(async () => {
    try {
      const res = await fetch('/api/services')
      if (res.ok) {
        const data = await res.json()
        setServices(data)
        setError(null)
      } else {
        throw new Error('Failed to fetch services')
      }
    } catch (error: any) {
      setError(error.message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch('/api/profiles')
      if (res.ok) {
        const data: RunProfile[] = await res.json()
        setProfiles(data)
        setActiveProfile(data.find(p => p.isActive) ?? null)
      }
    } catch {
      // profiles are non-critical for initial render
    }
  }, [])

  useEffect(() => {
    const triggerStartup = async () => {
      try {
        await fetch('/api/services/startup', { method: 'POST' })
      } catch (error) {
        console.error('Failed to trigger startup services:', error)
      }
    }
    triggerStartup()
  }, [])

  useEffect(() => {
    fetchServices()
    fetchProfiles()
    const interval = setInterval(fetchServices, 2000)
    return () => clearInterval(interval)
  }, [fetchServices, fetchProfiles])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedServices.findIndex(s => s.id === active.id)
    const newIndex = orderedServices.findIndex(s => s.id === over.id)
    const reordered = arrayMove(orderedServices, oldIndex, newIndex)
    setOrder(reordered.map(s => s.id))
  }

  const handleSwitchProfile = async (profileId: string) => {
    try {
      const res = await fetch('/api/profiles/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      })
      if (res.ok) {
        await fetchProfiles()
        await fetchServices()
      }
    } catch (error) {
      console.error('Failed to switch profile:', error)
    }
  }

  const handleRenameProfile = async (profileId: string, name: string) => {
    try {
      const res = await fetch(`/api/profiles/${profileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) await fetchProfiles()
    } catch (error) {
      console.error('Failed to rename profile:', error)
    }
  }

  const handleCreateProfile = async () => {
    const name = prompt('New profile name:')
    if (!name?.trim()) return
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (res.ok) await fetchProfiles()
    } catch (error) {
      console.error('Failed to create profile:', error)
    }
  }

  // These three handlers must use functional setState so they don't close over a
  // stale `services` snapshot. Memoized SortableServiceCard caches its props,
  // including the version of `handleUpdateService` from its last render; without
  // useCallback + functional updater, firing onUpdate could overwrite the array
  // with stale data and visually revert every sibling card for one paint cycle.
  const handleAddService = useCallback((service: Service) => {
    setServices(prev => [...prev, service])
  }, [])

  const handleUpdateService = useCallback((updated: Service) => {
    setServices(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
  }, [])

  /** Applies a partial patch to a single card without refetching all services. */
  const applyServicePatch = useCallback((patch: Partial<Service> & { id: string }) => {
    setServices(prev => prev.map(s => s.id === patch.id ? { ...s, ...patch } : s))
  }, [])

  const handleDeleteService = useCallback((id: string) => {
    setServices(prev => prev.filter(s => s.id !== id))
  }, [])

  const runningCount = services.filter(s => s.status === 'running').length

  return (
    <div className="min-h-screen">
      <Header
        onAddService={() => setIsAddModalOpen(true)}
        runningCount={runningCount}
        totalCount={services.length}
        profiles={profiles}
        activeProfile={activeProfile}
        onSwitchProfile={handleSwitchProfile}
        onCreateProfile={handleCreateProfile}
        onRenameProfile={handleRenameProfile}
      />

      <main className="w-full px-4 py-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 size={40} className="text-accent animate-spin" />
            <p className="mt-4 text-zinc-500">Loading services...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <ServerOff size={32} className="text-red-400" />
            </div>
            <p className="text-red-400 mb-2">Failed to load services</p>
            <p className="text-zinc-500 text-sm">{error}</p>
          </div>
        ) : services.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-20 h-20 rounded-2xl bg-zinc-800/50 flex items-center justify-center mb-6">
              <ServerOff size={40} className="text-zinc-600" />
            </div>
            <h2 className="text-xl font-semibold text-zinc-300 mb-2">No services yet</h2>
            <p className="text-zinc-500 mb-6">Add your first service to get started</p>
            <button onClick={() => setIsAddModalOpen(true)} className="btn-primary">
              Add Your First Service
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedServices.map(s => s.id)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {orderedServices.map(service => (
                  <SortableServiceCard
                    key={service.id}
                    service={service}
                    isCollapsed={isCollapsed(service.id)}
                    onToggleCollapse={() => toggleCollapse(service.id)}
                    onUpdate={handleUpdateService}
                    onPatch={applyServicePatch}
                    onEditClick={setEditingService}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>

      <AddServiceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAdd={handleAddService}
      />

      <EditServiceModal
        service={editingService}
        isOpen={editingService !== null}
        activeProfileId={activeProfile?.id ?? null}
        onClose={() => setEditingService(null)}
        onSave={handleUpdateService}
        onDelete={handleDeleteService}
      />
    </div>
  )
}
