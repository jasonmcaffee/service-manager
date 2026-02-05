/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['tree-kill'],
  },
}

module.exports = nextConfig
