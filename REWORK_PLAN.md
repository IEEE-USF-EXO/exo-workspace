# EXO Workspace Rework — Implementation Plan

**Audience:** GitHub Copilot (agent mode) and the maintainer.
**Read first:** `docs/ARCHITECTURE.md` and `.github/copilot-instructions.md`. They are binding.

## How to work

- One phase per branch and pull request. Do not start a phase until the previous one's acceptance checks pass.
- Database changes are **additive** until Phase 7. The legacy app (`app.js`, workspace blob) must keep working for approved members the whole time. Keep it deployed under `legacy/` until Phase 7.
- Never delete user data. Migrations produce a **dry-run report** first (counts per table, orphans, anything skipped) and wait for the maintainer to approve.
- No new dependencies unless they are loaded from a CDN with a pinned version.
- When something in the plan looks wrong or ambiguous, stop and ask. Do not improvise around it.

## Why this rework exists (the problems to eliminate)

1. `scope` starts as `""` and is only set inside `syncDriveFiles()`, so Tldraw can mount before a project is known. `render()` begins with `disposeTldrawBoard()` and runs several times during boot (auth handlers, Drive sync, boot), so the board is mounted and torn down repeatedly.
2. All shared state lives in one JSON row (`workspace_state`, id 1), saved by whole-document last-write-wins. One client can overwrite another's drawings or updates.
3. `syncDriveFiles()` rebuilds the project list from Drive folder names, mints random ids for unmatched folders, filters `projectDrawings` to surviving ids and saves. A renamed folder can erase a project's drawings.
4. Wire filtering by page-parent chain drops assets that arrive before their shape (late-appearing links) and drops bindings, which have no `parentId`.
5. Board backups run for every user on every page load, per page, re-uploading assets each time.
6. Any authenticated Google user can read and write everything.
7. Images are base64 inside the shared JSON row.

## Phase 0 — Safety net (small, do first)

- [ ] Add an admin-only "Export everything" that downloads `workspace_state.data` as JSON. Run it and store the file outside the repo.
- [ ] Tag the current commit `pre-rework`.
- [ ] In legacy `app.js`: remove the startup auto-backup loop (the block after `render()` in the boot IIFE that calls `backupBoardToDrive` for every project).
- [ ] In legacy `syncDriveFiles()`: stop filtering `projectDrawings`, `projectUpdates`, `resources`, `bom` by surviving project ids. Never drop data there.

**Accept:** reloading the site creates no new files in Drive; renaming a Drive project folder loses no drawings.

## Phase 1 — Foundation and approval gate

- [ ] Run `supabase/migrations/001_foundation.sql` on a **test Supabase project** first, then production. Then bootstrap the first admin (section 12 of the SQL).
- [ ] Create the skeleton in `ARCHITECTURE.md` section 3: `index.html` with `<script type="module" src="src/main.js">`, `core/*`, empty `modules/*`, `registry.js`.
- [ ] Implement the boot state machine (architecture section 5) with real screens: login, waiting-for-approval, error.
- [ ] Implement the hash router and legacy-hash redirects.
- [ ] Implement `modules/admin`: list pending members, approve / disable, project lifecycle (set status).
- [ ] Single `onAuthStateChange` handler. Remove duplicate `checkUserSession` flows.

**Accept:**
- A brand-new Google account lands on the waiting screen and sees no data; calling the REST API with that account's token returns empty or 403 for every table (test it, do not assume).
- That user cannot change their own `status` (the trigger raises).
- An admin approves them and they get in without reloading twice.
- Console shows each module's `mount` exactly once per navigation.

## Phase 2 — Projects registry and boards (fixes the load bug)

- [ ] `modules/projects`: project switcher driven by the URL and `projects` rows; `exo:lastProject` fallback. Archived projects hidden by default.
- [ ] One-time **data migration script** (run from an admin-only page, with dry run):
  - For each project that has `projectDrawings[projectId]`, create a `boards` row ("Main board") and explode its `store` into `board_records`.
  - Whitelist `page`, `shape`, `asset`, `binding`. Keep existing page ids and names as they are. Do not run the old page-rename migration again.
  - Resolve `page_id`. Records whose page cannot be resolved are **kept** with `page_id = null` and listed in the report (the legacy migration dropped them).
  - Convert base64 assets to Storage objects, rewrite the asset record `src` to the storage path.
  - Do not modify `workspace_state`.
- [ ] `modules/board` per architecture section 8: hydration order, wire rules, write path, assets, bookmark handler, presence, camera in localStorage, board picker per project (create board, rename, archive).
- [ ] Tldraw stays at 3.15.6.

