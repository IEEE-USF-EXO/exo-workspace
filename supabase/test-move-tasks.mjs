import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.EXO_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated,service_role;`);
for(const file of ['../schema.sql','roster-memberships.sql','roster-task-assignment.sql'])
  await db.exec(await fs.readFile(new URL(file,import.meta.url),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.exec(`
insert into auth.users(id,email,email_confirmed_at) values('${id(1)}','owner@example.com',now());
insert into public.leadership_assignments(user_id,role) values('${id(1)}','exo_chair');
insert into public.projects(id,name,created_by) values('${id(2)}','exo-leg','${id(1)}'),('${id(3)}','Other project','${id(1)}');
insert into public.teams(id,name) values('${id(4)}','Preserved group');
insert into public.milestones(id,project_id,name,created_by) values('${id(5)}','${id(3)}','Preserved milestone','${id(1)}');
insert into public.tasks(id,project_id,team_id,milestone_id,title,created_by,assignee_id) values
('${id(6)}','${id(3)}','${id(4)}','${id(5)}','First task','${id(1)}','${id(1)}'),
('${id(7)}','${id(3)}','${id(4)}',null,'Second task','${id(1)}',null);
insert into public.task_dependencies(task_id,depends_on_task_id,project_id,created_by) values('${id(7)}','${id(6)}','${id(3)}','${id(1)}');
insert into public.task_comments(task_id,author_id,body) values('${id(6)}','${id(1)}','Keep this comment');
update public.projects set status='archived' where id='${id(3)}';
`);
const sql=await fs.readFile(new URL('move-tasks-to-exo-leg.sql',import.meta.url),'utf8');
const before=(await db.query('select * from public.tasks order by id')).rows;
await db.exec(sql);
const after=(await db.query('select * from public.tasks order by id')).rows;
assert.equal(after.length,2);
for(let i=0;i<after.length;i++) {
  assert.equal(after[i].project_id,id(2));
  for(const field of ['id','team_id','milestone_id','assignee_id','title','status','due_at','archived_at'])
    assert.deepEqual(after[i][field],before[i][field],field+' must be preserved');
  assert.equal(after[i].project_archive_marker,false);
}
assert.equal((await db.query('select project_id from public.milestones')).rows[0].project_id,id(2));
assert.equal((await db.query('select project_id from public.task_dependencies')).rows[0].project_id,id(2));
assert.equal((await db.query('select body from public.task_comments')).rows[0].body,'Keep this comment');
await db.exec(sql); // rerun is a no-op
await db.query("update public.projects set status='archived' where id=$1",[id(2)]);
await assert.rejects(db.exec(sql));
await db.close();
console.log('Project move passed: tasks, archived state, assignees, groups, milestones, dependencies, comments, rerun, and archived-target rejection.');
