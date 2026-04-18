# TODO: API Enhancements & TypeScript Client Library

## API Fixes
- [x] Verify `serviceService.listServices()` returns `port`, `cudaDevice`, `command` (with active profile override)
- [x] Fix `runProfileRepository.findAll()` to include service `name` and `port` in the services array
- [x] Fix `PUT /api/profiles/active` route to return consistent `ProfileResponse`

## Client Library
- [x] Create `client/package.json`
- [x] Create `client/tsconfig.json`
- [x] Create `client/src/index.ts` with `ServiceManagerClient` class and all types
- [x] Create `client/README.md` with installation instructions

## Tests
- [x] Create `client/__tests__/client.integration.test.ts`
- [x] Run existing tests and confirm they pass (36/36)
- [x] Run integration tests against live server (5/5)
