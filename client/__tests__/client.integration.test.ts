import { ServiceManagerClient, ServiceManagerError } from '../src/index'

const BASE_URL = process.env.SERVICE_MANAGER_URL ?? 'http://localhost:4000'
const client = new ServiceManagerClient(BASE_URL)

let serverAvailable = false

beforeAll(async () => {
  try {
    await fetch(`${BASE_URL}/api/services`)
    serverAvailable = true
  } catch {
    console.warn(`⚠️  Service manager not running at ${BASE_URL} — skipping integration tests`)
  }
})

function skipIfOffline() {
  if (!serverAvailable) {
    return true
  }
  return false
}

describe('ServiceManagerClient - listServices', () => {
  it('returns an array with correct shape', async () => {
    if (skipIfOffline()) return
    const services = await client.listServices()
    expect(Array.isArray(services)).toBe(true)
    if (services.length > 0) {
      const svc = services[0]
      expect(svc).toHaveProperty('id')
      expect(svc).toHaveProperty('name')
      expect(svc).toHaveProperty('command')
      expect(svc).toHaveProperty('port')
      expect(svc).toHaveProperty('cudaDevice')
      expect(svc).toHaveProperty('status')
      expect(svc).toHaveProperty('startOnBoot')
    }
  })
})

describe('ServiceManagerClient - listProfiles', () => {
  it('returns profiles with services containing name, port, cudaDevice', async () => {
    if (skipIfOffline()) return
    const profiles = await client.listProfiles()
    expect(Array.isArray(profiles)).toBe(true)
    expect(profiles.length).toBeGreaterThan(0)

    const profile = profiles[0]
    expect(profile).toHaveProperty('id')
    expect(profile).toHaveProperty('name')
    expect(profile).toHaveProperty('isActive')
    expect(Array.isArray(profile.services)).toBe(true)

    if (profile.services.length > 0) {
      const entry = profile.services[0]
      expect(entry).toHaveProperty('cudaDevice')
      expect(entry).toHaveProperty('startOnBoot')
      expect(entry).toHaveProperty('service')
      expect(entry.service).toHaveProperty('name')
      expect(entry.service).toHaveProperty('port')
    }
  })
})

describe('ServiceManagerClient - getActiveProfile', () => {
  it('returns the active profile', async () => {
    if (skipIfOffline()) return
    const profile = await client.getActiveProfile()
    expect(profile).toHaveProperty('id')
    expect(profile).toHaveProperty('name')
    expect(profile.isActive).toBe(true)
    expect(Array.isArray(profile.services)).toBe(true)
  })
})

describe('ServiceManagerClient - switchProfile', () => {
  it('throws ServiceManagerError with status 404 for unknown profile id', async () => {
    if (skipIfOffline()) return
    await expect(client.switchProfile('nonexistent-id-xyz')).rejects.toThrow(ServiceManagerError)
    await expect(client.switchProfile('nonexistent-id-xyz')).rejects.toMatchObject({ status: 404 })
  })

  it('switches to the active profile and returns it', async () => {
    if (skipIfOffline()) return
    const active = await client.getActiveProfile()
    const result = await client.switchProfile(active.id)
    expect(result.id).toBe(active.id)
    expect(result.isActive).toBe(true)
  })
})
