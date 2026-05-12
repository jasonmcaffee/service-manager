import path from 'path'
import fs from 'fs'
import os from 'os'
import { getLogFilePath } from '@/lib/util/logTailer'

/**
 * Returns true if the command is a PowerShell script (not a batch script that
 * merely calls powershell.exe inline). Batch markers take precedence so that
 * commands containing inline `powershell -Command "... Write-Host ..."` are
 * not misclassified as PowerShell.
 */
function isPowerShellCommand(command: string): boolean {
  // These tokens appear at the statement level only in batch scripts
  if (/^(@echo\s|setlocal\b|endlocal\b|goto\s|::\s|rem\s)/im.test(command)) return false
  return /(\$env:|Write-Host|Start-Process|Set-Location|\$PSScriptRoot|\.ps1\b)/i.test(command)
}

/**
 * Writes a startup script (.bat or .ps1) and returns its path plus the log file path.
 * The script redirects all output to the log file (truncating it first).
 * @param serviceId - unique service identifier used for the file name
 * @param command - the shell command or script content to execute
 * @param env - environment variables to set before running the command
 */
export function writeStartupScript(serviceId: string, command: string, env: Record<string, string> = {}): { scriptFile: string; logFile: string } {
  const tempDir = path.join(os.tmpdir(), 'service-manager')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const logFile = getLogFilePath(serviceId)

  if (isPowerShellCommand(command)) {
    const scriptFile = writePowerShellScript(tempDir, serviceId, command, env, logFile)
    return { scriptFile, logFile }
  }
  const scriptFile = writeBatchScript(tempDir, serviceId, command, env, logFile)
  return { scriptFile, logFile }
}

/**
 * Writes a PowerShell .ps1 script that sets env vars and redirects all output to logFile.
 * @param tempDir - directory to write the script file into
 * @param serviceId - unique service identifier used for the file name
 * @param command - PowerShell script content
 * @param env - environment variables to prepend as $env:KEY = "VALUE" lines
 * @param logFile - absolute path to the log file for output redirection
 */
function writePowerShellScript(tempDir: string, serviceId: string, command: string, env: Record<string, string>, logFile: string): string {
  const ps1File = path.join(tempDir, `service-${serviceId}.ps1`)
  const allEnv = { PYTHONUNBUFFERED: '1', ...env }
  const envLines = Object.entries(allEnv)
    .map(([key, value]) => `$env:${key} = "${value}"`)
    .join('\r\n')
  const logPathEscaped = logFile.replace(/'/g, "''")
  const truncate = `$null | Set-Content -Path '${logPathEscaped}'`
  // Wrap all command lines in & { } so every line's output is redirected to the log
  const commandBlock = `& {\r\n${command}\r\n} *>> '${logPathEscaped}'`
  const parts = [envLines, truncate, commandBlock].filter(Boolean)
  const content = parts.join('\r\n')
  fs.writeFileSync(ps1File, content, 'utf-8')
  return ps1File
}

/**
 * Writes a cmd.exe compatible .bat script that sets env vars and redirects all output to logFile.
 * Uses a two-file approach (outer launcher + inner command bat) to avoid cmd.exe's parenthesis
 * parser bug: the ( ) block redirect confuses the parser when inline powershell -Command "..."
 * calls contain parentheses, causing the block to fail before any output is written.
 * @param tempDir - directory to write the script file into
 * @param serviceId - unique service identifier used for the file name
 * @param command - batch command content
 * @param env - environment variables to prepend as SET KEY=VALUE lines
 * @param logFile - absolute path to the log file for output redirection
 */
function writeBatchScript(tempDir: string, serviceId: string, command: string, env: Record<string, string>, logFile: string): string {
  const outerBat = path.join(tempDir, `service-${serviceId}.bat`)
  const innerBat = path.join(tempDir, `service-${serviceId}-cmd.bat`)

  // Inner bat holds only the user command — no wrapper needed
  fs.writeFileSync(innerBat, command, 'utf-8')

  const allEnv = { PYTHONUNBUFFERED: '1', ...env }
  const envLines = Object.entries(allEnv)
    .map(([key, value]) => `set ${key}=${value}`)
    .join('\r\n')
  const truncate = `type nul > "${logFile}"`
  // call shares the env scope so PORT/CUDA_DEVICE are visible inside the inner bat
  const callInner = `call "${innerBat}" >> "${logFile}" 2>&1`
  const parts = ['@echo off', envLines, truncate, callInner].filter(Boolean)
  const content = parts.join('\r\n')
  fs.writeFileSync(outerBat, content, 'utf-8')
  return outerBat
}
