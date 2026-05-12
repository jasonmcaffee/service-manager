# TODO: Only Restart Diff, Attach Running, Profile Sync, UI Reorder/Collapse

## Backend

- [x] 1. `src/lib/util/logTailer.ts` — new module, file-polling tailer with ring buffer
- [x] 2. `src/lib/util/batchWriter.ts` — redirect script output to log file; return `{ scriptFile, logFile }`
- [x] 3. `src/lib/util/portHelper.ts` — add `snapshotWindowsListeners`, `snapshotWslListeners` (single shell call, return port→pid[] map); export `killWslPids`
- [x] 4. `src/lib/process-manager.ts` — add `adoption` field + `adoptExternal`, fix `startService` short-circuit for `process===null` case, WSL kill path in `stopService`, integrate logTailer, remove old `appendOutput` / child stdio handlers
- [x] 5. `src/lib/services/profileDiff.ts` — new pure module: `EffectiveConfig`, `configKey`, `diffProfiles`
- [x] 6. `src/lib/services/init.ts` — single-flight `initializeIfNeeded` + `adoptRunningServices`; move old DB-gated restore logic out of serviceService
- [x] 7. `src/lib/services/serviceService.ts` — import `initializeIfNeeded` from init.ts; wire into `runAutoStart`, `startService`, `restartService`; remove old init block
- [x] 8. `src/lib/services/runProfileService.ts` — diff-based `switchProfile`; wire `initializeIfNeeded` at top; add `buildEffectiveConfigs` helper
- [x] 9. `src/lib/repositories/runProfileRepository.ts` — fix `createProfileServicesForAllProfiles` to mirror active values to ALL profiles (drop `isActive ? x : null` ternary)

## Frontend

- [x] 10. Install `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
- [x] 11. `src/hooks/useServiceOrder.ts` — localStorage-backed drag order hook
- [x] 12. `src/hooks/useCollapsedServices.ts` — localStorage-backed collapse state hook
- [x] 13. `src/components/ServiceCard.tsx` — collapse chevron toggle; hide terminal when collapsed
- [x] 14. `src/app/page.tsx` — wrap grid in DndContext/SortableContext, integrate both hooks

## Tests

- [x] 15. `src/__tests__/profileDiff.test.ts` — unit tests for pure diff logic
- [x] 16. `src/__tests__/runProfileService.test.ts` — update existing switchProfile tests for diff behavior; add createService fan-out tests
- [x] 17. `src/__tests__/serviceService.test.ts` — update mocks (remove restoreFromDb, add adoptExternal)
- [x] 18. `src/__tests__/adoption.test.ts` — integration tests for adoptRunningServices + logTailer

## Verify

- [x] 19. Run `npm test` — all 57 tests pass
- [x] 20. Manual smoke: server restarted; all 13 services correctly adopted (Windows + WSL PIDs in log files); adoption markers confirmed in /tmp/service-manager/logs/; log streaming will work for services restarted with new scripts
