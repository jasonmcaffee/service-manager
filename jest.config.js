/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
      },
    }],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Safety: always exit after tests complete to prevent leaked interval handles from blocking
  forceExit: true,
  // Warn when tests leave open handles (timers, sockets, etc.)
  detectOpenHandles: true,
  // Fail individual tests faster so a hung test doesn't drain RAM
  testTimeout: 15_000,
  // Run at 50% of CPUs to avoid overwhelming the machine
  maxWorkers: '50%',
  globalSetup: '<rootDir>/src/__tests__/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/src/__tests__/setup/globalTeardown.ts',
}
