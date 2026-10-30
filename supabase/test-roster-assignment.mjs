// Isolated PostgreSQL tests. Set EXO_PGLITE_MODULE to the installed module file URL.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { PGlite } = await import(process.env.EXO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const root = fileURLToPath(new URL('../', import.meta.url));
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
  create table auth.identities(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), provider text, identity_data jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated,service_role;
  grant execute on function auth.uid() to authenticated,service_role;
`);
for (const path of ['schema.sql', 'supabase/roster-memberships.sql', 'supabase/roster-task-assignment.sql']) {
  try { await db.exec(await fs.readFile(root + path, 'utf8')); }
  catch (error) { console.error('Failed installing', path, error.message); throw error; }
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [chair, lead, member, alternate, outsider, late] = [1,2,3,4,5,6].map(id);
const [project, otherProject, parent, otherParent, person] = [10,11,12,13,14].map(id);
// Teams and member selection must work before the workspace has any projects.
await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now())",[id(900)]);
await db.query("insert into public.leadership_assignments(user_id,role) values($1,'exo_chair')",[id(900)]);
await as(id(900));
assert.equal((await db.query('select * from public.projects')).rows.length,0);
const standalone = (await db.query("select id from public.create_group_with_members('Independent team','',null,array[$1::uuid],'{}')",[id(900)])).rows[0].id;
assert.equal((await db.query('select parent_team_id from public.teams where id=$1',[standalone])).rows[0].parent_team_id,null);
assert.equal((await db.query('select * from public.team_members where team_id=$1',[standalone])).rows.length,1);
await db.exec('reset role');
await db.query("select set_config('request.jwt.claim.sub','',false)");
await db.exec(`
  insert into auth.users(id,email,email_confirmed_at) values
    ('${chair}','chair@example.com',now()),('${lead}','lead@example.com',now()),('${outsider}','outsider@example.com',now());
  insert into public.leadership_assignments(user_id,role) values('${chair}','exo_chair');
  insert into public.projects(id,name,created_by) values('${project}','Project','${chair}'),('${otherProject}','Other project','${chair}');
  insert into public.teams(id,name) values('${parent}','Parent'),('${otherParent}','Other');
  insert into public.leadership_assignments(user_id,role,team_id,project_id) values('${lead}','project_lead','${parent}','${project}');
  insert into public.roster_people(id,display_name) values('${person}','Future member');
  insert into exo_private.roster_memberships(email,team_id,person_id) values
    ('future@example.com','${parent}','${person}'),('alias@example.com','${parent}','${person}');
