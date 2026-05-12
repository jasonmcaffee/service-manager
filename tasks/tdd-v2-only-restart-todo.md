# TODO: TDD v2 Implementation

## Backend Fixes

- [x] 1. `src/lib/repositories/serviceRepository.ts` — add `findByName`, `findByPort` methods
- [x] 2. `src/lib/lifecycle.ts` — new module: `onShutdown` registry + SIGTERM/SIGINT handler
- [x] 3. `src/lib/process-manager.ts` — add `verifyHealthWithMaps(id, port, winMap, wslMap)`, `markUnhealthy(id, reason)`, public `hmrCleanup()`, register lifecycle handlers
- [x] 4. `src/lib/services/reconciler.ts` — new module: 10s background tick, one snapshot per tick, verifyHealth per running service
- [x] 5. `src/lib/services/init.ts` — claim-tracking adoption (1 PID:1 service), autostart-priority ranking, backfill Speaches port=8000, start reconciler after adoption
- [x] 6. `src/lib/services/serviceService.ts` — port uniqueness check (409) on create/update

## Frontend Fixes

- [x] 7. `src/app/page.tsx` — `applyServicePatch` (single-card update), `React.memo` on SortableServiceCard
- [x] 8. `src/components/ServiceCard.tsx` — `onPatch` callback instead of `onRefresh`, port-less warning chip

## Test Safety

- [x] 9. `jest.config.js` — add `detectOpenHandles`, `forceExit`, `testTimeout`, globalSetup/Teardown
- [x] 10. `src/__tests__/setup/globalSetup.ts` + `globalTeardown.ts` — before/after node process count invariant
- [x] 11. `src/__tests__/setup/makeProcessManager.ts` — test factory that bypasses globalThis
- [x] 12. `src/__tests__/adoptionClaimTracking.test.ts` — unit tests for port-collision claim logic
- [x] 13. `src/__tests__/reconciler.test.ts` — unit tests for reconciler tick with mock health results
- [x] 14. `src/__tests__/adoption.test.ts` — remove singleton mutation, use public API cleanup

## Verify

- [x] 15. `npm test -- --forceExit` passes — 80 tests pass, 0 failures
- [x] 16. Node process count: 49 before, 49 after — zero delta confirmed
