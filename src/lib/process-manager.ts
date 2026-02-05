import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import os from 'os'

const treeKill = require('tree-kill')

export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface ServiceProcess {
  id: string
  process: ChildProcess | null
  status: ServiceStatus
  output: string[]
  pid?: number
  startTime?: Date
  error?: string
}

// Store instance globally to survive hot-reloads in development
const globalForProcessManager = globalThis as unknown as {
  processManagerInstance: ProcessManager | undefined
}

class ProcessManager extends EventEmitter {
  private processes: Map<string, ServiceProcess> = new Map()
  private maxOutputLines = 1000

  static getInstance(): ProcessManager {
    if (!globalForProcessManager.processManagerInstance) {
      globalForProcessManager.processManagerInstance = new ProcessManager()
    }
    return globalForProcessManager.processManagerInstance
  }

  getStatus(serviceId: string): ServiceProcess | undefined {
    return this.processes.get(serviceId)
  }

  getAllStatuses(): Map<string, ServiceProcess> {
    return this.processes
  }

  // Restore a service's runtime state from database (called on startup)
  restoreFromDb(serviceId: string, pid: number | null, status: ServiceStatus): void {
    // Skip if we already have this service tracked with output
    const existing = this.processes.get(serviceId)
    if (existing && existing.output.length > 0) {
      return // Don't overwrite existing output
    }
    
    if (pid && status === 'running') {
      // Check if the process is still actually running
      if (this.isProcessRunning(pid)) {
        this.processes.set(serviceId, {
          id: serviceId,
          process: null, // We don't have the ChildProcess object, but we have the PID
          status: 'running',
          output: existing?.output || ['[Restored from previous session]'],
          pid,
        })
      } else {
        // Process died, mark as stopped
        this.processes.set(serviceId, {
          id: serviceId,
          process: null,
          status: 'stopped',
          output: existing?.output || ['[Previous process no longer running]'],
        })
      }
    }
  }

