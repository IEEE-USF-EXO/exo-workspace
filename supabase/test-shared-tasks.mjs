import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const { PGlite } = await import(process.env.EXO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const read = async file => (await fs.readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
const migration = await read('shared-tasks.sql');
const schema = await read('schema.sql');
assert.ok(schema.endsWith(migration), 'The install schema must include the current migration');
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated,service_role;
`);
await db.exec(schema.slice(0, -migration.length));
const id = async (sql, args = []) => (await db.query(sql, args)).rows[0].id;
const user = email => id('insert into auth.users(id,email) values(gen_random_uuid(),$1) returning id', [email]);
const team = name => id('insert into public.teams(name) values($1) returning id', [name]);
const chair = await user('chair@example.test');
const lead = await user('lead@example.test');
const member = await user('member@example.test');
const outsider = await user('outsider@example.test');
const primary = await team('Mechanical');
const secondary = await team('Controls');
const unrelated = await team('Other');
const retired = await team('Retired');
const project = await id("insert into public.projects(name,created_by) values('Exo',$1) returning id", [chair]);
await db.query("insert into public.leadership_assignments(user_id,role,team_id) values($1,'exo_chair',null),($2,'team_lead',$3)", [chair, lead, secondary]);
await db.query('insert into public.team_members(team_id,user_id) values($1,$2),($3,$4)', [secondary, member, unrelated, outsider]);
const legacy = await id("insert into public.tasks(project_id,team_id,title,created_by) values($1,$2,'Legacy',$3) returning id", [project, retired, chair]);
await db.query('update public.teams set archived_at=now() where id=$1', [retired]);
await db.exec(migration);
await db.exec(migration);
assert.deepEqual((await db.query('select team_ids from public.tasks where id=$1', [legacy])).rows[0].team_ids, [retired]);
assert.deepEqual((await db.query('select team_id from public.task_teams where task_id=$1', [legacy])).rows, [{ team_id: retired }]);

async function as(account) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [account]);
  await db.exec('set role authenticated');
}
const create = (first, teams, title) => id(
  'insert into public.tasks(project_id,team_id,team_ids,title) values($1,$2,$3,$4) returning id',
  [project, first, teams, title]);
await as(chair);
const task = await create(primary, [primary, secondary], 'Shared');
const get = async () => (await db.query('select * from public.tasks where id=$1', [task])).rows[0];
const manage = async values => (await db.query('select * from public.manage_task($1,$2,$3)',
  [task, (await get()).updated_at, values])).rows[0];

await as(member);
assert.equal((await get()).title, 'Shared');
assert.equal((await db.query("update public.tasks set status='in_progress' where id=$1 returning status", [task])).rows[0].status, 'in_progress');
await id("insert into public.task_comments(task_id,body) values($1,'Shared discussion') returning id", [task]);
await assert.rejects(manage({ title: 'Member edit' }), /scoped lead/);
await as(outsider);
assert.equal(await get(), undefined);
assert.equal((await db.query('select * from public.task_comments where task_id=$1', [task])).rows.length, 0);
await as(lead);
assert.equal((await manage({ title: 'Edited by secondary lead' })).title, 'Edited by secondary lead');
await assert.rejects(manage({ team_ids: [secondary] }), /must manage all/);
await assert.rejects(create(secondary, [secondary, primary], 'Out of scope'), /must manage all/);
await as(chair);
await db.query("select public.manage_team($1,'archive')", [primary]);
await as(lead);
assert.equal((await manage({ description: 'Still active' })).description, 'Still active');
await as(chair);
assert.deepEqual((await manage({ team_ids: [secondary] })).team_ids, [secondary]);
await db.exec('reset role');
assert.deepEqual((await db.query('select team_id from public.task_teams where task_id=$1', [task])).rows, [{ team_id: secondary }]);
await db.close();
console.log('Shared task migration and permission checks passed.');
