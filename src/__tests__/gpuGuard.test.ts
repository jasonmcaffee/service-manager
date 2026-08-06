import {
  parseGpuMemory,
  parseCudaDevices,
  checkVramAdmission,
  VRAM_SAFETY_MARGIN_MB,
  extractCudaDevicesFromCommand,
  resolveGuardedCudaDevice,
  describeCudaDeviceConflict,
  parseGpuComputeApps,
  parseGpuUuidIndex,
  extractExecutableNames,
  classifyGpuSurvivors,
  buildKnownExecutables,
} from '@/lib/util/gpuGuard'

/** The real Unsloth trainer command — registered as GPU 0, actually runs on GPU 1. */
const TRAINER_COMMAND =
  'wsl -d Ubuntu bash -lc "cd /mnt/c/jason/dev/unsloth-trainer && CUDA_VISIBLE_DEVICES=1 VENV=$HOME/unsloth-venv bash run-service.sh"'

/** ComfyUI derives its mask from what Service Manager injects, and talks about GPUs in comments. */
const COMFY_COMMAND = [
  'REM -- task-604: pin this ComfyUI to ONLY its own GPU',
  'REM recurring and keeps the full 32GB usable. Keep --cuda-device 0 to match the mask.',
  'set CUDA_VISIBLE_DEVICES=%CUDA_DEVICE%',
  '.\\python_embeded\\python.exe .\\ComfyUI\\main.py --port %PORT% --cuda-device %CUDA_DEVICE% --disable-dynamic-vram',
].join('\n')

/** llama.cpp pins its card indirectly, via a batch variable. */
const LLAMA_COMMAND = [
  'cd c:\\jason\\dev\\llama.cpp-v3',
  'REM cuda1 = 2nd RTX 5090. cuda0 = RTX 5090.',
  'set CUDA_STRING=cuda1',
  '.\\prebuilt-download\\llama-server.exe -m model.gguf -ngl 9999 --port %PORT% -dev %CUDA_STRING% -c 150000',
].join('\n')

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

describe('extractCudaDevicesFromCommand', () => {
  it('reads the GPU the Unsloth trainer actually masks itself to', () => {
    expect(extractCudaDevicesFromCommand(TRAINER_COMMAND)).toBe('1')
  })

  it('ignores a mask that defers to the injected CUDA_DEVICE variable', () => {
    expect(extractCudaDevicesFromCommand(COMFY_COMMAND)).toBeNull()
  })

  it('does not read a pin out of a REM comment', () => {
    expect(extractCudaDevicesFromCommand('REM Keep --cuda-device 0 to match the mask.')).toBeNull()
  })

  it('resolves a pin held in a batch variable (llama.cpp -dev %CUDA_STRING%)', () => {
    expect(extractCudaDevicesFromCommand(LLAMA_COMMAND)).toBe('1')
  })

  it('handles bash export, PowerShell and multi-GPU masks', () => {
    expect(extractCudaDevicesFromCommand('export CUDA_VISIBLE_DEVICES=0,1 && python train.py')).toBe('0,1')
    expect(extractCudaDevicesFromCommand('$env:CUDA_VISIBLE_DEVICES = "1"\npython app.py')).toBe('1')
  })

  it('returns null when the command says nothing about a GPU', () => {
    expect(extractCudaDevicesFromCommand('npm start')).toBeNull()
    expect(extractCudaDevicesFromCommand('')).toBeNull()
    expect(extractCudaDevicesFromCommand(null)).toBeNull()
  })
})

describe('resolveGuardedCudaDevice', () => {
  it('lets the command override a registration that names a different card', () => {
    expect(resolveGuardedCudaDevice('0', TRAINER_COMMAND)).toBe('1')
  })

  it('falls back to the registration when the command hard-codes nothing', () => {
    expect(resolveGuardedCudaDevice('0', COMFY_COMMAND)).toBe('0')
    expect(resolveGuardedCudaDevice('0,1', COMFY_COMMAND)).toBe('0,1')
  })
})

describe('describeCudaDeviceConflict', () => {
  it('explains the trainer misregistration', () => {
    const conflict = describeCudaDeviceConflict('0', TRAINER_COMMAND)
    expect(conflict).toContain('registered as "0"')
    expect(conflict).toContain('pins GPU "1"')
  })

  it('is silent when the registration and the command agree', () => {
    expect(describeCudaDeviceConflict('1', TRAINER_COMMAND)).toBeNull()
    expect(describeCudaDeviceConflict('1', LLAMA_COMMAND)).toBeNull()
    expect(describeCudaDeviceConflict('0', COMFY_COMMAND)).toBeNull()
  })
})

