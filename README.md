# Service Manager

A modern Windows service management application built with Next.js. Consolidate and manage all your startup batch files from a single, beautiful interface.

![Dark Theme UI](https://via.placeholder.com/800x400/111318/00d9ff?text=Service+Manager)

## Features

- 🚀 **Centralized Service Management** - Manage all your Windows services and applications from one place
- 📊 **Real-time Terminal Output** - View live output from each service
- ⚡ **Start/Stop/Restart** - Control each service independently
- 🔄 **Auto-start on Boot** - Configure which services start automatically
- ✏️ **Inline Editing** - Edit batch file content directly in the UI
- 🌙 **Modern Dark Theme** - Easy on the eyes, beautiful to use
- 💾 **SQLite Database** - Persistent storage for your service configurations

## Quick Start

### Prerequisites

- Node.js 18+ installed
- npm or yarn

### Installation

1. Clone or navigate to this directory:
   ```bash
   cd C:\jason\dev\service-manager
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Initialize the database:
   ```bash
   npx prisma generate
   npx prisma db push
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open http://localhost:3000 in your browser

### Production Mode

For production use (recommended for startup):

```bash
npm run build
npm start
```

## Setting Up Windows Startup

To have Service Manager start automatically when Windows boots:

1. Copy `start-service-manager.bat` to your Windows Startup folder:
   - Press `Win + R`
   - Type `shell:startup` and press Enter
   - Copy the batch file to this folder

2. Remove your old individual startup batch files from the Startup folder

3. Add your services to Service Manager through the UI

## Usage

### Adding a Service

1. Click **"Add Service"** button
2. Enter a name and optional description
3. Set the working directory (if needed)
4. Enter the batch file content or command
5. Set startup order (lower numbers start first)
6. Toggle "Start on boot" if this service should auto-start
7. Click **"Add Service"**

### Managing Services

- **Start**: Click the play button to start a stopped service
- **Stop**: Click the stop button to stop a running service
- **Restart**: Click the restart button to restart a running service
- **View Output**: Click the expand button to see terminal output
- **Edit**: Expand the service and click "Edit Settings"

### Auto-start Configuration

Toggle the "Auto-start" badge on any service card to configure whether it starts automatically when Service Manager launches.

### GPU pinning and the VRAM guard

A service can declare which GPU it uses (`cudaDevice`, e.g. `1` or the dual-GPU mask `0,1`) and how
much free VRAM it needs to start (`minFreeVramMb`). Before a stopped service is started, Service
Manager reads `nvidia-smi` and refuses the start with a 409 if the card does not have
`minFreeVramMb` + 512 MB free, naming the service that is holding it. The guard fails **open** —
no pin, no requirement, or no `nvidia-smi` means the service starts as before.

**The start command is the source of truth for which GPU a service runs on.** If a command
hard-codes a device — `CUDA_VISIBLE_DEVICES=1`, `--cuda-device 0`, or llama.cpp's `-dev cuda1` —
that pin wins over the registered `cudaDevice`, because it is the card the process actually gets.
Comment lines (`REM`, `::`, `#`) are ignored, and a value that expands a variable
(`CUDA_VISIBLE_DEVICES=%CUDA_DEVICE%`, the pattern ComfyUI uses) is *not* a hard-code — it defers to
the registration, which Service Manager injects as `CUDA_DEVICE`.

Because of that, writing a `cudaDevice` that contradicts a hard-coded pin is rejected with a 409 on
both `PUT /api/services/[id]` and `PUT /api/profiles/[id]/services/[serviceId]`; the two can never
disagree. Services read back `cudaDevice` (effective), `registeredCudaDevice` (stored),
`cudaDeviceSource` (`command` or `profile`) and `cudaDeviceConflict`.

Stopping, starting or `kill-port`-ing a GPU-pinned service also sweeps its cards for processes still
holding VRAM. A leftover process is killed only when its executable is named in that service's own
start command, is specific enough to identify (never a bare `python.exe`/`node.exe`), and is not a
protected PID; anything else that belongs to another registered service is reported, never killed.
Per-process VRAM is unavailable on Windows WDDM, so the report quotes the card's free-memory reading.

Every guard decision — a refused start, a registration/command conflict, a stop performed by a
profile switch, a service the reconciler found dead — is appended to that service's own output, so
the reason is visible where you would look rather than only in the Service Manager console.

## Project Structure

```
service-manager/
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── service-manager.db # SQLite database (created on first run)
├── src/
│   ├── app/
│   │   ├── api/           # API routes
│   │   ├── globals.css    # Global styles
│   │   ├── layout.tsx     # Root layout
│   │   └── page.tsx       # Main page
│   ├── components/        # React components
│   ├── lib/
│   │   ├── db.ts          # Database client
│   │   └── process-manager.ts  # Service process management
│   └── types/             # TypeScript types
├── start-service-manager.bat  # Production startup script
├── start-dev.bat              # Development startup script
└── package.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/services` | List all services |
| POST | `/api/services` | Create a new service |
| GET | `/api/services/[id]` | Get a single service |
| PUT | `/api/services/[id]` | Update a service |
| DELETE | `/api/services/[id]` | Delete a service |
| POST | `/api/services/[id]/control` | Start/Stop/Restart a service |
| GET | `/api/services/[id]/output` | Get service output |
| DELETE | `/api/services/[id]/output` | Clear service output |
| POST | `/api/services/startup` | Start all auto-start services |

## Tech Stack

- **Frontend**: Next.js 14, React 18, Tailwind CSS
- **Backend**: Next.js API Routes
- **Database**: SQLite with Prisma ORM
- **Process Management**: Node.js child_process, tree-kill
- **Icons**: Lucide React

## License

MIT
