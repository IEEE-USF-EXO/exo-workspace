# EXO Workspace — Architecture

This is the source of truth for how the app is structured. Read it before changing anything.
If a change conflicts with this document, change the document first (and say so), not the code quietly.

## 1. What the app is

A workspace for an IEEE engineering chapter. The chapter works on several projects over time.
Small groups form for a task, finish, and disband. Everyone in the chapter can see everything;
each person's default view only shows what is relevant to them.

Stack: static frontend (native ES modules, no bundler), Supabase (Auth, Postgres, Realtime, Storage),
Google Drive (files and backups), Tldraw pinned at **3.15.6**. No backend server in phase 1.

## 2. Core concepts

| Concept | Meaning |
| --- | --- |
| **Member** | A signed-in Google account. Has `status`: `pending`, `approved`, `disabled`. Only `approved` members can see or change anything. |
| **Project** | A long-lived effort (EXO, PID Spoon). Has a lifecycle `status`: `active`, `paused`, `completed`, `archived`. Linked to one Drive folder. Archiving never deletes data. |
| **Group** | A small, short-lived team. Belongs to one project (or is club-wide if `project_id` is null). Has members. Archived, not deleted, when disbanded. |
| **Task** | Work item in a project, assigned to a group, optionally to a person. |
| **Dependency** | "Task B cannot finish until task A is done." Directional, drives notifications and the default view. |
| **Group link** | "These two groups collaborate." Symmetric, explicit, optional. |
| **Board** | A Tldraw canvas (with several pages) belonging to a project, optionally to a group. |
| **Event** | Append-only log row: who did what, where. Integrations read this. |

### Access vs attention

- **Access:** every approved member can read and write everything. Trust model is open. Safety nets are soft-delete, tombstones and board backups, not permissions.
- **Attention:** each person's default view is a *lens*: my groups' tasks and boards, tasks my tasks depend on (status only), and groups linked to mine. A "show everything" toggle removes the lens.
- If the club later needs real isolation, it goes through one function (`is_approved()` and friends in SQL, `ctx.can()` in JS). Do not scatter permission checks.

## 3. Repository layout

```
index.html                     shell, CDN deps, <script type="module" src="src/main.js">
src/
  main.js                      boot sequence (section 5)
  core/
    config.js                  constants (Supabase URL, anon key, Drive root id, reserved folder names)
    supabase.js                the one Supabase client
    auth.js                    session + membership status; emits auth state
    router.js                  hash router (section 6)
    ctx.js                     builds the shared context object
    events.js                  in-process bus + durable event logger
    registry.js                list of modules; the ONLY place modules are registered
    ui.js                      toast, modal, loading/empty/error helpers
  services/
    drive/                     Drive connector (token state, list/upload/create-folder)
    storage/                   Supabase Storage helpers (board assets)
  modules/
    projects/  groups/  tasks/  board/  files/  gallery/  bom/  resources/  updates/  activity/  admin/
      index.js                 module definition (section 4)
      data.js                  the ONLY file in the module that talks to the database
      view.js                  UI
supabase/migrations/NNN_name.sql   numbered, additive, re-runnable
docs/ARCHITECTURE.md           this file
```

Adding a feature = new folder in `modules/` + one line in `registry.js`.
Removing a feature = delete the folder + that line. Nothing else may reference a module by name.

## 4. Module contract

```js
export default {
  id: 'tasks',
  nav: { label: 'Tasks', icon: 'tasks', order: 30, view: 'tasks' }, // omit for headless modules
  async init(ctx) {},              // once, after the member is approved
  mount(el, ctx, params) {},       // render into `el` only. Never touch other DOM.
  unmount() {},                    // MUST release listeners, channels, timers, editors
  onProjectChange(projectId, ctx) {} // optional
}
```

`ctx` (read-only handle passed to every module):

```js
{ supabase, user, member, isAdmin,
  project,            // current project row or null
  myGroups,           // groups I belong to (ids)
  route,              // parsed route
  bus,                // in-process pub/sub
  log(event),         // write to the events table (fire-and-forget)
  drive,              // Drive service
  ui                  // toast / modal
}
```

Rules:
1. **A module owns its tables.** Only that module's `data.js` queries them. Other modules ask via `bus` or a function the owner exports.
2. **No global `render()`.** A module re-renders its own container only.
3. **No shared blob.** One owner, one table, one sync strategy per kind of data.
4. **`unmount()` is mandatory and must be complete.** Leaks here caused the legacy remount/ghost-listener bugs.
5. Modules never read `window.location` directly; they get `params` from the router.

## 5. Boot sequence (a state machine, not a pile of async calls)

```
CONFIG → AUTH → GATE → LOAD → ROUTE → MOUNT
```