**Accept (test with two browsers, two approved accounts):**
- Open `#/p/exo/board/<id>` in a fresh incognito window: board renders once with a loading overlay, no flash of an empty or wrong board, no project switch needed.
- Hard-reload five times: always the same board, mount count 1.
- Paste a bookmark URL in window A: window B shows the card within ~1 s and it never changes later.
- Draw arrows bound to shapes in A: B shows the bindings.
- Paste an image in A: B shows it; the database row contains a storage path, not base64.
- Disconnect B's network for 30 s while A draws; reconnect: B catches up without reload.
- Delete a shape in A: it disappears in B and stays gone after reload.
- Switch project/board 20 times quickly: no console errors, no duplicate channels (check `supabase.getChannels()`).

## Phase 3 — Drive service, files, gallery, resources

- [ ] `services/drive`: status machine, `DriveAuthError`, list / upload / create-folder / folder upload, 60 s in-memory cache.
- [ ] `modules/files`: Drive browser rooted at the current project's linked folder (admins can browse from the Drive root).
- [ ] `modules/gallery`: images listed from Drive on demand (query by MIME type under the project folder).
- [ ] `modules/resources`: table-backed; migrate `state.resources`.
- [ ] Admin action "Import projects from Drive": lists unlinked root folders, links each to a new or existing project. Creating a project in the app creates the folder, then the row.
- [ ] **Before deleting `state.files`:** inspect the legacy upload form (`showUpload`) and the gallery to see whether users enter notes or team labels that cannot be recomputed from Drive. If so, add a small `file_meta(drive_file_id, project_id, team, note)` table; do not lose that data.

**Accept:** an expired token shows a reconnect control and nothing else re-renders; renaming or removing a Drive folder never changes project rows; no Drive listing is written to the database.

## Phase 4 — Backups

- [ ] `modules/board/backup.js` per architecture section 10: manual button, admin-session auto trigger, hash dedupe via `board_backups`, retention 30, assets archived once by hash.
- [ ] Restore from backup with safety backup first, row upserts, tombstones, `board-reset` broadcast.

**Accept:** opening the site 10 times creates zero backup files; editing then clicking "Back up now" twice creates one file; restoring a page updates an open second browser without reload.

## Phase 5 — Groups, tasks, dependencies, updates, activity

- [ ] `modules/groups`: create / archive groups, members, group links. People can be in several groups.
- [ ] `modules/tasks`: create/edit tasks, assign to group and person, dependencies (reject cycles in the app), status changes. Default **lens** view (architecture section 2) with a "show everything" toggle.
- [ ] Dependency behavior: when a task becomes `done`, log `task.completed` and show it to groups whose tasks depend on it. Dependent tasks show "waiting on X" with status only.
- [ ] `modules/updates`: replace `state.groups[].updates` and `state.projectUpdates`.
- [ ] `core/events.js` `log()` and `modules/activity` feed filtered by the lens. Event types to start with: `project.created`, `project.archived`, `group.created`, `group.archived`, `group.member_added`, `task.created`, `task.status_changed`, `task.completed`, `board.created`, `board.restored`, `backup.created`, `member.approved`.
- [ ] Migrate legacy data. **Inspect the real data first and report back**: legacy `groups` are update-feed groups with no project; map each to a club-wide group (`project_id` null) with its updates in `updates`, unless the maintainer says otherwise.

**Accept:** use the PID Spoon example: groups CAD, Controls, PCB; CAD's "enclosure" depends on PCB's "board dimensions"; CAD and PCB are linked; Controls is not. A Controls member's default view shows neither CAD's nor PCB's tasks; a CAD member sees PCB's task status; completing the PCB task shows up in CAD's feed and not Controls'.

## Phase 6 — BOM and leftovers

- [ ] `modules/bom`: read `bom_items`; migrate `state.bomEntries` into `bom_items` with `source = 'workspace'`; migrate per-project master file selection into `projects.bom_drive_file_id`. Keep the CSV preview.
- [ ] Fix mojibake in `bom` import text and UI labels (`ï¼‹` style garbage) at the source.
- [ ] Remaining overview widgets read from the new modules.

**Accept:** every legacy view has a module equivalent; the overview counts match the legacy numbers.

## Phase 7 — Cutover and cleanup

- [ ] Maintainer confirms all data migrated and spot-checks it.
- [ ] Migration `002_cleanup.sql`: make `projects` insert admin-only; make `workspace_state` read-only (revoke update), then drop `workspace_state` and `board_view_state` after one more export.
- [ ] Delete `legacy/`, `migrateProjectDrawings`, the old SVG board code, the global `render()`.
- [ ] Update `README.md` to match `docs/ARCHITECTURE.md`; fix the IndexedDB claim (it is not implemented).
- [ ] Optional hardening: private Realtime channels with `realtime.messages` policies.

## Open items the maintainer should resolve

- Does the legacy file upload form store notes or teams that cannot be re-derived from Drive? (Phase 3)
- What do the legacy "groups" mean in practice? (Phase 5)
- Google verification: the full Drive scope is restricted. Decide whether to request it only after approval. (Phase 1/3)
- Supabase free tier pauses projects after about a week of inactivity and has a 500 MB database cap. Plan for keep-alive or Pro before a long break.
- Edge Functions, Discord and GitHub are deliberately out of scope until the above ships.
