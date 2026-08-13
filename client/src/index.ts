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

/** The effective configuration of a service at a point in time (task-1523). */
export interface ConfigSnapshot {
  name: string
  description: string | null
  command: string
  port: number | null
  noPort: boolean
  wsl: boolean
  minFreeVramMb: number | null
  profileId: string | null
  profileName: string | null
  cudaDevice: string | null
  startOnBoot: boolean
}

export interface ConfigRevisionResponse {
  id: string
  serviceId: string
  serviceName: string
  profileId: string | null
  profileName: string | null
  changeType: 'create' | 'update' | 'delete' | 'revert' | 'baseline'
  author: string
  reason: string
  snapshot: ConfigSnapshot | null
  previous: ConfigSnapshot | null
  changedFields: Array<{ field: string; from: unknown; to: unknown }>
  revertedFromRevisionId: string | null
  createdAt: string
}

/** Fields a caller may change. Everything here is audited. */
export interface UpdateServiceFields {
  name?: string
  description?: string | null
  command?: string
  port?: number | null
  noPort?: boolean
  wsl?: boolean
  minFreeVramMb?: number | null
  cudaDevice?: string | null
  startOnBoot?: boolean
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

  /**
   * Changes a service's configuration. The reason is mandatory — the server rejects
   * an unexplained change with 400 — and is stored in the service's change log with
   * the full before/after config (task-1523).
   * @param serviceId - the service to change
   * @param fields - the configuration fields to change
   * @param reason - why the configuration is changing
   */
  updateService(serviceId: string, fields: UpdateServiceFields, reason: string): Promise<ServiceResponse> {
    return this.request<ServiceResponse>(`/api/services/${serviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...fields, reason }),
    })
  }

  /**
   * Reads a service's configuration change log, newest first.
   * @param serviceId - the service whose history to read
   * @param limit - maximum revisions to return
   */
  async listRevisions(serviceId: string, limit?: number): Promise<ConfigRevisionResponse[]> {
    const query = limit ? `?limit=${limit}` : ''
    const body = await this.request<{ revisions: ConfigRevisionResponse[] }>(`/api/services/${serviceId}/revisions${query}`)
    return body.revisions
  }

  /**
   * Restores the configuration captured by an earlier revision, as a new recorded
   * change. Does not start or stop the service.
   * @param serviceId - the service to restore
   * @param revisionId - the revision whose config to apply
   * @param reason - why we are reverting
   */
  revertRevision(serviceId: string, revisionId: string, reason: string): Promise<{ service: ServiceResponse; revertedFrom: string; crossProfile: boolean; warning: string | null }> {
    return this.request(`/api/services/${serviceId}/revisions/${revisionId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
  }
}
