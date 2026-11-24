import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://exo.example.test' });
const { window } = dom;
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const requested = [];
const publicTask = { id:'00000000-0000-4000-8000-000000000001', project_id:'p', team_id:'a', team_ids:['a'], title:'Actuator', description:'Public instructions', status:'todo', priority:'medium' };
const otherTask = { ...publicTask, id:'other', team_id:'b', team_ids:['b'], title:'Controls' };
const tables = {
  public_tasks: [publicTask, otherTask, { ...otherTask, id:'archived', archived_at:'2026-10-01' }],
  public_task_teams: [{id:'a',name:'Mechanical'},{id:'b',name:'Electrical'}],
  public_task_projects: [{id:'p',name:'EXO',status:'active'},{id:'old',name:'Previous',status:'archived'}],
  profiles: [{id:'member',display_name:'Member'}],
  team_members: [{user_id:'member',team_id:'a'}], leadership_assignments: [],
  tasks: [{ ...publicTask, assignee_id:'member' }], roster_people: [], roster_accounts: [], roster_group_members: []
};
const api = {
  from(table) {
    requested.push(table);
    return { select() { return this; }, order() { return this; }, async range() {
      return api.errorTable === table ? {data:null,error:{code:'42501',message:'Denied'}} : {data:tables[table] || [],error:null};
    } };
  },
  channel() { return { on() { return this; }, subscribe() {} }; },
  removeChannel() {}
};
const context = vm.createContext({ document:window.document, window, location:window.location, history:window.history,
  localStorage:window.localStorage, sessionStorage:window.sessionStorage, URL, URLSearchParams,
  setTimeout, clearTimeout, crypto:globalThis.crypto, api, EXO_CONFIG:{}, EXO_FILES:{ foldersForProfile:() => [] } });
const run = code => vm.runInContext(code, context);
run(source.slice(0, source.indexOf("$('#task-status').innerHTML")));
// Initialize the same native select options as bootstrap, without OAuth/network setup.
run(`
  client=api; authReady=true;
  $('#task-lens').value='all';
  $('#status-filter').innerHTML=options([['all','All statuses'],...Object.entries(STATUS)]);
  $('#priority-filter').innerHTML=options([['all','All priorities'],...Object.entries(PRIORITY)]);
  refreshRecentActivity=async()=>{};
`);
const field = selector => window.document.querySelector(selector);
await run('loadWorkspace()');
assert.equal(run('phase'), 'ready');
assert.deepEqual([...new Set(requested)].sort(), ['public_task_projects','public_task_teams','public_tasks']);
assert.equal(field('#signin-dialog').open, false);
assert.equal(run('scopedTasks().length'), 2);
assert.equal(field('#task-search').disabled, false);
assert.equal(field('#new-task').hidden, true);
assert.equal(field('#recent-updates-panel').hidden, true);
assert.equal(field('#nav-administration').hidden, true);
assert.equal(field('#group-tasks-button').disabled, false);
assert.equal(field('[data-task-scope="assigned"]').disabled, true);
assert.equal(field('#archive-filter').hidden, false);
run("$('#task-search').value='Controls'; renderTasks(scopedTasks())");
assert.match(field('#task-cards').textContent, /Controls/);
assert.doesNotMatch(field('#task-cards').textContent, /Actuator/);
run("$('#task-search').value=''; state.team='b'; render()");
assert.equal(run('scopedTasks().length'), 1);
run("activeTab='tasks'; state.team='all'; $('#archive-filter').value='archived'; render()");
assert.equal(run('scopedTasks().length'), 1);
run("$('#archive-filter').value='active'; render(); openTask(state.tasks[0].id)");
assert.equal(field('#task-dialog').open, true);
assert.equal(field('#task-detail-title').textContent, 'Actuator');
assert.equal(field('#task-history-section').hidden, true);
assert.equal(field('#task-references').hidden, true);
assert.equal(field('#task-discussion-panel').hidden, true);
assert.equal(field('#edit-task').hidden, true);
assert.equal(field('#task-progress-control').hidden, true);
assert.equal(run('canProgress(state.tasks[0])'), false);
assert.equal(run('canCreate()'), false);
run("$('#task-dialog').close(); history.replaceState(null,'','?task=00000000-0000-4000-8000-000000000001'); openLinkedTask()");
assert.equal(field('#task-dialog').open, true);
assert.equal(run('activeTab'), 'tasks');
assert.equal(field('#project-select').querySelector('option[value="old"]').textContent, 'Previous');

run("$('#task-dialog').close(); session={user:{id:'outsider'}}; state.memberships=[]");
tables.team_members = [];
tables.tasks = [];
await run('loadWorkspace()');
assert.equal(run('scopedTasks().length'), 2, 'Signing in without membership preserves public browsing');
assert.equal(run('canProgress(state.tasks[0])'), false);

tables.team_members = [{user_id:'member',team_id:'a'}];
tables.tasks = [{ ...publicTask, assignee_id:'member' }];
run("session={user:{id:'member'}}");
await run('loadWorkspace()');
assert.equal(run('scopedTasks().length'), 2, 'Members can still browse other teams');
assert.equal(run("canProgress(state.tasks.find(t=>t.id==='other'))"), false);
assert.equal(run('canProgress(state.tasks[0])'), true);
assert.equal(run("canAccessTaskInternals(state.tasks.find(t=>t.id==='other'))"), false);
assert.equal(run('canAccessTaskInternals(state.tasks[0])'), true);
run("preview.mode='group'; preview.subject='a'");
assert.equal(run('scopedTasks().length'), 1, 'Group previews retain their original scope');
run("preview.mode=''; preview.subject=''");
api.errorTable = 'profiles';
await run('loadWorkspace()');
assert.equal(run('phase'), 'ready');
assert.equal(run('scopedTasks().length'), 2, 'Internal loading errors preserve public browsing');
assert.equal(run('state.profiles.length'), 0);
assert.equal(run('canProgress(state.tasks[0])'), false);
api.errorTable = 'public_tasks';
await run('loadWorkspace()');
assert.equal(run('phase'), 'error');
assert.equal(run('state.tasks.length'), 0, 'Failed reloads cannot retain old member data');
assert.equal(field('#signin-dialog').open, false);
dom.window.close();
console.log('Public board UI checks passed: guest loading, optional sign-in, filters, details, direct links, nonmembers, member actions, and previews.');
