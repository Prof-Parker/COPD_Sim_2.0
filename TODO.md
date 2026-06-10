# COPD Simulation 2.0 — Project TODO

**Version:** 2.0.11 (Beta)  
**Repo:** [Prof-Parker/COPD_Sim_2.0](https://github.com/Prof-Parker/COPD_Sim_2.0)  
**Last updated:** May 2026

##Priority Items for next session

- [ ] Test all scenes
- [ ] Troubleshoot patient message displaying all the way from hallway_in_repeat
- [ ] Reset random number generator for wildroll
- [ ] Add sound effects
- [ ] Add images
- [ ] Check line breaks and formatting on debriefing screen (switch to html styling)
- [ ] Debug try again button for observer.
- [ ] Stop clock on game over and win screens

---

## Done

- [x] Multiplayer framework (Playroom, roles, sync, tether)
- [x] Host invite QR modal
- [x] Tutorial / Simulation Hub briefing flow
- [x] Mobile layout fixes (iPhone passage alignment)
- [x] Footer UI (`patient-choices`, `dynamic-eval`, `patient-next`, grid layout)
- [x] Faculty macro guide (`FACULTY-MACRO-GUIDE.md`)
- [x] Host dev mode (`$devMode` in StoryInit)
- [x] Morning ADL chain (partial): Good Morning → Shower → Teeth → Lotion → Dressing

---

## Content — passages & narrative

- [x] **Breakfast** — empty stub; Dressing links here but passage has no content
- [x] **Post-ADL hub** — after breakfast, patient picks first errand (uses `visited*` / `errandsRun` vars)
- [x] **Grocery store** activity
- [x] **Pharmacy** activity (prescription pickup)
- [x] **Pulmonary rehab clinic** activity
- [x] **Toy store** activity (granddaughter's gift)
- [x] **Debrief / end screen** — points, time, tie-breaker, “return to room 8220”
- [ ] **Sound effects** - port sound effects over from harlowe version
- [ ] **Win / leaderboard** logic if teams compete across rooms
- [ ] **Money system** for certain choices such as ordering pizza or buying groceries

---

## Bugs & polish

- [x] Fix **Dev Mode**. page is completly blank
- [ ] Tweek tutorial section for better user experience (max number of energy drop etc)
- [x] Fix **Lotion** `<<dynamic-eval>>` pipe syntax (observer buttons likely broken)
- [x] Copyedit typos (`Holand`/`Holland`, `lavendar`, `@.holland` vs `@@.holland`, etc.)
- [ ] Wire **visited** flags (`visitedGrocery`, `visitedPharmacy`, etc.) as errands are completed
- [ ] Remove or finish **legacy widgets** (`Patient_Next_Button`, `Dynamic_Eval_Button`)

---

## Testing & deployment

- [ ] Full **multiplayer QA** — host/patient/observer on iPhone 16 Pro + desktop (Safari/Chrome)
- [x] Test **dev mode** — variable overrides sync to Playroom; team navigation works
- [ ] Set `**$devMode to false`** in StoryInit before class
- [ ] **Publish workflow** — Twine → `index.html` → commit/push Beta after each change
- [ ] **Merge Beta → master** when class-ready (version bump per `.cursorrules`)

---

## Documentation

- [ ] Keep `**FACULTY-MACRO-GUIDE.md`** updated as new activity patterns are added
- [ ] Optional: short **dev mode** note for faculty (how to enable `$devMode`)

---

