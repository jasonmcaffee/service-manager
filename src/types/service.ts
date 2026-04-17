export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface Service {
  id: string
  name: string
  description: string | null
  command: string
  startOnBoot: boolean
  port: number | null
  cudaDevice: string | null
  pid: number | null
  status: ServiceStatus
  createdAt: string
  updatedAt: string
  output?: string[]
}