  // Check if a process with given PID is running
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0) // Signal 0 just checks if process exists
      return true
    } catch {
      return false
    }
  }

  async startService(
    serviceId: string,
    command: string,
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    // Kill existing process if running
    const existing = this.processes.get(serviceId)
    if (existing?.process && existing.status === 'running') {
      await this.stopService(serviceId, onStateChange)
    }

    // Create temp batch file for the command
    const tempDir = path.join(os.tmpdir(), 'service-manager')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const batFile = path.join(tempDir, `service-${serviceId}.bat`)
    fs.writeFileSync(batFile, command, 'utf-8')

    const serviceProcess: ServiceProcess = {
      id: serviceId,
      process: null,
      status: 'starting',
      output: [],
      startTime: new Date(),
    }

    this.processes.set(serviceId, serviceProcess)
    this.emit('status-change', serviceId, 'starting')
    
    if (onStateChange) {
      await onStateChange('starting', undefined)
    }

    try {
      // Run the batch file with cmd.exe
      const child = spawn('cmd.exe', ['/c', batFile], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        env: { ...process.env },
      })

      serviceProcess.process = child
      serviceProcess.pid = child.pid
      serviceProcess.status = 'running'
      this.emit('status-change', serviceId, 'running')
      
      if (onStateChange) {
        await onStateChange('running', child.pid)
      }

      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        this.appendOutput(serviceId, text)
        this.emit('output', serviceId, text, 'stdout')
      })

      // Capture stderr
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        this.appendOutput(serviceId, text)
        this.emit('output', serviceId, text, 'stderr')
      })

      // Handle process exit
      child.on('exit', async (code, signal) => {
        const proc = this.processes.get(serviceId)
        if (proc) {
          proc.status = code === 0 ? 'stopped' : 'error'
          proc.process = null
          proc.pid = undefined
          if (code !== 0) {
            proc.error = `Process exited with code ${code}`
          }
          this.emit('status-change', serviceId, proc.status, code)
          
          if (onStateChange) {
            await onStateChange(proc.status, undefined)
          }
        }
      })

      child.on('error', async (err) => {
        const proc = this.processes.get(serviceId)
        if (proc) {
          proc.status = 'error'
          proc.error = err.message
          proc.process = null
          proc.pid = undefined
          this.appendOutput(serviceId, `Error: ${err.message}`)
          this.emit('status-change', serviceId, 'error')
          
          if (onStateChange) {
            await onStateChange('error', undefined)
          }
        }
      })
    } catch (error: any) {
      serviceProcess.status = 'error'
      serviceProcess.error = error.message
      this.emit('status-change', serviceId, 'error')
      
      if (onStateChange) {
        await onStateChange('error', undefined)
      }
      throw error
    }
  }

  async stopService(
    serviceId: string,
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    const serviceProcess = this.processes.get(serviceId)
    
    // Get PID from either the process object or stored pid
    const pid = serviceProcess?.process?.pid || serviceProcess?.pid
    
    if (!pid) {
      if (serviceProcess) {
        serviceProcess.status = 'stopped'
        serviceProcess.pid = undefined
      }
      this.emit('status-change', serviceId, 'stopped')
      if (onStateChange) {
        await onStateChange('stopped', undefined)
      }
      return
    }

    return new Promise((resolve) => {
      // Use tree-kill to kill the process and all its children
      treeKill(pid, 'SIGTERM', async (err: Error | null) => {
        if (err) {
          // Try forceful kill
          treeKill(pid, 'SIGKILL', async () => {
            if (serviceProcess) {
              serviceProcess.status = 'stopped'
              serviceProcess.process = null
              serviceProcess.pid = undefined
            }
            this.emit('status-change', serviceId, 'stopped')
            if (onStateChange) {
              await onStateChange('stopped', undefined)
            }
            resolve()
          })
        } else {
          if (serviceProcess) {
            serviceProcess.status = 'stopped'
            serviceProcess.process = null
            serviceProcess.pid = undefined
          }
          this.emit('status-change', serviceId, 'stopped')
          if (onStateChange) {
            await onStateChange('stopped', undefined)
          }
          resolve()
        }
      })

      // Timeout fallback
      setTimeout(async () => {
        if (serviceProcess && serviceProcess.status !== 'stopped') {
          serviceProcess.status = 'stopped'
          serviceProcess.process = null
          serviceProcess.pid = undefined
          this.emit('status-change', serviceId, 'stopped')
          if (onStateChange) {
            await onStateChange('stopped', undefined)
          }
          resolve()
        }
      }, 5000)
    })
  }

  async restartService(
    serviceId: string,
    command: string,
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    await this.stopService(serviceId, onStateChange)
    // Small delay before restart
    await new Promise(resolve => setTimeout(resolve, 500))
    await this.startService(serviceId, command, onStateChange)
  }

  getOutput(serviceId: string): string[] {
    return this.processes.get(serviceId)?.output || []
  }

  clearOutput(serviceId: string): void {
    const proc = this.processes.get(serviceId)
    if (proc) {
      proc.output = []
      this.emit('output-cleared', serviceId)
    }
  }

  private appendOutput(serviceId: string, text: string): void {
    const proc = this.processes.get(serviceId)
    if (proc) {
      const lines = text.split('\n')
      proc.output.push(...lines)
      // Keep only the last maxOutputLines
      if (proc.output.length > this.maxOutputLines) {
        proc.output = proc.output.slice(-this.maxOutputLines)
      }
    }
  }

  isRunning(serviceId: string): boolean {
    const proc = this.processes.get(serviceId)
    if (proc?.status === 'running') {
      // Verify the PID is actually still running
      if (proc.pid && !this.isProcessRunning(proc.pid)) {
        proc.status = 'stopped'
        proc.pid = undefined
        return false
      }
      return true
    }
    return false
  }
  
  // Get current PID for a service
  getPid(serviceId: string): number | undefined {
    return this.processes.get(serviceId)?.pid
  }
}

export const processManager = ProcessManager.getInstance()