`);
async function as(user) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
}
async function rejected(sql, params = []) {
  await assert.rejects(db.query(sql, params));
}
await as(lead);
await db.query(`insert into public.tasks(id,title,project_id,team_id,assignee_person_id)
  values($1,'Before signup',$2,$3,$4)`, [id(20), project, parent, person]);
assert.equal((await db.query('select assignee_person_id from public.tasks where id=$1',[id(20)])).rows[0].assignee_person_id, person);
const group = (await db.query(`select id from public.create_subteam_with_members('New subgroup','', $1,$2,'{}',array[$3::uuid])`,[parent,project,person])).rows[0].id;
await db.query(`insert into public.tasks(id,title,project_id,team_id,assignee_person_id)
  values($1,'Subgroup before signup',$2,$3,$4)`,[id(21),project,group,person]);
await rejected(`select * from public.create_subteam_with_members('Not allowed','',$1,$2,'{}',array[$3::uuid])`,[otherParent,project,person]);
// The old RPC remains compatible, but its former project selector has no effect.
assert.equal((await db.query(`select * from public.create_subteam_with_members('Project-independent subgroup','',$1,$2,'{}','{}')`,[parent,otherProject])).rows.length,1);
await rejected("select * from public.create_group_with_members('Lead cannot create root','',null,'{}','{}')");
await rejected(`select * from public.create_subteam_with_members('Outside person','',$1,$2,array[$3::uuid],'{}')`,[parent,project,outsider]);
await rejected(`insert into public.tasks(title,project_id,team_id,assignee_person_id) values('Wrong group',$1,$2,$3)`,[project,otherParent,person]);
const created = (await db.query('select updated_at from public.tasks where id=$1',[id(20)])).rows[0];
await db.query('select * from public.manage_task($1,$2,$3)',[id(20),created.updated_at,{title:'Assigned before signup',assignee_id:null,assignee_person_id:person}]);
// Reassign an existing task to a group while checking BOTH source and destination.
let revision = (await db.query('select updated_at from public.tasks where id=$1',[id(20)])).rows[0].updated_at;
await rejected('select * from public.manage_task($1,$2,$3)',[id(20),revision,{team_id:otherParent,assignee_id:null,assignee_person_id:null}]);
await rejected('select * from public.manage_task($1,$2,$3)',[id(20),revision,{project_id:otherProject}]);
let moved = (await db.query('select * from public.manage_task($1,$2,$3)',[id(20),revision,{team_id:group,assignee_id:null,assignee_person_id:null}])).rows[0];
assert.equal(moved.team_id,group);
assert.equal(moved.assignee_id,null);
assert.equal(moved.assignee_person_id,null);
assert.equal(moved.project_id,project);
assert.ok((await db.query("select * from public.task_activity where task_id=$1 and changes?'team_id'",[id(20)])).rows.length>0);
await as(outsider);
await rejected('select * from public.manage_task($1,$2,$3)',[id(20),moved.updated_at,{team_id:otherParent}]);
await as(lead);
await db.query('select * from public.manage_task($1,$2,$3)',[id(20),moved.updated_at,{team_id:parent,assignee_id:null,assignee_person_id:person}]);

// Signup triggers must grant both existing and newly selected subgroup approvals.
await db.exec('reset role');
await db.query(`insert into public.roster_people(id,display_name) values($1,'Other roster person')`,[id(15)]);
await db.query(`insert into exo_private.roster_memberships(email,team_id,person_id) values('other@example.com',$1,$2)`,[otherParent,id(15)]);
await as(lead);
await rejected(`insert into public.tasks(title,project_id,team_id,assignee_person_id) values('Ineligible person',$1,$2,$3)`,[project,parent,id(15)]);
await db.exec('reset role');
await db.query("select set_config('request.jwt.claim.sub','',false)");
for (const [user,email] of [[member,'future@example.com'],[alternate,'alias@example.com']]) {
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[user,email]);
  await db.query(`insert into auth.identities(user_id,provider,identity_data) values($1,'google',$2)`,[user,{email,email_verified:true}]);
  await as(user);
  assert.equal((await db.query('select id from public.tasks order by id')).rows.length,2);
  assert.equal((await db.query('select * from public.roster_accounts where user_id=$1',[user])).rows[0].person_id,person);
  await rejected(`select * from public.create_subteam_with_members('Member cannot create','',$1,$2,'{}','{}')`,[parent,project]);
  await rejected('update public.tasks set assignee_person_id=null where id=$1',[id(20)]);
  await db.exec('reset role');
}

// A failed selection must leave no empty group behind.
await as(chair);
await db.query(`insert into public.tasks(title,project_id,team_id,assignee_id)
  values('Assign later from a project',$1,$2,$3)`,[project,standalone,id(900)]);
assert.equal((await db.query('select * from public.project_teams where team_id=$1',[standalone])).rows.length,0);
await rejected(`select * from public.create_subteam_with_members('Atomic failure','',$1,$2,array[$3::uuid],'{}')`,[parent,project,id(999)]);
assert.equal((await db.query("select id from public.teams where name='Atomic failure'")).rows.length,0);
// Chair can select an existing account from outside the parent group.
const bulk = (await db.query(`select id from public.create_subteam_with_members('Bulk group','',$1,$2,array[$3::uuid],array[$4::uuid])`,[parent,project,outsider,person])).rows[0].id;
assert.equal((await db.query('select user_id from public.team_members where team_id=$1',[bulk])).rows.length,3);
// Removing memberships must not be undone by a subsequent Google identity update.
await db.exec('reset role');
await db.query('delete from public.team_members where user_id=$1',[member]);
await db.query(`update auth.identities set identity_data=identity_data||'{}'::jsonb where user_id=$1`,[member]);
assert.equal((await db.query('select * from public.team_members where user_id=$1',[member])).rows.length,0);
// Unverified or mismatched identity metadata cannot claim an email approval.
await db.query(`insert into exo_private.roster_memberships(email,team_id,person_id) values('late@example.com',$1,$2)`,[parent,person]);
await db.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'late@example.com',now())`,[late]);
await db.query(`insert into auth.identities(user_id,provider,identity_data) values($1,'google','{"email":"late@example.com","email_verified":false}')`,[late]);
assert.equal((await db.query('select * from public.team_members where user_id=$1',[late])).rows.length,0);
await db.query(`update auth.identities set identity_data='{"email":"different@example.com","email_verified":true}' where user_id=$1`,[late]);
assert.equal((await db.query('select * from public.team_members where user_id=$1',[late])).rows.length,0);
await db.query(`update auth.identities set identity_data='{"email":"late@example.com","email_verified":true}' where user_id=$1`,[late]);
assert.equal((await db.query('select * from public.team_members where user_id=$1',[late])).rows.length,1);
await as(outsider);
await rejected('select email from exo_private.roster_memberships');
await db.exec('reset role; set role anon');
await rejected('select * from public.roster_people');
await rejected('select * from public.roster_accounts');
await db.exec('reset role');
// Extension reruns preserve task assignments and group memberships.
await db.exec(await fs.readFile(root+'supabase/roster-task-assignment.sql','utf8'));
assert.equal((await db.query('select assignee_person_id from public.tasks where id=$1',[id(20)])).rows[0].assignee_person_id,person);
if (process.env.EXO_PRIVATE_ROSTER_SQL) {
  const installation = await fs.readFile(process.env.EXO_PRIVATE_ROSTER_SQL,'utf8');
  await db.exec(installation);
  await db.exec(installation);
  assert.equal((await db.query("select * from exo_private.roster_memberships where source='Workbook roster import' and person_id is null")).rows.length,0);
  console.log('Private workbook installation and repeated import passed.');
}
await db.close();
console.log('PostgreSQL checks passed: pending assignment, both aliases, scoped leads, bulk groups, atomic rollback, membership revocation, privacy, and migration rerun.');
