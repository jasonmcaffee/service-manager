'use client'

import { useState, useEffect, useCallback } from 'react'
import { Service, RunProfile } from '@/types/service'
import { ServiceCard } from '@/components/ServiceCard'
import { AddServiceModal } from '@/components/AddServiceModal'
import { EditServiceModal } from '@/components/EditServiceModal'
import { Header } from '@/components/Header'
import { Loader2, ServerOff } from 'lucide-react'

export default function Home() {
  const [services, setServices] = useState<Service[]>([])
  const [profiles, setProfiles] = useState<RunProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<RunProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingService, setEditingService] = useState<Service | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const handleAddService = (service: Service) => {
    setServices([...services, service])
  }

  const handleUpdateService = (updated: Service) => {
    setServices(services.map(s => s.id === updated.id ? { ...s, ...updated } : s))
    // Refresh services to get latest profile-merged values
    fetchServices()
  }

  const handleDeleteService = (id: string) => {
    setServices(services.filter(s => s.id !== id))
  }

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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {services.map((service, index) => (
              <div
                key={service.id}
                style={{ animationDelay: `${index * 50}ms` }}
                className="animate-fade-in"
              >
                <ServiceCard
                  service={service}
                  onUpdate={handleUpdateService}
                  onRefresh={fetchServices}
                  onEditClick={setEditingService}
                />
              </div>
            ))}
          </div>
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
