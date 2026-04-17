# TODO: Service Architecture Refactor + Port & CUDA Device

## Database
- [x] Add `port` and `cudaDevice` fields to Prisma schema
- [x] Run Prisma migration (used `prisma db push` — see note below)

## New lib files
- [x] Create `src/lib/util/portHelper.ts`
- [x] Create `src/lib/util/batchWriter.ts`
- [x] Create `src/lib/repositories/serviceRepository.ts`
- [x] Create `src/lib/services/serviceService.ts`

## ProcessManager updates
- [x] Add `bootStarted` flag + `hasBootStarted()` / `markBootStarted()` methods
- [x] Accept `env` param in `startService` and `restartService`, use `batchWriter`

## API Routes (make thin)
- [x] `api/services/route.ts`
- [x] `api/services/[id]/route.ts`
- [x] `api/services/[id]/control/route.ts`
- [x] `api/services/[id]/output/route.ts`
- [x] `api/services/startup/route.ts`
- [x] `api/kill-port/route.ts`

## Types
- [x] Add `port` and `cudaDevice` to `Service` type

## UI Components
- [x] `AddServiceModal.tsx` - add port and cudaDevice fields
- [x] `EditServiceModal.tsx` - add port and cudaDevice fields
