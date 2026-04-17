import { PrismaClient } from '@prisma/client'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const TEST_DB_PATH = path.join(__dirname, '../../prisma/test.db')
const TEST_DB_URL = `file:${TEST_DB_PATH}`

// Override DATABASE_URL for tests
process.env.DATABASE_URL = TEST_DB_URL

export function getTestPrisma() {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB_URL } },
  })
}

export async function setupTestDb(prisma: PrismaClient) {
  // Push schema to test DB
  execSync(`npx prisma db push --skip-generate`, {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  })
}

export async function cleanTestDb(prisma: PrismaClient) {
  await prisma.service.deleteMany()
}

export function removeTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH)
  }
}
