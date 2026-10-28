# Deferred GitHub synchronization

GitHub synchronization is unfinished and inactive. There is no Edge Function
handler, scheduled job, or deployed connection. The dashboard continues to save
tasks directly to Supabase as before.

`github-sync.sql` is draft preparation for a future implementation. Do not run it
as part of the current dashboard setup. It adds change tracking and service-only
RPCs, but does not connect to GitHub or implement conflict resolution by itself.

The original public board snapshot is preserved in
`../backups/github-board-original-2026-10-27.json` (67 items). It contains no
GitHub token or private Google roster.

Future work must implement and test the Edge Function, latest-change-wins
resolution, retries, project mapping (EXO to exo-leg), and scheduling before
enabling synchronization. Store any credentials in Supabase secrets.
