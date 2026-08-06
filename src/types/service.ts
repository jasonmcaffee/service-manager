export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface Service {
  id: string
  name: string
  description: string | null
  command: string
  port: number | null
  noPort: boolean
  wsl: boolean
  // cudaDevice and startOnBoot are profile-specific, merged from the active RunProfile.
  // cudaDevice is the EFFECTIVE device — a pin the start command hard-codes wins over
  // the registration, because that is the card the process actually gets (task-1493).
  cudaDevice: string | null
  /** The stored (profile) value, kept separate so a disagreement stays visible. */
  registeredCudaDevice?: string | null
  /** Where the effective cudaDevice came from. */
  cudaDeviceSource?: 'command' | 'profile'
  /** Explanation shown when the registration and the command disagree, else null. */
  cudaDeviceConflict?: string | null
  minFreeVramMb?: number | null
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
