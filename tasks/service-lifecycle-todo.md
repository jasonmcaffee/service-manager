# Service Lifecycle Fix — TODO

## REQUIREMENTS
1. HMR (hot reload from code change) must NOT kill spawned services
2. On any restart/HMR, service-manager must re-attach to already-running services (port scan & re-adopt), show their logs, and show correct state
3. Kill-port must correctly detect and kill WSL processes (vllm on port 8080)
4. UI must NOT do a full page/data refresh when code changes — only poll on interval; a HMR cycle must not cause a service state flip (running → stopped → running)
5. Saving a service config change must NOT stop any running services
6. Logs for re-adopted services must be visible immediately after re-attach
7. Extensive tests: HMR simulation, start/stop/restart individual services, service survives service-manager restart, logs available after re-adoption, correct state shown throughout

---

## ROOT CAUSES

### Cause A — hmrCleanup kills spawned services
`ProcessManager.hmrCleanup()` calls `treeKill(pid, SIGKILL)` on every process that has a ChildProcess object.
On HMR (any source file save in dev mode), Next.js replaces the ProcessManager class. The old instance is
detected (instanceof check fails) and `hmrCleanup()` is called — killing Syllogi, AI Service, etc.

Fix: `hmrCleanup()` must NOT kill spawned children. Just stop log tailers and clear the process map.
The init cycle that runs on the next request calls `adoptRunningServices()` which port-scans and re-adopts.

### Cause B — killPort stops after Windows kill, never kills WSL process
`killPort()` checks Windows PIDs first. For vllm: the Windows side shows svchost as the listener.
It kills svchost, returns, never touches the WSL vllm process. Subsequent start attempt fails with EADDRINUSE.

Fix: `killPort()` must kill BOTH Windows and WSL processes in parallel, then union the results.

### Cause C — UI triggers startup on every React mount (HMR remount)
page.tsx fires `POST /api/services/startup` in a `useEffect(fn, [])`. On HMR, React
fast-refresh remounts the component, re-firing this effect. `hasBootStarted()` guards against
re-starting services but the call itself confirms the init path is triggered every remount.
This is not a bug today (guard works) but causes unnecessary startup noise.

### Cause D — UI calls fetchServices() immediately after a config save (triggers listServices)
`handleUpdateService` calls `fetchServices()` after any service edit. This triggers
`initializeIfNeeded()` which, if `smInitPromise` was reset by a concurrent HMR, re-runs
`adoptRunningServices()` while the old processes may have been killed. Not a direct bug, but
creates a race condition. Primary fix is Cause A.

---

## TODOS

### Phase 1 — Core fixes

- [x] **Fix A: `hmrCleanup()` — do NOT kill spawned processes on HMR**
  - In `src/lib/process-manager.ts`: remove the treeKill loop from hmrCleanup()
  - Only stop logTailer and clear the processes map
  - Add clear comment explaining WHY we don't kill here

- [x] **Fix B: `killPort()` — kill both Windows AND WSL on any port**
  - In `src/lib/util/portHelper.ts`: change `killPort()` to fetch both maps in parallel
  - Kill all Windows PIDs AND all WSL PIDs found on the port
  - Return combined killed list, wsl=true if any WSL process was killed
  - Update `isPortListening()` — already correct (checks both)

- [x] **Fix C: Ensure `adoptRunningServices()` re-adopts previously-spawned services**
  - Verify that after hmrCleanup (no kills), the init port scan finds services on their ports
  - Existing `adoptRunningServices()` logic handles this correctly once processes aren't killed
  - Verify log file fallback is in place for re-adopted services (already done in getService)

- [x] **Fix D: `killOrphanedWslProcesses` in serviceService — also kill before stop**
  - Already called in startService/restartService/stopService for WSL services
  - No change needed here (already correct)

### Phase 2 — Test: HMR survival

- [x] **Write `src/__tests__/hmrSurvival.test.ts`** — 16/16 passing
  - Test: hmrCleanup() does NOT call treeKill on spawned processes
  - Test: After hmrCleanup(), process map is empty (state cleared)
  - Test: logTailer is stopped for all services on hmrCleanup
  - Test: After ProcessManager replacement + adoptRunningServices, services with active ports are re-adopted
  - Test: Logs are available (non-empty) immediately after re-adoption (from log file)
  - Test: smBootStarted survives ProcessManager replacement (does not reset)
  - Test: smInitPromise is reset on ProcessManager replacement (forces re-init)
  - Test: Re-adopted service shows status='running' not 'stopped'

### Phase 3 — Test: kill-port WSL + Windows

- [x] **Write / extend `src/__tests__/killPort.test.ts`** — 16/16 passing
  - Test: killPort() kills Windows PIDs when only Windows process is present
  - Test: killPort() kills WSL PIDs when only WSL process is present
  - Test: killPort() kills BOTH Windows AND WSL PIDs when both are present (was broken)
  - Test: killPort() returns wsl=true when at least one WSL process was killed
  - Test: killPort() returns killed=false when no process is on the port
  - Test: isPortListening() returns true when only WSL process is on port
  - Test: isPortListening() returns true when only Windows process is on port
  - Test: isPortListening() returns false when no process is on port

### Phase 4 — Test: full service lifecycle

- [x] **Write `src/__tests__/serviceLifecycle.test.ts`** — 26/26 passing
  - Test: starting a service sets status=running
  - Test: stopping a running service sets status=stopped
  - Test: stopping an already-stopped service is a no-op (no error)
  - Test: restarting a service stops then starts it
  - Test: starting a service that is in error state cleans up first (treeKill old process)
  - Test: getService() returns output from log file when no in-memory buffer (service survived restart)
  - Test: service config update (PUT) does NOT change the running status of the service
  - Test: service config update does NOT stop a running service
  - Test: deleteService() stops the service before deleting
  - Test: autostart guard hasBootStarted() survives ProcessManager replacement

### Phase 5 — Test: adoption + logs after restart

- [x] **Extend `src/__tests__/adoption.test.ts`** — 27 adoption tests passing
  - Test: adoptExternal() for a service that was previously spawned (has a log file) shows log history
  - Test: adoptNoPort() marks service running without PID
  - Test: adoptNoPort() writes adoption marker to log file
  - Test: adoptNoPort() shows recent log history
  - Test: re-adoption after markUnhealthy shows fresh log content

### Phase 6 — Run all tests and verify

- [x] **Run full test suite — 144/144 passing across 11 test suites**
- [x] **Verify node process count does not leak — delta +8, within threshold**
- [x] **Manual spot-check: HMR fix (hmrCleanup no longer kills spawned processes)**
