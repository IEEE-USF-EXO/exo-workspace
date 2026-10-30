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

## Roster-based onboarding

Install `roster-memberships.sql` after the core schema. Then run a separately
prepared private roster seed in SQL Editor. Keep email-filled seeds outside this
public repository and website directory; the reusable migration has no emails.

Pre-approvals match the account's primary email to a verified Google identity.
They apply to existing accounts when the private seed runs, or automatically at
first verified sign-in. Each approval is consumed once: later sign-ins do not
restore a membership a chair has removed. Leadership assignments are separate.
Rows without a clear email/group mapping must be reviewed before approval.

Prepare a private import from the roster workbook with Python and `openpyxl`:

```text
python supabase/prepare-roster.py "INPUT.xlsx" "PRIVATE_OUTPUT_DIRECTORY"
```

The output directory must be outside this repository and the website. Review
`approved-memberships.csv` and `roster-review.json`, then run the generated
`install-roster.sql` in Supabase SQL Editor as postgres. It installs the onboarding
triggers, resolves or creates the required groups, saves approvals, and backfills
existing verified Google accounts in one transaction. Its result lists assigned,
pending, disabled, and previously consumed approvals. Run the complete script.

Repeated email/group rows collapse to one approval. Explicit alternate emails
remain separate accepted login addresses with the same group mappings. They do
not merge Supabase Auth accounts if someone signs in using both. Subteam members
receive their leaf group; cross-team entries retain their explicitly listed root
and the uniquely matched subteam from the Teams tab. Ambiguous mappings are
excluded for review. No chair or lead roles are inferred from the workbook.
Reruns preserve existing memberships, consumed approvals, and disabled approvals.

## Assign before sign-in and create subgroups with people

Run the newly generated private `install-roster.sql` to upgrade an existing roster.
It includes `roster-task-assignment.sql` and the workbook's person/alias mappings.
Running only the generic migration adds the feature but does not populate people's
names; run the private import too. Both scripts require the activity/history
extension. Publish the updated `app.js`, `index.html`, and `styles.css` together.

`roster_people` stores one member-visible name and stable ID per roster person.
Private email approvals reference that person. The `roster_accounts` and
`roster_groups` views expose account IDs and current group scopes without emails.
Tasks may use `assignee_person_id` instead of `assignee_id`. The stable person
assignment remains after signup; both verified aliases match **Assigned to me**.
Existing tasks assigned to profile IDs continue to work. Deleted or disabled
approvals do not grant pending access, and consumed approvals do not restore a
removed membership.

Exo-chairs and scoped project/team leads can select a roster person in a task's
Assignee picker before their first sign-in. The person must already have an
approval or membership for that group. Existing tasks can be reassigned through
Edit task. Use **Tasks → New subgroup with people** to choose a parent group and
multiple members, including pending people. The group and all selected members
save in one database operation. Leads can create below groups they manage in the
selected project and select people already in the parent scope. Chairs can select
any approved roster person or existing profile. Groups and memberships remain
shared across projects, matching the existing access model. This update does not
grant leadership roles to additional accounts.

Validation: `node supabase/test-roster-ui.mjs` tests UI ownership and scope logic.
`supabase/test-roster-assignment.mjs` runs against an isolated PGlite PostgreSQL
instance (provide the module using `EXO_PGLITE_MODULE`). It verifies pre-signup
assignment, Google aliases, lead permissions, subgroup atomicity, revocation,
email verification, privacy, and migration reruns. Optionally set
`EXO_PRIVATE_ROSTER_SQL` to validate a private generated import without connecting
to production. The Python roster extraction tests remain in `test_prepare_roster.py`.

## Activity history, permissions and archiving

Keep email-filled seed scripts and roster exports outside the repository and
website directory. Only the generic roster migration belongs in Git. Ignore
rules help prevent accidental commits but do not protect a file already tracked
or prevent a static server from serving a local file.

For an existing database, run `activity-log.sql` as one script in SQL Editor,
then refresh Workbench. The updated root `schema.sql` includes this extension
for fresh installations too. Before installation, existing task reads still work;
the new activity and archive controls remain unavailable.

- EXO chairs see all workspace history in Administration.
- Team leads manage tasks in their team and descendants across projects;
  project leads manage their assigned team scope in their assigned project.
- Members update progress on tasks in their permitted groups. Task creation,
  assignment, editing, archive and restore require a scoped lead or chair.
- Assignees must have access to the selected group. Existing legacy assignments
  are preserved until changed. Membership does not itself grant a leadership role.
- Tasks are archived/restored instead of deleted through the app. Normal browser
  clients cannot permanently delete them or rewrite the history.
- Task updates show the actor, timestamp and changed values. A separate chair-only
  workspace ledger also records membership, roles, profiles, projects, teams,
  milestones, references, comments, checklists, contributors and dependencies.
- The ledger keeps snapshots without foreign keys to the original entities, so
  later owner-level deletion does not erase already-recorded workspace history.
- Existing task activity is backfilled once; old titles and names use the best
  currently available data when no original snapshot exists. Historical events
  that were never recorded cannot be reconstructed. Non-task history starts when
  the migration is installed. SQL/automation changes without an authenticated
  user are attributed to "Administration / system" rather than inventing an actor.

Recent updates follow the selected project/groups, independently of the personal
task filter. History and updates are fetched on refresh and after local task
changes; this is not a real-time notification system. In review is a progress
status, not a separate approval/sign-off mechanism. Private emails and roster
pre-approvals are not copied into the browser-facing history.

## Draft multiple tasks with an external agent

In New task, choose **Tasks from AI**. Select the shared project, group and
assignee, then copy the prompt to your agent and add your work notes. Paste its
JSON response back and choose **Review tasks**, then **Create tasks**. The prompt
uses the existing Deliverable/Evidence and Decision/Question task conventions.
No AI service is called by Workbench and no API key is needed. The copied prompt
includes project/group names and formatting instructions, not the member roster.

Responses accept 1–30 tasks with title, description, priority and due_date only.
All tasks start as To do in the selected scope. Edit the pasted response and
review again to change a draft. Invalid dates, unexpected fields and duplicate
titles within the batch or loaded active group tasks are rejected. This is not
a database-wide uniqueness constraint. Creation uses one atomic batch, preserving
normal Supabase permissions and activity logging. Retries reuse generated IDs
without overwriting existing tasks. No database migration is required.

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

## Manage and archive projects

For an existing database, run `project-management.sql` after `activity-log.sql`,
then refresh Workbench. Fresh installations include both in `schema.sql`.
EXO chairs can open **Administration → Projects and groups → Manage projects**
to archive or restore a project. Archived projects disappear from working project,
new-task and import selectors, but remain listed in project management and history.

Archiving also archives the project's active tasks in the same transaction.
Restoring returns the project to its previous status and restores only tasks
archived with the project; tasks archived individually stay archived. Task
progress, assignments, descriptions and history are preserved. Database checks
reject new or changed tasks in archived projects until the project is restored.
