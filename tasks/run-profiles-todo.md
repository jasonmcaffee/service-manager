# Run Profiles Implementation

- [x] 1. Update prisma schema (RunProfile, RunProfileService models)
- [x] 2. Run prisma db push to apply schema changes
- [x] 3. Create runProfileRepository.ts
- [x] 4. Create runProfileService.ts
- [x] 5. Update serviceService.ts (init default profile, buildEnv from profile, listServices/getService merge, createService creates profile rows, startService/restartService/runAutoStart use profile)
- [x] 6. Update serviceRepository.ts (remove cudaDevice/startOnBoot from UpdateServiceInput)
- [x] 7. Update PUT /api/services/[id] route (strip profile-specific fields)
- [x] 8. Create GET/POST /api/profiles route
- [x] 9. Create GET/PUT /api/profiles/active route
- [x] 10. Create PUT /api/profiles/[id]/services/[serviceId] route
- [x] 11. Update src/types/service.ts (add RunProfile, RunProfileService types)
- [x] 12. Update Header.tsx (profile dropdown + clone button)
- [x] 13. Update page.tsx (fetch profiles, pass to Header, handle profile switch)
- [x] 14. Update EditServiceModal.tsx (split save, add [profile]/[global] badges)
- [x] 15. AddServiceModal.tsx unchanged (cudaDevice/startOnBoot already route to profile via createService)
- [x] 16. Update existing serviceService tests to mock runProfileRepository
- [x] 17. Write new runProfileService tests
- [x] 18. Run tests - 31/31 passing
