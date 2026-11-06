import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const { PGlite } = await import(process.env.EXO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const sql = file => fs.readFile(new URL(file, import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated,service_role;
  create publication supabase_realtime;
`);
await db.exec(await sql('schema.sql'));
await db.exec(await sql('overview-notes.sql'));
assert.deepEqual((await db.query(`
  select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename
`)).rows, [{ tablename: 'overview_notes' }, { tablename: 'task_comments' }]);

const id = async (query, params = []) => (await db.query(query, params)).rows[0].id;
const account = email => id('insert into auth.users(id,email) values(gen_random_uuid(),$1) returning id', [email]);
const chair = await account('chair@example.test');
const author = await account('author@example.test');
const teammate = await account('teammate@example.test');
const outsider = await account('outsider@example.test');
const group = await id("insert into public.teams(name) values('Parent') returning id");
const child = await id("insert into public.teams(name,parent_team_id) values('Child',$1) returning id", [group]);
const other = await id("insert into public.teams(name) values('Other') returning id");
const project = await id("insert into public.projects(name,created_by) values('Project',$1) returning id", [chair]);
await db.query("insert into public.leadership_assignments(user_id,role) values($1,'exo_chair')", [chair]);
await db.query('insert into public.team_members(team_id,user_id) values($1,$2),($3,$4),($5,$6)',
  [group, author, child, teammate, other, outsider]);
const task = await id("insert into public.tasks(title,project_id,team_id,created_by) values('Task',$1,$2,$3) returning id", [project, child, chair]);

async function as(user) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
}
const post = (team, body) => id('insert into public.overview_notes(project_id,team_id,body) values($1,$2,$3) returning id', [project, team, body]);
const comment = body => id('insert into public.task_comments(task_id,body) values($1,$2) returning id', [task, body]);
const edit = (table, row, body) => db.query(`update public.${table} set body=$2 where id=$1 returning body`, [row, body]);
const removeNote = async row => (await db.query('delete from public.overview_notes where id=$1 returning id', [row])).rows;
const bodies = async table => (await db.query(`select body from public.${table} order by body`)).rows.map(row => row.body);

await as(chair);
await post(null, 'Announcement');
await as(author);
const note = await post(child, 'Group note');
const reply = await comment('Comment');
await assert.rejects(post(null, 'Member announcement'), /row-level security/);
await assert.rejects(post(other, 'Unrelated group'), /row-level security/);
await as(teammate);
assert.deepEqual(await bodies('overview_notes'), ['Announcement', 'Group note']);
assert.deepEqual(await bodies('task_comments'), ['Comment']);
assert.deepEqual((await edit('overview_notes', note, 'Forbidden edit')).rows, []);
assert.deepEqual((await edit('task_comments', reply, 'Forbidden edit')).rows, []);
await as(outsider);
assert.deepEqual(await bodies('overview_notes'), ['Announcement']);
assert.deepEqual(await bodies('task_comments'), []);
await assert.rejects(post(child, 'Forbidden note'), /row-level security/);
await assert.rejects(comment('Forbidden comment'), /row-level security/);
await as(author);
assert.deepEqual((await edit('overview_notes', note, 'Updated note')).rows, [{ body: 'Updated note' }]);
assert.deepEqual((await edit('task_comments', reply, 'Updated comment')).rows, [{ body: 'Updated comment' }]);
const authorRemoval = await post(child, 'Author removal');
assert.deepEqual(await removeNote(authorRemoval), [{ id: authorRemoval }]);
const chairRemoval = await post(child, 'Chair removal');
await as(teammate);
assert.deepEqual(await removeNote(chairRemoval), []);
await as(chair);
assert.deepEqual(await removeNote(chairRemoval), [{ id: chairRemoval }]);
await db.query("select public.manage_team($1,'archive')", [group]);
await as(author);
assert.deepEqual(await bodies('overview_notes'), ['Announcement']);
assert.deepEqual(await bodies('task_comments'), ['Updated comment']);
await assert.rejects(comment('Archived comment'), /row-level security/);
assert.deepEqual((await edit('task_comments', reply, 'Archived edit')).rows, []);
await db.close();
console.log('Overview notes database checks passed.');
