export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface Service {
  id: string
  name: string
  description: string | null
  command: string
  port: number | null
  // cudaDevice and startOnBoot are profile-specific, merged from the active RunProfile
  cudaDevice: string | null
  startOnBoot: boolean
  pid: number | null
  status: ServiceStatus
  createdAt: string
  updatedAt: string
  output?: string[]
}

export interface RunProfileService {
  id: string
  profileId: string
  serviceId: string
  cudaDevice: string | null
  startOnBoot: boolean
}

export interface RunProfile {
  id: string
  name: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  services: RunProfileService[]
}
