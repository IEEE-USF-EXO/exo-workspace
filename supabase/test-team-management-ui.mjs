import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const { JSDOM } = await import(process.env.EXO_JSDOM_MODULE || 'jsdom');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://workbench.example.test' });
const document = dom.window.document;
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const context = vm.createContext({ document, location: { hash: '' }, confirm: () => true });
const run = code => vm.runInContext(code, context);
run(source.slice(0, source.indexOf("$('#task-status').innerHTML")));
run(`
  phase='ready'; session={user:{id:'chair'}}; rosterReady=true;
  state.leadership=[{user_id:'chair',role:'exo_chair'}];
  state.teams=[{id:'root',name:'Parent',parent_team_id:null},
    {id:'child',name:'Child',parent_team_id:'root'},
    {id:'separate',name:'Separate',parent_team_id:'root',archived_at:'2026-10-01'}];
  state.projects=[{id:'p',name:'Project',status:'active'}]; state.project='p';
  state.tasks=[{id:'active',project_id:'p',team_id:'child',status:'todo'},
    {id:'old',project_id:'p',team_id:'child',status:'todo',archived_at:'2026-10-01'}];
`);
const field = selector => document.querySelector(selector);
assert.ok(field('#manage-teams'));
assert.equal(field('#new-subteam'), null);
run('openTeams()');
assert.equal(field('#teams-dialog').open, true);
assert.equal(field('[data-team-id="root"]').textContent, 'Archive');
assert.equal(field('[data-team-id="separate"]').textContent, 'Restore');
assert.equal(run('scopedTasks().length'), 1);
// Exercise a save with the actual handler, preserving task archive flags.
run(`
  render=()=>{}; savePreferences=()=>{}; loadAdminHistory=()=>{}; toast=()=>{};
  client={rpc:async(name,args)=>({data:{id:args.p_id,archived_at:args.p_action==='archive'?'2026-10-30':null},error:null})};
  readAll=async()=>state.teams;
`);
await run("changeTeamArchive({target:$('#team-list [data-team-id=\"root\"]')})");
assert.equal(run("teamIsArchived('child')"), true);
assert.equal(run('scopedTasks().length'), 0);
assert.equal(run('canCreate()'), false);
assert.equal(run('canProgress(state.tasks[0])'), false);
assert.equal(run("canManageGroup('child')"), false);
run('renderTeamManagement()');
assert.equal(field('[data-team-id="root"]').textContent, 'Restore');
assert.equal(field('[data-team-id="child"]').disabled, true);
assert.equal(field('[data-team-id="separate"]').disabled, true);
run("activeTab='tasks'; $('#archive-filter').value='archived'");
assert.equal(run('scopedTasks().length'), 2);
assert.equal(run("rootsForProject('p').length"), 1);
await run("changeTeamArchive({target:$('#team-list [data-team-id=\"root\"]')})");
assert.equal(run("teamIsArchived('child')"), false);
assert.equal(run("teamIsArchived('separate')"), true);
run("$('#archive-filter').value='active'");
assert.equal(run('scopedTasks().length'), 1);
assert.equal(run('state.tasks[1].archived_at'), '2026-10-01');
run("openSetup('team')");
assert.ok(!field('#setup-parent').innerHTML.includes('value="separate"'));
run("preview.mode='member'; $('#teams-dialog').close(); openTeams()");
assert.equal(field('#teams-dialog').open, false);
run("preview.mode=''; state.leadership=[]; openTeams()");
assert.equal(field('#teams-dialog').open, false);
run("state.teams=[]; renderTeamManagement()");
assert.ok(field('#team-list').textContent.includes('No teams yet'));
console.log('Team archive UI checks passed: dialog actions, inherited archive, task scopes, restore, parent choices, preview and access guards.');
