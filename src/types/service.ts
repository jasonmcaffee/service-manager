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
  /** Profile-scoped: bring this service back automatically if its process dies. */
  autoRestart: boolean
  pid: number | null
  status: ServiceStatus
  /** What the service is meant to be doing — 'running' unless deliberately stopped. */
  desiredStatus?: string
  createdAt: string
  updatedAt: string
  output?: string[]
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
  /** Which profile the profile-scoped fields below were read from. */
  profileId: string | null
  profileName: string | null
  cudaDevice: string | null
  startOnBoot: boolean
  autoRestart: boolean
}

/** One field that differed between two snapshots. */
export interface ChangedField {
  field: string
  from: unknown
  to: unknown
}

export type ConfigChangeType = 'create' | 'update' | 'delete' | 'revert' | 'baseline'

/** An immutable record of one configuration change, as served to the UI. */
export interface ConfigRevision {
  id: string
  serviceId: string
  serviceName: string
  profileId: string | null
  profileName: string | null
  changeType: ConfigChangeType
  author: string
  reason: string
  snapshot: ConfigSnapshot | null
  previous: ConfigSnapshot | null
  changedFields: ChangedField[]
  revertedFromRevisionId: string | null
  createdAt: string
}

export interface RunProfileService {
  id: string
  profileId: string
  serviceId: string
  cudaDevice: string | null
  startOnBoot: boolean
  autoRestart: boolean
}

export interface RunProfile {
  id: string
  name: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  services: RunProfileService[]
}
