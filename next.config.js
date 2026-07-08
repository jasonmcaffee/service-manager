/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['tree-kill'],
    // Enables src/instrumentation.ts register() to run once on server boot so
    // start-on-boot services launch even when no browser opens the UI.
    instrumentationHook: true,
  },
}

module.exports = nextConfig
