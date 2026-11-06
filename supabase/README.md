# Supabase SQL

For the current dashboard update, run `independent-teams.sql` once in the
Supabase SQL Editor, then refresh Workspace. It removes the task requirement for
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

The task assignment picker has separate **Groups** and **People** sections.
Choosing a group assigns collective responsibility to that group and clears
both individual assignee fields. Group assignments display the group name rather
than "Unassigned group work". Existing task groups can change in Edit task;
`manage_task` requires management rights in both the source and destination
groups, checks the existing revision, and records the move in task history.
The project stays unchanged. Ordinary members can still update progress but
cannot reassign a task or move it to another group.

Exo-chairs and scoped project/team leads can select a roster person in a task's
Assignee picker before their first sign-in. The person must already have an
approval or membership for that group. Existing tasks can be reassigned through
Edit task. Use **Tasks → New subgroup with people** to choose a parent group and
multiple members, including pending people. **New team** also supports selecting
members together. Group creation has no project selector and works even before
the first project exists. The group and all selected members save in one database
operation. Leads can create below groups covered by their active team/project
leadership assignments and select people already in that parent scope. Chairs
can create standalone root teams and select any approved roster person or existing
profile. Tasks later choose a project and owning group independently; creating a
group never writes a project/team link. The older `create_subteam_with_members`
RPC remains compatible but ignores its former project argument. This update does not
grant leadership roles to additional accounts.

For an existing installation, run the updated `roster-task-assignment.sql` to
install project-independent group creation; no roster reimport is needed. Deploy
`app.js` and `index.html` together to remove the Project field and enable bulk
selection for both teams and subteams. Rerun the updated migration to also enable
moving existing tasks between groups from the assignment picker.

Validation: `node supabase/test-roster-ui.mjs` tests UI ownership and scope logic.
`supabase/test-roster-assignment.mjs` runs against an isolated PGlite PostgreSQL
instance (provide the module using `EXO_PGLITE_MODULE`). It verifies pre-signup
assignment, Google aliases, lead permissions, subgroup atomicity, revocation,
email verification, privacy, and migration reruns. Optionally set
`EXO_PRIVATE_ROSTER_SQL` to validate a private generated import without connecting
to production. The Python roster extraction tests remain in `test_prepare_roster.py`.

## Activity history, permissions and archiving

Administration → Member access → **Member list** opens a read-only table of
people and their direct groups or pending roster assignments. Linked Google
accounts appear once per roster person; inherited subgroups are not expanded.
People with no group are listed explicitly. The table refreshes on opening and
has no membership-editing actions. Use **Manage members** to make changes.
This frontend addition does not require a database migration.

Keep email-filled seed scripts and roster exports outside the repository and
website directory. Only the generic roster migration belongs in Git. Ignore
rules help prevent accidental commits but do not protect a file already tracked
or prevent a static server from serving a local file.

For an existing database, run `activity-log.sql` as one script in SQL Editor,
then refresh Workspace. The updated root `schema.sql` includes this extension
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
No AI service is called by Workspace and no API key is needed. The copied prompt
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
then refresh Workspace. Fresh installations include both in `schema.sql`.
EXO chairs can open **Administration → Projects and groups → Manage projects**
to archive or restore a project. Archived projects disappear from working project,
new-task and import selectors, but remain listed in project management and history.

Archiving also archives the project's active tasks in the same transaction.
Restoring returns the project to its previous status and restores only tasks
archived with the project; tasks archived individually stay archived. Task
progress, assignments, descriptions and history are preserved. Database checks
reject new or changed tasks in archived projects until the project is restored.

## Team archiving

Run `team-management.sql` after `activity-log.sql` (and `project-management.sql`
when installed), then refresh Workspace. Fresh installations include this in
`schema.sql`. Administration > Manage teams provides Archive and Restore.
Archiving a parent hides its descendants from active work without rewriting
subteam archive flags. Restoring it leaves independently archived subteams hidden.
Tasks, task archive flags, memberships, roster approvals, and history remain intact.
Tasks in archived teams appear in the task archive view and cannot be edited until
the team is restored. Project archive/restore continues to work independently.

## Live Notes & comms

For an existing database, run `overview-notes.sql` after `group-task-access.sql`
and the archive migrations (`activity-log.sql`, `project-management.sql`, and
`team-management.sql`), then deploy or refresh the frontend. Fresh installs
include the same changes in `schema.sql`. The migration adds Overview notes,
applies group and author permissions, and enables Postgres Changes for
`overview_notes` and `task_comments` when the Supabase publication is present.
If the publication was created after migration, rerun `overview-notes.sql` to
register both tables.

Members can post, edit, and delete their own team and subteam notes. Chairs can
delete any visible note and can also post project announcements. Use the team
picker followed by the subteam picker when a note is for a specific subteam.
Open a task to post or edit your own discussion comments. The
Overview previews recent notes and comments across the selected scope, with
project announcements included in each group view. Archived tasks retain
read-only discussion. Updates use Supabase Realtime with a periodic refresh
while the view is visible.

To review member permissions, use **View as → Member**. The composer shows
the member's destinations and disables posting. Use separate signed-in
browser sessions to verify live delivery and actual posting. If users can
edit their notes but get a permissions error on Delete, rerun the current
`overview-notes.sql` to install the delete grant and policy.

## Shared tasks

Run `shared-tasks.sql` after `overview-notes.sql` and after installing any
optional roster assignment migrations. The fresh-install schema includes
shared tasks. Reapply `shared-tasks.sql` after any later migration that
replaces task permissions or the task editor RPC.

The task form and Tasks from AI show **Additional teams or subteams** once
the migration is installed. Existing tasks keep their original assignment.
Shared tasks have one status, due date, and optional named assignee. Assignee
eligibility follows the primary team. A shared task is counted once across
teams and is visible in each active assigned group, with the same discussion
and activity. If one assigned team is archived, the other active teams can
continue to work on the task.

A lead of any active assigned group can edit shared task details. Changing
the assignments requires management access to every current and selected
group or chair access. Verify this with a lead scoped to only one assigned
team, a member from the other team, and an unrelated member. In the combined
Overview, verify that the task appears once.

## Planned new-task email

On successful manual or AI task creation, automatically queue an
   email for the named assignee, if present, and members of every assigned
   team or subteam, including any groups beneath those assignments. A
   subteam-only assignment does not notify members of its parent team or
   sibling subteams through those memberships. Recipients need an active
   linked workspace account and access to the task. The task form needs no
   email options. Resolve recipients on the server and send one email per
   person even when they qualify through both direct and group assignments.
   Key deliveries by task and recipient so retries can track prior sends.
   Send individual emails with a link to the task and keep note text and
   roster addresses out of the message. A sending failure should leave the
   task saved and the delivery available for retry. Proposed copy: “Hey!
   Check the Workspace. You have a new task.” A sender and mail provider
   still need to be configured. GitHub imports and task edits do not send mail.

Verify that overlapping memberships and retries do not cause duplicate emails.
