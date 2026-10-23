# Copilot instructions — EXO Workspace

Before any change, read `docs/ARCHITECTURE.md`. For rework tasks also read `REWORK_PLAN.md` and work only on the current phase.

## Non-negotiable rules

1. **Structure.** Features live in `src/modules/<name>/` with `index.js`, `data.js`, `view.js`. Register in `src/core/registry.js` only. Nothing else references a module by name.
2. **Ownership.** Only a module's `data.js` queries that module's tables. Cross-module needs go through `ctx.bus` or an exported function of the owning module.
3. **No global rendering.** Never write a function that rebuilds the whole page. A module renders into its own `el` and implements `unmount()` that releases every listener, timer, channel and editor.
4. **No global mutable app state** (`scope`, `view`, `state`). Read the route from the router, data from the module.
5. **No shared JSON blobs** in the database. One owner, one table, one sync strategy per kind of data.
6. **The URL decides where the user is.** Resolve the project and board before mounting any view.
7. **No patches around symptoms.** If a bug is caused by structure, fix the structure or ask. Do not add flags, timeouts or retries to hide a race.
8. **Never delete user data.** Archive, tombstone or hide. Migrations must support a dry run and report counts, orphans and skipped rows.
9. **Database changes** are numbered files in `supabase/migrations/`, additive and re-runnable (`if not exists`, `drop policy if exists`). Every new table gets RLS enabled with policies using `is_approved()` / `is_admin()`.
10. **Security.** Never use or commit the `service_role` key. Never trust the client for authorization; it belongs in RLS.
11. **Dependencies.** Native ES modules, no bundler. External scripts only from a CDN with a pinned version. Tldraw stays at 3.15.6.
12. **Logging.** User-visible actions that other people care about call `ctx.log({ type, projectId, groupId, entityType, entityId, payload })`. Event types are `noun.verb`.
13. **No integration code in core.** Discord and GitHub do not appear in `core/` or in any module.

## Tldraw board rules (summary; details in ARCHITECTURE section 8)

- Persist and send only `page`, `shape`, `asset`, `binding`. Never `instance`, `camera`, `pointer`, `instance_presence`, `document`.
- No page or parent-chain filtering on the wire. Apply `asset`, then `page`, then the rest.
- Hydrate from the database, buffer realtime messages meanwhile, then start the local write listener.
- No base64 in the database. Images go to Storage via the asset store; bookmarks are created synchronously.
- Camera is per-user in localStorage.

## Style

- Plain modern JavaScript, small functions, JSDoc on exported functions.
- Handle errors where they happen and surface them with `ctx.ui.toast`; never swallow.
- Keep each file focused. If a file passes ~300 lines, split it.
- Comment *why*, not *what*.

## Before you open a pull request

- Acceptance checks for the current phase pass (they are manual; list what you tested).
- Console is clean on boot and on navigation; each module's `mount` runs once per navigation.
- `docs/ARCHITECTURE.md` still matches the code. If you changed a decision, update the doc in the same PR.
