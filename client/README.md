# service-manager-client

TypeScript client library for the [service-manager](https://github.com/jasonlmcaffee/service-manager) API.

## Build

Before installing in another project, compile the TypeScript source:

```bash
cd C:/jason/dev/service-manager/client
npm run build
```

This outputs compiled JS + type declarations to `client/dist/`.

## Installation

In your other project's directory:

```bash
npm install file:C:/jason/dev/service-manager/client
```

Or add it to your `package.json` directly:

```json
{
  "dependencies": {
    "service-manager-client": "file:C:/jason/dev/service-manager/client"
  }
}
```

Then run `npm install`.

> **Note:** Requires the service-manager server to be running (default: `http://localhost:4000`).

## Usage

```ts
import { ServiceManagerClient, ServiceManagerError } from 'service-manager-client'

const client = new ServiceManagerClient('http://localhost:4000')

// List all services (includes port, cudaDevice, command)
const services = await client.listServices()

// List all profiles (each includes services with name, port, cudaDevice)
const profiles = await client.listProfiles()

// Get the active profile
const active = await client.getActiveProfile()

// Switch to a different profile (stops all services, starts the new profile's auto-start services)
const switched = await client.switchProfile('profile-id-here')

// Start / stop a service
await client.startService('service-id-here')
await client.stopService('service-id-here')
```

## Error handling

All methods throw `ServiceManagerError` on non-2xx responses:

```ts
try {
  await client.switchProfile('bad-id')
} catch (err) {
  if (err instanceof ServiceManagerError) {
    console.error(err.message, err.status) // e.g. "Profile not found: bad-id", 404
  }
}
```

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- service-manager running and accessible