describe('parseGpuComputeApps', () => {
  const uuidToIndex = new Map([['GPU-aaa', 0], ['GPU-bbb', 1]])

  it('maps each process to its card and keeps only the executable basename', () => {
    const stdout = 'GPU-bbb, 36764, C:\\jason\\dev\\llama.cpp-v3\\prebuilt-download\\llama-server.exe, 30012\n'
    expect(parseGpuComputeApps(stdout, uuidToIndex)).toEqual([
      { index: 1, pid: 36764, processName: 'llama-server.exe', usedMemoryMb: 30012 },
    ])
  })

  it('records unavailable per-process memory as null, never as 0 MB', () => {
    // Windows WDDM always reports [N/A] here; printing "holding 0 MB" would be a lie.
    const stdout = 'GPU-bbb, 36764, C:\\x\\llama-server.exe, [N/A]\n'
    expect(parseGpuComputeApps(stdout, uuidToIndex)[0].usedMemoryMb).toBeNull()
  })

  it('ignores blank and headerless junk lines', () => {
    expect(parseGpuComputeApps('\n[N/A]\n', uuidToIndex)).toEqual([])
  })
})

describe('parseGpuUuidIndex', () => {
  it('builds the uuid to index lookup', () => {
    expect(parseGpuUuidIndex('0, GPU-aaa\n1, GPU-bbb\n')).toEqual(new Map([['GPU-aaa', 0], ['GPU-bbb', 1]]))
  })
})

describe('extractExecutableNames', () => {
  it('finds the binaries a command launches', () => {
    expect(extractExecutableNames(LLAMA_COMMAND)).toContain('llama-server.exe')
  })
})

describe('buildKnownExecutables', () => {
  it('maps a specific binary to the service that runs it, skipping generic ones', () => {
    const map = buildKnownExecutables([
      { name: 'Llama.cpp Server', command: LLAMA_COMMAND },
      { name: 'ComfyUI', command: COMFY_COMMAND },
    ])
    expect(map.get('llama-server.exe')).toBe('Llama.cpp Server')
    expect(map.has('python.exe')).toBe(false)
  })

  it('excludes the service being acted on', () => {
    const map = buildKnownExecutables([{ name: 'Llama.cpp Server', command: LLAMA_COMMAND }], 'Llama.cpp Server')
    expect(map.size).toBe(0)
  })
})

describe('classifyGpuSurvivors', () => {
  const orphan = { index: 1, pid: 36764, processName: 'llama-server.exe', usedMemoryMb: null }
  const desktopNoise = { index: 1, pid: 999, processName: 'chrome.exe', usedMemoryMb: null }
  const comfy = { index: 1, pid: 555, processName: 'python.exe', usedMemoryMb: null }
  const known = new Map([['comfyui-launcher.exe', 'ComfyUI']])

  it('attributes a leftover llama-server.exe to the llama service', () => {
    const result = classifyGpuSurvivors({ apps: [orphan], devices: [1], command: LLAMA_COMMAND, protectedPids: new Map() })
    expect(result.reapable).toEqual([orphan])
    expect(result.reportOnly).toEqual([])
  })

  it('ignores a process on a card the service is not pinned to', () => {
    const result = classifyGpuSurvivors({ apps: [orphan], devices: [0], command: LLAMA_COMMAND, protectedPids: new Map() })
    expect(result.reapable).toEqual([])
  })

  it('drops desktop processes instead of reporting them as VRAM holders', () => {
    const result = classifyGpuSurvivors({ apps: [desktopNoise], devices: [1], command: LLAMA_COMMAND, protectedPids: new Map(), knownExecutables: known })
    expect(result.reapable).toEqual([])
    expect(result.reportOnly).toEqual([])
  })

  it('never reaps a generic interpreter, even when the service launches one', () => {
    const result = classifyGpuSurvivors({ apps: [comfy], devices: [1], command: COMFY_COMMAND, protectedPids: new Map() })
    expect(result.reapable).toEqual([])
  })

  it('never reaps a protected pid — it reports it instead', () => {
    const protectedPids = new Map([[36764, 'tracked pid of another service']])
    const result = classifyGpuSurvivors({ apps: [orphan], devices: [1], command: LLAMA_COMMAND, protectedPids })
    expect(result.reapable).toEqual([])
    expect(result.reportOnly[0].owner).toBe('protected process')
  })

  it('considers a process whose card could not be resolved', () => {
    const unmapped = { ...orphan, index: null }
    const result = classifyGpuSurvivors({ apps: [unmapped], devices: [1], command: LLAMA_COMMAND, protectedPids: new Map() })
    expect(result.reapable).toEqual([unmapped])
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
