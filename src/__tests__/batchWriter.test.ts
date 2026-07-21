import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeStartupScript } from '@/lib/util/batchWriter'

const tempDir = path.join(os.tmpdir(), 'service-manager')

/** Returns the inner bat path derived from the outer bat path (service-ID.bat → service-ID-cmd.bat). */
function innerBatPath(scriptFile: string): string {
  return scriptFile.replace(/\.bat$/, '-cmd.bat')
}

describe('batchWriter — writeStartupScript', () => {
  afterEach(() => {
    // clean up test script files and log files
    try {
      const files = fs.readdirSync(tempDir).filter(f => f.startsWith('service-test-'))
      files.forEach(f => fs.unlinkSync(path.join(tempDir, f)))
    } catch { /* tempDir may not exist */ }
  })

  it('returns a scriptFile path and a logFile path', () => {
    const { scriptFile, logFile } = writeStartupScript('test-1', 'echo hello', {})
    expect(scriptFile).toContain('service-test-1.bat')
    expect(logFile).toContain('service-test-1.log')
    expect(fs.existsSync(scriptFile)).toBe(true)
  })

  it('inner bat contains the command', () => {
    const { scriptFile } = writeStartupScript('test-2', 'npm start', {})
    const inner = fs.readFileSync(innerBatPath(scriptFile), 'utf-8')
    expect(inner).toContain('npm start')
  })

  it('outer bat contains PORT env var; inner bat contains the command', () => {
    const { scriptFile } = writeStartupScript('test-3', 'npm start', { PORT: '8080' })
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    const inner = fs.readFileSync(innerBatPath(scriptFile), 'utf-8')
    expect(outer).toContain('set PORT=8080')
    // env var must appear before the call to the inner bat
    expect(outer.indexOf('set PORT=8080')).toBeLessThan(outer.indexOf('call '))
    expect(inner).toContain('npm start')
  })

  it('outer bat contains CUDA_DEVICE env var; inner bat contains the command', () => {
    const { scriptFile } = writeStartupScript('test-4', 'python main.py', { CUDA_DEVICE: '1' })
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    const inner = fs.readFileSync(innerBatPath(scriptFile), 'utf-8')
    expect(outer).toContain('set CUDA_DEVICE=1')
    expect(inner).toContain('python main.py')
  })

  it('outer bat sends the inner bat output to the log file', () => {
    const { scriptFile, logFile } = writeStartupScript('test-5', 'echo hi', {})
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    // Output reaches the log either through the size-capping writer (preferred)
    // or a plain append redirect when that script is unavailable.
    expect(outer).toMatch(/log-cap-writer\.cjs|>>/)
    expect(outer).toContain(logFile)
  })

  it('outer bat truncates the log file before calling the inner bat', () => {
    const { scriptFile } = writeStartupScript('test-6', 'echo hi', {})
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    const truncateIdx = outer.indexOf('type nul')
    const callIdx = outer.indexOf('call "')
    expect(truncateIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(-1)
    expect(truncateIdx).toBeLessThan(callIdx)
  })

  it('writes multi-line commands entirely to the inner bat so all lines are redirected', () => {
    const multiLineCmd = 'cd C:\\myproject\npip install -r requirements.txt\npython main.py'
    const { scriptFile } = writeStartupScript('test-7', multiLineCmd, {})
    const inner = fs.readFileSync(innerBatPath(scriptFile), 'utf-8')
    expect(inner).toContain('cd C:\\myproject')
    expect(inner).toContain('pip install -r requirements.txt')
    expect(inner).toContain('python main.py')
    // The outer bat must call the inner bat once and route all of its output
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    expect(outer).toContain('call ')
    expect(outer).toMatch(/log-cap-writer\.cjs|>>/)
  })

  it('sets PYTHONUNBUFFERED=1 in the outer bat before calling the inner bat', () => {
    const { scriptFile } = writeStartupScript('test-8', 'python main.py', {})
    const outer = fs.readFileSync(scriptFile, 'utf-8')
    expect(outer).toContain('set PYTHONUNBUFFERED=1')
    // PYTHONUNBUFFERED must appear before the call so it is in scope for the inner bat
    expect(outer.indexOf('set PYTHONUNBUFFERED=1')).toBeLessThan(outer.indexOf('call '))
  })
})
