import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { PGlite } = await import(process.env.EXO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const sql = file => fs.readFile(new URL(file, import.meta.url), 'utf8');
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
    email_confirmed_at timestamptz, banned_until timestamptz
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated,service_role;
`);
await db.exec(await sql('schema.sql'));
await db.exec(await sql('task-notifications.sql'));
await db.exec(await sql('task-notifications.sql'));
const id = async (query, params = []) => (await db.query(query, params)).rows[0].id;
const user = email => id('insert into auth.users(id,email,email_confirmed_at) values(gen_random_uuid(),$1,now()) returning id', [email]);
const team = (name, parent = null) => id('insert into public.teams(name,parent_team_id) values($1,$2) returning id', [name, parent]);
const chair = await user('chair@example.test');
const recipient = await user('recipient@example.test');
const parentMember = await user('parent@example.test');
const revoked = await user('revoked@example.test');
const parent = await team('Mechanical');
const child = await team('Robotics', parent);
const grandchild = await team('Grippers', child);
const other = await team('Controls');
const project = await id("insert into public.projects(name,created_by) values('EXO',$1) returning id", [chair]);
await db.query("insert into public.leadership_assignments(user_id,role) values($1,'exo_chair')", [chair]);
await db.query('insert into public.team_members(team_id,user_id) values($1,$2),($3,$2),($4,$5),($1,$6)',
  [grandchild, recipient, other, parent, parentMember, revoked]);
await db.query('insert into public.team_members(team_id,user_id) values($1,$2),($1,$3)', [child, recipient, revoked]);
async function as(userId, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
  await db.exec(`set role ${role}`);
}
const tasks = [{
  id: '65df43f4-e827-4911-90b7-e748fcd325e5', project_id: project,
  team_id: child, team_ids: [child, other], title: 'Test gripper', description: '',
  status: 'todo', priority: 'medium', assignee_id: recipient,
  due_at: '2026-11-07T04:59:59Z',
}];
const create = rows => db.query('select id from public.create_notified_tasks($1::jsonb)', [JSON.stringify(rows)]);
await as(recipient);
await assert.rejects(create(tasks), /manage|row-level security/);
await assert.rejects(db.query('select * from public.claim_task_email()'), /permission denied/);
await as(chair);
const usage = async () => (await db.query('select public.task_email_usage() as usage')).rows[0].usage;
assert.deepEqual(await usage(), { enabled: false, sent_today: 0, pending: 0, daily_limit: 100 });
await db.exec('reset role');
await db.exec('update exo_private.task_email_settings set enabled=true');
await as(chair);
await create(tasks);
await create(tasks);
await db.query("insert into public.tasks(title,project_id,team_id) values('Imported',$1,$2)", [project, child]);
assert.equal((await usage()).pending, 2);
await db.exec('reset role');
await db.query('delete from public.team_members where user_id=$1', [revoked]);
await as('', 'service_role');
const [delivery] = (await db.query('select * from public.claim_task_email()')).rows;
assert.equal(delivery.email, 'recipient@example.test');
assert.equal(delivery.task_title, 'Test gripper');
assert.equal(new Date(delivery.task_due_at).toISOString(), '2026-11-07T04:59:59.000Z');
assert.equal((await db.query('select * from public.claim_task_email()')).rows.length, 0);
await db.query("select public.finish_task_email($1,$2,'sent','resend-test-id')", [delivery.id, delivery.lease]);
await as(chair);
assert.deepEqual(await usage(), { enabled: true, sent_today: 1, pending: 0, daily_limit: 100 });
await create([{ ...tasks[0], id: 'd99fe434-1c8b-4a16-8ebb-58dc40723420' }]);
await db.exec('reset role');
await db.exec(`
  insert into exo_private.task_emails(task_id,recipient_id,email,state)
    select gen_random_uuid(),gen_random_uuid(),n||'@test.invalid','sent' from generate_series(1,99) n;
  insert into exo_private.task_email_slots(day,delivery_id)
    select (now() at time zone 'UTC')::date,id from exo_private.task_emails where email like '%@test.invalid';
`);
await as('', 'service_role');
assert.equal((await db.query('select * from public.claim_task_email()')).rows.length, 0);
await as(chair);
assert.equal((await usage()).pending, 1);
await db.close();
console.log('Task notification permission, deduplication, delivery and quota checks passed.');
