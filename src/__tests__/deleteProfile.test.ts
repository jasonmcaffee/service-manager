const mockProfileRepo = {
  findById: jest.fn(async (_id: string) => null as any),
  count: jest.fn(async () => 2),
  delete: jest.fn(async (_id: string) => {}),
  findAll: jest.fn(async () => [] as any[]),
  findActive: jest.fn(async () => null as any),
  backfillProfileServices: jest.fn(async () => 0),
}

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: mockProfileRepo,
}))

jest.mock('@/lib/process-manager', () => ({ processManager: {} }))
jest.mock('@/lib/repositories/serviceRepository', () => ({ serviceRepository: { findAll: jest.fn(async () => []) } }))
jest.mock('@/lib/services/serviceService', () => ({ serviceService: {} }))
jest.mock('@/lib/services/init', () => ({
  initializeIfNeeded: jest.fn(async () => {}),
  ensureDefaultProfile: jest.fn(async () => {}),
}))

import { runProfileService } from '@/lib/services/runProfileService'

describe('runProfileService.deleteProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProfileRepo.count.mockResolvedValue(2)
  })

  it('deletes a non-active profile', async () => {
    mockProfileRepo.findById.mockResolvedValue({ id: 'p1', name: 'music', isActive: false } as any)

    await expect(runProfileService.deleteProfile('p1')).resolves.toEqual({ id: 'p1', deleted: true })
    expect(mockProfileRepo.delete).toHaveBeenCalledWith('p1')
  })

  it('refuses to delete the ACTIVE profile — it supplies the live cudaDevice/startOnBoot config', async () => {
    mockProfileRepo.findById.mockResolvedValue({ id: 'p1', name: 'Balanced', isActive: true } as any)

    await expect(runProfileService.deleteProfile('p1')).rejects.toThrow(/active profile/i)
    expect(mockProfileRepo.delete).not.toHaveBeenCalled()
  })

  it('refuses to delete the last remaining profile', async () => {
    mockProfileRepo.findById.mockResolvedValue({ id: 'p1', name: 'Balanced', isActive: false } as any)
    mockProfileRepo.count.mockResolvedValue(1)

    await expect(runProfileService.deleteProfile('p1')).rejects.toThrow(/last remaining/i)
    expect(mockProfileRepo.delete).not.toHaveBeenCalled()
  })

  it('404s an unknown profile', async () => {
    mockProfileRepo.findById.mockResolvedValue(null)

    await expect(runProfileService.deleteProfile('nope')).rejects.toThrow(/not found/i)
    expect(mockProfileRepo.delete).not.toHaveBeenCalled()
  })
})

describe('runProfileService.listProfiles', () => {
  beforeEach(() => jest.clearAllMocks())

  it('backfills missing profile-service rows so a new service reaches every profile', async () => {
    mockProfileRepo.backfillProfileServices.mockResolvedValue(3)

    await runProfileService.listProfiles()

    expect(mockProfileRepo.backfillProfileServices).toHaveBeenCalled()
    expect(mockProfileRepo.findAll).toHaveBeenCalled()
  })
})
