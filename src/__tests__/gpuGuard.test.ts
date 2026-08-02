import {
  parseGpuMemory,
  parseCudaDevices,
  checkVramAdmission,
  VRAM_SAFETY_MARGIN_MB,
} from '@/lib/util/gpuGuard'

describe('parseGpuMemory', () => {
  it('parses the nvidia-smi csv rows', () => {
    const stdout = '0, 32607, 3781, 28826\n1, 32607, 29835, 2772\n'
    expect(parseGpuMemory(stdout)).toEqual([
      { index: 0, totalMb: 32607, usedMb: 3781, freeMb: 28826 },
      { index: 1, totalMb: 32607, usedMb: 29835, freeMb: 2772 },
    ])
  })

  it('ignores blank and malformed rows', () => {
    const stdout = '\n0, 32607, 100, 32507\nnot,a,number,row\n\n'
    expect(parseGpuMemory(stdout)).toHaveLength(1)
  })
})

describe('parseCudaDevices', () => {
  it('parses a single device', () => {
    expect(parseCudaDevices('1')).toEqual([1])
  })

  it('parses a multi-GPU mask', () => {
    expect(parseCudaDevices('0,1')).toEqual([0, 1])
  })

  it('returns empty for unpinned services', () => {
    expect(parseCudaDevices(null)).toEqual([])
    expect(parseCudaDevices(undefined)).toEqual([])
    expect(parseCudaDevices('')).toEqual([])
  })
})

describe('checkVramAdmission', () => {
  /** GPU0 mostly free, GPU1 filled by llama — the exact task-1406 machine state. */
  const gpus = [
    { index: 0, totalMb: 32607, usedMb: 3781, freeMb: 28826 },
    { index: 1, totalMb: 32607, usedMb: 29835, freeMb: 2772 },
  ]
  const occupants = new Map<number, string[]>([[1, ['Llama.cpp Server']]])

  it('blocks the start that hard-hung the machine: ComfyUI onto llama-filled GPU1', () => {
    const result = checkVramAdmission({
      serviceName: 'ComfyUI 2nd GPU',
      cudaDevice: '1',
      minFreeVramMb: 20000,
      gpus,
      occupantsByDevice: occupants,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('GPU 1 has only 2772 MB free')
    expect(result.reason).toContain('Llama.cpp Server')
  })

  it('allows the same service on the free GPU0', () => {
    const result = checkVramAdmission({
      serviceName: 'ComfyUI',
      cudaDevice: '0',
      minFreeVramMb: 20000,
      gpus,
      occupantsByDevice: occupants,
    })
    expect(result.allowed).toBe(true)
  })

  it('blocks a dual-GPU service when EITHER of its devices is full', () => {
    const result = checkVramAdmission({
      serviceName: 'Big Comfy',
      cudaDevice: '0,1',
      minFreeVramMb: 20000,
      gpus,
      occupantsByDevice: occupants,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('GPU 1')
  })

  it('enforces the safety margin at the boundary', () => {
    const tight = [{ index: 0, totalMb: 32607, usedMb: 12607, freeMb: 20000 }]
    // Needs exactly the free amount, so the margin makes it fall short.
    expect(
      checkVramAdmission({
        serviceName: 'ComfyUI',
        cudaDevice: '0',
        minFreeVramMb: 20000,
        gpus: tight,
        occupantsByDevice: new Map(),
      }).allowed
    ).toBe(false)

    expect(
      checkVramAdmission({
        serviceName: 'ComfyUI',
        cudaDevice: '0',
        minFreeVramMb: 20000 - VRAM_SAFETY_MARGIN_MB,
        gpus: tight,
        occupantsByDevice: new Map(),
      }).allowed
    ).toBe(true)
  })

  describe('fails open rather than blocking a start on incomplete information', () => {
    it('allows when the service is not pinned to a GPU', () => {
      expect(
        checkVramAdmission({
          serviceName: 'AI Service',
          cudaDevice: null,
          minFreeVramMb: 20000,
          gpus,
          occupantsByDevice: occupants,
        }).allowed
      ).toBe(true)
    })

    it('allows when the service declares no VRAM requirement', () => {
      expect(
        checkVramAdmission({
          serviceName: 'Transcribe Audio',
          cudaDevice: '1',
          minFreeVramMb: null,
          gpus,
          occupantsByDevice: occupants,
        }).allowed
      ).toBe(true)
    })

    it('allows when nvidia-smi was unavailable', () => {
      expect(
        checkVramAdmission({
          serviceName: 'ComfyUI 2nd GPU',
          cudaDevice: '1',
          minFreeVramMb: 20000,
          gpus: null,
          occupantsByDevice: occupants,
        }).allowed
      ).toBe(true)
    })

    it('allows when the pinned device index is not present in the readings', () => {
      expect(
        checkVramAdmission({
          serviceName: 'Phantom',
          cudaDevice: '7',
          minFreeVramMb: 20000,
          gpus,
          occupantsByDevice: occupants,
        }).allowed
      ).toBe(true)
    })
  })

  it('still refuses without occupant names, omitting the held-by clause', () => {
    const result = checkVramAdmission({
      serviceName: 'ComfyUI 2nd GPU',
      cudaDevice: '1',
      minFreeVramMb: 20000,
      gpus,
      occupantsByDevice: new Map(),
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).not.toContain('currently held by')
  })
})
