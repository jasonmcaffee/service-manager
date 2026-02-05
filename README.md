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
