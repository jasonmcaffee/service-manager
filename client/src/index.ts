export interface ServiceResponse {
  id: string
  name: string
  description: string | null
  command: string
  port: number | null
  cudaDevice: string | null
  startOnBoot: boolean
  status: 'running' | 'stopped' | 'error' | 'starting'
  pid: number | null
  createdAt: string
  updatedAt: string
}

export interface ProfileServiceEntry {
  id: string
  profileId: string
  serviceId: string
  cudaDevice: string | null
  startOnBoot: boolean
  service: {
    name: string
    port: number | null
  }
}

export interface ProfileResponse {
  id: string
  name: string
  isActive: boolean
  services: ProfileServiceEntry[]
  createdAt: string
  updatedAt: string
}

export class ServiceManagerError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'ServiceManagerError'
  }
}

export class ServiceManagerClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      throw new ServiceManagerError(body.error ?? res.statusText, res.status)
    }
    return res.json() as Promise<T>
  }

  listServices(): Promise<ServiceResponse[]> {
    return this.request<ServiceResponse[]>('/api/services')
  }

  listProfiles(): Promise<ProfileResponse[]> {
    return this.request<ProfileResponse[]>('/api/profiles')
  }

  getActiveProfile(): Promise<ProfileResponse> {
    return this.request<ProfileResponse>('/api/profiles/active')
  }

  switchProfile(profileId: string): Promise<ProfileResponse> {
    return this.request<ProfileResponse>('/api/profiles/active', {
      method: 'PUT',
      body: JSON.stringify({ profileId }),
    })
  }

  async startService(serviceId: string): Promise<void> {
    await this.request(`/api/services/${serviceId}/control`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    })
  }

  async stopService(serviceId: string): Promise<void> {
    await this.request(`/api/services/${serviceId}/control`, {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    })
  }
}
