# TODO: Fix Startup Issues

## Investigation
- [x] Explore codebase structure
- [x] Understand auto-start + adoption + reconciliation flow
- [x] Understand UI update pattern (polling + memoization)
- [x] Reproduce / observe both issues with Playwright

## Findings
- **Issue 1 (vllm shows not running)** was a chain of fragilities:
  - `snapshotWslListeners` / `snapshotWindowsListeners` silently swallowed command
    failures → a `wsl` hiccup looked identical to "nothing listening".
  - `reconciler.tick()` then read an empty wslMap and flipped vllm to `stopped`.
  - `listServices` independently flipped DB to `stopped` whenever processManager
    didn't track a service — overwriting state even when adoption simply hadn't
    succeeded yet.
  - `getOutput` returned only the in-memory tailer; an un-adopted service had a
    blank terminal so the user couldn't see why it failed.

- **Issue 2 (page refresh feel)** — mount-id playwright test confirmed the DOM
  doesn't actually remount. The real defect was `handleUpdateService`,
  `handleAddService`, `handleDeleteService` closing over stale `services` because
  they weren't `useCallback`. Memoized `SortableServiceCard` caches its props,
  including those callbacks, so a click on a memoized card could fire with a
  stale `services` and brief-revert every sibling for one paint cycle.

## Issue 1 fixes (implemented)
- [x] `snapshotWindowsListeners` / `snapshotWslListeners` return `Map | null` —
      `null` = command failed (distinguishable from empty result).
- [x] `adoptRunningServices` retries once after 500ms if a snapshot is null;
      skips per-service adoption when that service's required snapshot is null.
- [x] `reconciler.tick()` skips verification when the relevant snapshot is null;
      late-adopts services that DB says running but processManager has not
      tracked, so transient init failures self-heal within 10s.
- [x] `listServices` no longer flips DB to stopped just because processManager
      lacks the service; only writes when processManager has it but the child /
      PID is dead (definitive evidence).
- [x] `getOutput` falls back to the persisted log file when the tailer buffer
      is empty so the terminal still shows the last run's output.

## Issue 2 fixes (implemented)
- [x] `handleUpdateService`, `handleAddService`, `handleDeleteService` converted
      to `useCallback` with functional setState. No more stale closure reverts.

## Tests
- [x] `reconciler.test.ts` extended: skip-on-null-snapshot, late-adopt success,
      late-adopt → mark-stopped when port empty, no late-adopt when WSL snapshot failed.
- [x] `serviceLifecycle.test.ts`: updated to cover new listServices semantics.
- [x] `adoption.test.ts`: updated to handle nullable snapshot return type.
- [x] All 152 jest tests pass.
- [x] Playwright `verify-startup.spec.ts`: confirms vllm running + terminals
      populated after HMR re-init.
- [x] Playwright `diagnose-rerender.spec.ts`: confirms only the clicked card
      mutates beyond steady output stream.

## Verification
- [x] Triggered HMR cycle on process-manager.ts to force fresh init; vllm
      correctly adopted (pid 46947 / kind=wsl) — verified via API + UI.
- [x] Output fallback verified: Llama.cpp Server / Speaches / Job Apply all
      now show their persisted log content even though they're stopped.