1. **AUTH:** `getSession()` once. Register **one** `onAuthStateChange` handler. No duplicate session checks.
   - signed out → login screen. Stop.
2. **GATE:** read own `members` row (upsert on first sign-in; status defaults to `pending`).
   - `pending` / `disabled` → "waiting for approval" screen. Stop. Nothing else loads.
3. **LOAD:** projects (non-archived by default), my groups, group links. Build `ctx`. Run each module's `init(ctx)`.
4. **ROUTE:** parse the hash. If no project in the URL, use `localStorage['exo:lastProject']` if it still exists, else the first active project. The project is always resolved here, before any view mounts.
5. **MOUNT:** mount the nav and the current view module. Drive connector initialises in the background and never blocks first paint.

A project switch or view change = `unmount()` the current module, then `mount()` the next. Nothing re-renders the whole page.

## 6. Routing

Hash routes (static hosting friendly):

```
#/p/<projectId>/<view>[/<param>]     e.g. #/p/pid-spoon/board/3f2a...  #/p/exo/tasks
#/admin                               approvals and project lifecycle
```

The URL is the source of truth for "where am I". Legacy hashes (`#drawing-board`, `#files`, ...) redirect to the new form. Never keep `scope`/`view` in mutable globals.

## 7. Data ownership

| Module / service | Owns | Sync strategy |
| --- | --- | --- |
| `projects` | `projects` | Load on boot; refetch on project actions |
| `groups` | `groups`, `group_members`, `group_links` | Load on boot; refetch on change |
| `tasks` | `tasks`, `task_dependencies` | Postgres Realtime (`tasks`) |
| `updates` | `updates` | Postgres Realtime (`updates`) |
| `board` | `boards`, `board_records`, `board_backups`, Storage bucket `board-assets` | Broadcast + DB write-through + rev catch-up (section 8) |
| `files`, `gallery` | nothing in the database | Read Drive live, in-memory cache (TTL ~60 s) |
| `bom` | `bom_items`, `bom_change_requests`, `bom_audit_log`, `projects.bom_drive_file_id` | Load on mount |
| `resources` | `resources` | Load on mount |
| `activity` | reads `events` | Load on mount; optional Realtime later |
| `admin` | `members.status`, `global_admins`, `projects.status` | Load on mount |
| `drive` (service) | Drive token state (sessionStorage) | n/a |
| core `events` | `events` | Append-only insert |

`workspace_state` and `board_view_state` are **legacy**: read only during migration, then dropped.

## 8. Board sync protocol (Tldraw)

