# EXO Project Workspace

A browser-based dashboard for organizing engineering projects. It is built around the **EXO lower-limb exoskeleton** and **PID Spoon** projects, and brings together a collaborative drawing board, Google Drive files, a shared Bill of Materials, a photo gallery, and project resources in one place.

It is a standalone frontend: plain HTML, CSS, and vanilla JavaScript, with no build step.

## Features

- **Overview** — workspace summary (files, project cards, relationships, gallery photos) with shortcuts to the main areas.
- **Drawing board** — a real-time collaborative [Tldraw](https://tldraw.dev) canvas with multiple pages.
- **Files** — browse, upload, and organize files in Google Drive.
- **BOM** — shared Bill of Materials backed by Supabase, with search, filters, and CSV preview.
- **Photo gallery** — project photos with team and notes metadata.
- **Resources** — repositories and team Drive links.
- **Backup and restore** — export and import the workspace as JSON.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, vanilla JavaScript (no framework or bundler) |
| Drawing | Tldraw |
| Auth | Supabase Auth with Google OAuth |
| Database and realtime | Supabase Postgres and Realtime Broadcast |
| Files | Google Drive REST API |
| Local storage | Browser storage for the Drive token and local workspace data |

Dependencies are loaded from a CDN in `index.html`.

## Repository structure

```
.
├── index.html            # Page structure and CDN dependencies
├── app.js                # Application logic and state
├── style.css             # Visual styling
├── supabase-schema.sql   # Supabase database setup and RLS policies
├── README.md
└── content/              # Project icon and work-in-progress image
```

## Getting started

### Prerequisites

- A [Supabase](https://supabase.com) project
- A Google OAuth client configured in Supabase, with Google Drive access
- Access to the project's Google Drive folders
- A way to serve static files over HTTP (for example, localhost or GitHub Pages)

> Google sign-in does not work when `index.html` is opened directly as a `file://` URL. Serve the folder over HTTP instead.

### Setup

1. **Create the database.** Run `supabase-schema.sql` in your Supabase SQL editor. This creates the tables and Row Level Security policies.
2. **Configure Supabase.** Set your Supabase project URL and public key in the configuration at the top of `app.js`.
3. **Enable Google sign-in.** Turn on the Google provider in Supabase Auth, and make sure the app requests the Google Drive scope.
4. **Configure Drive folders.** Update the Drive folder IDs in the configuration at the top of `app.js` to match your team folders. The Drive browser and board backups use the configured `ROOT_DRIVE_FOLDER_ID`.
5. **Serve the app.** For example:

   ```bash
   python3 -m http.server 8000
   ```

   Then open `http://localhost:8000`.

## How it works

### Authentication and membership

1. The user signs in with Google through Supabase.
2. Supabase returns an authenticated session.
3. The app stores the Google provider token in `sessionStorage` so it can call Google Drive.
4. The app creates or updates the user's profile in the `members` table.
5. Shared BOM data is loaded.
6. Google Drive synchronization runs if a Drive token is available.

The database supports members, project memberships, global administrators, admin-controlled BOM changes, and a BOM audit history.

### Drawing board

The visible board is a Tldraw canvas supporting freehand drawing, shapes, text, arrows and connectors, selection, deletion, and Tldraw's native camera and zoom. Pages included by default:

- Main Architecture
- Controls Breakout Room
- Electrical Breakout Room

Real-time collaboration uses two mechanisms:

**1. Supabase Broadcast for live changes.** When a user edits the document, the store listener captures only user-originated changes and splits them into `added`, `updated`, and `removed` records. Local-only records (camera, pointer, instance, and instance page state) are filtered out. The remaining changes are broadcast over a shared channel, and other clients apply them to their own stores, including remote deletions.

**2. Debounced database persistence.** Drawing edits are not written to Postgres on every pointer movement. The app waits one second after the most recent user change, then saves the full workspace state to Supabase. This keeps database traffic low and drawing responsive.

**Viewport protection.** Camera and viewport records are excluded from remote updates, so another user's camera position, zoom, pointer, or page state never overrides your view. The app also avoids calling the global `render()` while the board is visible, which would otherwise unmount Tldraw and reset the camera.

**Deleting.** Deletion goes through the active Tldraw editor, so it follows the same path as drawing: the store updates, the listener detects the change, the removal is broadcast, the local snapshot is updated, and the database save is debounced.

### Files (Google Drive)

- Authenticate with Google Drive
- Read the configured Drive folders and recursively list nested files
- Upload files, create folders, and upload whole folders with their contents
- Associate file metadata with projects and teams
- Open Drive previews and download files

If the Drive token expires, the app clears only the Drive token. You stay signed in and the Files view prompts you to reconnect Google Drive.

### Bill of Materials

- Load shared BOM rows from Supabase
- Search and filter items
- Select a master BOM file and preview CSV-style data
- Track project, subsystem, supplier, quantity, cost, stage, and source

The shared BOM is stored in `bom_items`, with optional review and history
support in `bom_change_requests` and `bom_audit_log`.

### Photo gallery

Displays PNG, JPEG, WebP, GIF, and AVIF images with their project, team, and note information.

### Resources

Repository links and team Drive links. Each record has a title, team, project, URL, description, and basis or source.

## Data model

The Supabase schema contains the following application and collaboration tables:

- `projects` — seeded project metadata and the foreign-key target for BOM rows.
- `members` — authenticated users who have opened the workspace.
- `project_members` — project-level membership and roles.
- `global_admins` — global administrator roster.
- `bom_items` — shared, approved BOM rows.
- `bom_change_requests` — proposed BOM insert, update, and delete operations.
- `bom_audit_log` — administrator-visible BOM history.
- `workspace_state` — the shared dashboard document, including files, resources,
  drawing snapshots, project updates, and BOM selections.

The main workspace object includes the current Tldraw document snapshot. Older fields (`nodes`, `edges`, `strokes`) remain because parts of the dashboard and the backup validation were originally built around the previous custom HTML/SVG board. That earlier board code still exists in `app.js`, but it is no longer the visible drawing surface.

## Backup and import

- Export the workspace as JSON, including local file data when available
- Import a backup after confirmation, which replaces the current workspace state
- The Files view starts at the configured `ROOT_DRIVE_FOLDER_ID` (`Projects-Testing-Folder`).
- Automatic and manual Tldraw board backups are saved append-only in `board-backups/<project>/<page>/` folders created inside that root folder. Existing `drawing-backups` folders are also recognized for compatibility.

## Known limitations

- **Backup validation is out of date.** It still expects the legacy `nodes`, `edges`, and `strokes` fields. Tldraw snapshots should become first-class in backup export and validation.
- **Legacy board code remains** in `app.js` and can eventually be removed.
- **No backend server.** The frontend talks directly to Supabase and Google Drive, so there is no refresh-token flow for Google. Expired Drive tokens require reconnecting.
- **Drive folder IDs are hardcoded** in `app.js`, including the Drive root folder.
- **No automated tests, linting, or build checks** at present.

## Contributing

1. Make your changes in `index.html`, `app.js`, or `style.css`.
2. Test manually over HTTP, ideally in two browser windows to check real-time sync.
3. If you change the database, update `supabase-schema.sql` and note any migration steps.
4. Keep this README in sync with the implementation.
