import path from 'path'
import fs from 'fs'
import os from 'os'

export function writeBatchFile(
  serviceId: string,
  command: string,
  env: Record<string, string> = {}
): string {
  const tempDir = path.join(os.tmpdir(), 'service-manager')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const batFile = path.join(tempDir, `service-${serviceId}.bat`)

  const envLines = Object.entries(env)
    .map(([key, value]) => `set ${key}=${value}`)
    .join('\r\n')

  const content = envLines ? `${envLines}\r\n${command}` : command

  fs.writeFileSync(batFile, content, 'utf-8')
  return batFile
}