### Storage model
One row per Tldraw record in `board_records(board_id, record_id)`. Whitelist of `type_name`: `page`, `shape`, `asset`, `binding`.
Never persist or send: `instance`, `instance_page_state`, `camera`, `pointer`, `instance_presence`, `document`.
Deleting = update the row with `deleted = true` (tombstone). Hard purge is admin-only.
`page_id` is resolved **by the client at write time** (walk `parentId`; a binding takes its `fromId` shape's page; assets are null). It exists for backups and page restore. **It is never used to filter what goes over the wire.**

### Wire rules
- Every document-scope change from `source: 'user'` is sent: all pages, all record types in the whitelist.
- **No page or parent-chain filtering on the wire.** Legacy filtering dropped assets that arrived before their shape (late-appearing links) and dropped bindings (no `parentId`).
- A message carries `{ boardId, clientId, put: [...], remove: [...] }`. Receivers apply `asset` first, then `page`, then everything else, inside `store.mergeRemoteChanges()`.
- Ignore messages with your own `clientId`.
- One channel per board: `board:<boardId>`. Pointer presence uses the same channel, throttled (~20/s), never persisted.

### Write path
1. `store.listen(cb, { scope: 'document', source: 'user' })` collects changes.
2. Broadcast immediately.
3. Debounce ~300 ms, then upsert the changed rows in chunks (≤200 rows). Assets and the shapes that use them go in the same flush.
4. Failure → keep the batch in an in-memory queue, retry with backoff, show "n changes not saved yet". Flush on `visibilitychange: hidden`.

### Hydration order (this is what fixes "doesn't load until I switch project")
1. Resolve `boardId` from the route **before** mounting Tldraw.
2. Mount Tldraw with a loading overlay. Do not touch the store yet.
3. Subscribe to the channel and **buffer** incoming messages.
4. Fetch all non-deleted rows for the board (paginate). Remember `maxRev`.
5. Apply them in one `mergeRemoteChanges`. Hide the overlay.
6. Drain the buffer. Start the local write listener only now.
7. On every `SUBSCRIBED`, on reconnect and on tab becoming visible: fetch rows with `rev > maxRev` (including tombstones) and apply them.

A new board is seeded with one page ("Page 1") via the same write path.

### Assets
- Images: compress client-side (max 1600 px, WebP/JPEG ~0.8), upload to Storage `board-assets/<boardId>/<sha256>.<ext>`. Implement Tldraw's `TLAssetStore` (`upload` / `resolve`); the record stores the storage path, `resolve` returns a signed URL.
- Bookmarks: register a `url` external-asset handler that returns a bookmark asset **synchronously** (`src` = URL, title = hostname). It then travels in the same flush as its shape. A richer preview (title/image) needs a server-side unfurl: that is a later Edge Function, not phase 1.
- Never store base64 in `board_records`.

### Camera
Per-user, per-board, per-page, in `localStorage['exo:camera:<boardId>:<pageId>']`. Never shared, never in the database.

### Restore
Restoring a page = upsert its records from the backup (new `rev`) + tombstone records on that page that are not in the backup, then broadcast `board-reset` so open clients re-hydrate. A safety backup is taken first.

## 9. Google Drive rules

- The connector exposes `status()` ∈ `absent | ok | expired` and throws `DriveAuthError`. UI shows a "Reconnect Google Drive" control from the status. **Auth errors never trigger a global re-render.**
- Drive file listings are **not** copied into the database. `files` and `gallery` read Drive on demand.
- Drive does **not** decide whether a project exists. A project row links to a folder through `projects.drive_folder_id`.
  - Creating a project in the app: slug id (kebab-case of name, suffix on collision) → create the Drive folder → insert the row.
  - Importing: admin action lists root folders not yet linked; admin links each to a new or existing project.
  - A linked folder that disappears shows a "Drive folder missing" badge. **Nothing is deleted.**
  - Never invent project ids with random UUIDs from folder names (legacy bug).
- Reserved folder names, never projects: `board-backups`, `drawing-backups`.
- The Drive scope is broad (restricted by Google). Plan to request it after approval, not at first sign-in.

## 10. Backups

- **Source of truth is Postgres.** Drive backups are archives.
- Triggered only by (a) an explicit "Back up now" button, or (b) an admin session after a board changed and ≥ 24 h passed since its last backup. **Never on page load for everyone.**
- A backup is one JSON file per board: `exo-board-backup`, version, board id and name, project id, savedAt, tldraw version, all non-deleted records (pages included), and the list of asset paths.
- Location: `<project folder>/drawing-backups/<board name> [<board id>]/<ISO timestamp>.json`.
- Skip if `content_hash` (hash of the canonical sorted records) equals the latest row in `board_backups`. Record each backup in `board_backups`.
- Retention: keep the latest 30 per board; prune older ones when creating a new backup.
- Asset binaries are archived to `drawing-backups/_assets/` once per sha256, not per backup.

## 11. Auth, approval and security

- Anyone with a Google account can sign in; only `approved` members get access. Enforced in **RLS** (`is_approved()`), not just the UI.
- The `members` table protects `status`, `active` and approval columns with a trigger: users cannot approve themselves.
- Admins (`global_admins`) approve members, change project lifecycle, purge tombstones.
- The Supabase anon key in the frontend is public by design; RLS is the protection. Never put the `service_role` key in the repo.
- Hardening step: make Realtime channels **private** with policies on `realtime.messages` so unapproved users cannot subscribe. Verify the current Supabase docs for the exact syntax before implementing.

## 12. Extension points (do not build yet)

- **Discord:** a consumer of `events`. Needs a server (Edge Function) for the bot token and scheduled delivery.
- **GitHub board:** syncs into `tasks` using `external_source` / `external_id` and writes `events`. Webhooks need an Edge Function.
- **Scheduled backups / link unfurling:** Edge Functions. Drive from a function requires a Google service account with the folder shared to it.
Nothing in `core/` or any module may mention Discord or GitHub.

## 13. Browser storage keys

| Key | Storage | Purpose |
| --- | --- | --- |
| Supabase session | localStorage | Auth |
| `google_provider_token` | sessionStorage | Drive token (no refresh flow) |
| `exo:lastProject` | localStorage | Fallback when the URL has no project |
| `exo:camera:<boardId>:<pageId>` | localStorage | Per-user camera |
| `exo:sidebarCollapsed` | localStorage | UI preference |

## 14. Decisions log

- Open read/write for approved members. Revisit only if accidental damage becomes a real problem.
- Project creation is open to approved members in migration 001 (legacy app compatibility); becomes admin-only in the cleanup migration.
- Frontend-only in phase 1; Edge Functions arrive with the first integration.
- Tldraw stays on 3.15.6. Upgrading is a separate task.
