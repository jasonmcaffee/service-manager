import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeBatchFile } from '@/lib/util/batchWriter'

const tempDir = path.join(os.tmpdir(), 'service-manager')

describe('batchWriter', () => {
  afterEach(() => {
    // clean up test batch files
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith('service-test-'))
    files.forEach(f => fs.unlinkSync(path.join(tempDir, f)))
  })

  it('writes command without env vars', () => {
    const batFile = writeBatchFile('test-1', 'echo hello', {})
    const content = fs.readFileSync(batFile, 'utf-8')
    expect(content).toBe('echo hello')
  })

  it('prepends PORT env var before command', () => {
    const batFile = writeBatchFile('test-2', 'npm start', { PORT: '8080' })
    const content = fs.readFileSync(batFile, 'utf-8')
    expect(content).toContain('set PORT=8080')
    expect(content).toContain('npm start')
    expect(content.indexOf('set PORT=8080')).toBeLessThan(content.indexOf('npm start'))
  })

  it('prepends CUDA_DEVICE env var before command', () => {
    const batFile = writeBatchFile('test-3', 'python main.py', { CUDA_DEVICE: '1' })
    const content = fs.readFileSync(batFile, 'utf-8')
    expect(content).toContain('set CUDA_DEVICE=1')
    expect(content).toContain('python main.py')
  })

  it('prepends both PORT and CUDA_DEVICE when both provided', () => {
    const batFile = writeBatchFile('test-4', 'run.bat', { PORT: '9090', CUDA_DEVICE: 'cuda1' })
    const content = fs.readFileSync(batFile, 'utf-8')
    expect(content).toContain('set PORT=9090')
    expect(content).toContain('set CUDA_DEVICE=cuda1')
    expect(content).toContain('run.bat')
  })

  it('writes to expected temp path', () => {
    const batFile = writeBatchFile('test-5', 'echo hi', {})
    expect(batFile).toContain('service-test-5.bat')
    expect(fs.existsSync(batFile)).toBe(true)
  })
})
