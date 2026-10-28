# Supabase SQL

For the current dashboard update, run `independent-teams.sql` once in the
Supabase SQL Editor, then refresh Workbench. It removes the task requirement for
project/team links without deleting existing tasks or legacy links. Members can
view all projects; existing team and leadership scopes still control task edits.
Fresh installations use the updated root `schema.sql` instead.

Then run `group-task-access.sql` to restrict task reads to saved group memberships
and scoped leadership. Parent-team membership includes descendant subteams;
subteam membership excludes parents and siblings. EXO chairs retain all groups.
Shared projects, team information, milestones and reference links remain readable.

## Deferred GitHub synchronization

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
