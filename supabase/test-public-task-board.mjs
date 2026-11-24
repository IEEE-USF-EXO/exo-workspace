import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.EXO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await fs.readFile(new URL('schema.sql', import.meta.url), 'utf8');
const migration = await fs.readFile(new URL('public-task-board.sql', import.meta.url), 'utf8');
assert.ok(schema.replace(/\r\n/g, '\n').trimEnd().endsWith(migration.replace(/\r\n/g, '\n').trimEnd()));
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated,service_role;
`);
await db.exec(schema);
await db.exec(migration); // Safe to rerun for existing installations.
const id = async (sql, args = []) => (await db.query(sql, args)).rows[0].id;
const chair = await id("insert into auth.users(id,email) values(gen_random_uuid(),'chair@example.test') returning id");
const outsider = await id("insert into auth.users(id,email) values(gen_random_uuid(),'outsider@example.test') returning id");
const team = await id("insert into public.teams(name) values('Engineering') returning id");
const project = await id("insert into public.projects(name,created_by) values('EXO',$1) returning id", [chair]);
const task = await id("insert into public.tasks(project_id,team_id,title,description,created_by) values($1,$2,'Build actuator','Public instructions',$3) returning id", [project, team, chair]);
await db.query("insert into public.task_comments(task_id,author_id,body) values($1,$2,'Internal discussion')", [task, chair]);
await db.query("insert into public.leadership_assignments(user_id,role) values($1,'exo_chair')", [chair]);

for (const role of ['anon', 'authenticated']) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [role === 'anon' ? '' : outsider]);
  await db.exec(`set role ${role}`);
  const rows = (await db.query('select * from public.public_tasks')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'Public instructions');
  for (const field of ['assignee_id','assignee_person_id','created_by','archived_by']) assert.ok(!(field in rows[0]), field);
  assert.equal((await db.query('select name from public.public_task_teams')).rows[0].name, 'Engineering');
  assert.equal((await db.query('select name from public.public_task_projects')).rows[0].name, 'EXO');
  for (const view of ['public_tasks','public_task_teams','public_task_projects']) {
    await assert.rejects(db.query(`delete from public.${view}`), /permission denied/);
    await assert.rejects(db.query(`update public.${view} set id=id`), /permission denied/);
    await assert.rejects(db.query(`insert into public.${view}(id) values(gen_random_uuid())`), /permission denied/);
  }
  if (role === 'anon') {
    for (const table of ['tasks','profiles','team_members','task_comments','task_links','task_activity']) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
    }
  } else {
    assert.equal((await db.query('select * from public.tasks')).rows.length, 0);
    assert.equal((await db.query('select * from public.task_comments')).rows.length, 0);
    assert.equal((await db.query("update public.tasks set status='done' returning id")).rows.length, 0);
  }
}
await db.exec('reset role');
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [chair]);
await db.exec('set role authenticated');
assert.equal((await db.query("update public.tasks set status='done' where id=$1 returning id", [task])).rows.length, 1);
assert.equal((await db.query('select * from public.task_comments')).rows.length, 1);
await db.query('select public.manage_task($1,$2,$3)', [task, (await db.query('select updated_at from public.tasks where id=$1', [task])).rows[0].updated_at, { archived: true }]);
await db.exec('reset role; set role anon');
assert.ok((await db.query('select archived_at from public.public_tasks')).rows[0].archived_at);
await db.close();
console.log('Public board database checks passed: public reads, private fields, denied writes, internal access, archives, and migration reruns.');
