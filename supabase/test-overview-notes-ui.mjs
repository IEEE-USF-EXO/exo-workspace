import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const { JSDOM } = await import(process.env.EXO_JSDOM_MODULE || 'jsdom');
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');
const script = source.slice(0, source.indexOf("$('#task-status').innerHTML"));
const tables = { overview_notes: [], task_comments: [] };
const task = { id: 'task', project_id: 'project', team_id: 'x', title: 'Shared work', status: 'todo', priority: 'medium', archived_at: null };
const listeners = new Set();
let nextId = 0;

function sessionClient(user) {
  return {
    channel() {
      const handlers = [];
      return {
        handlers,
        on(_type, filter, callback) { handlers.push({ ...filter, callback }); },
        subscribe() { listeners.add(this); }
      };
    },
    removeChannel(channel) { listeners.delete(channel); },
    from(table) {
      const filters = [];
      const field = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
      let values, edit, limit = 100;
      return {
        select() { return this; },
        eq(key, value) { filters.push(row => field(row, key) === value); return this; },
        is(key, value) { filters.push(row => field(row, key) === value); return this; },
        in(key, values) { filters.push(row => values.includes(field(row, key))); return this; },
        or(filter) {
          const groups = filter.match(/in\.\((.*)\)/)[1].split(',');
          filters.push(row => !row.team_id || groups.includes(row.team_id));
          return this;
        },
        order() { return this; },
        limit(value) { limit = value; return this; },
        insert(value) { values = value; return this; },
        update(value) { edit = value; return this; },
        async maybeSingle() {
          const row = edit ? tables[table].find(row => filters.every(filter => filter(row)))
            : { ...values, id: String(++nextId), author_id: user, created_at: new Date().toISOString() };
          if (!row) return { data: null };
          Object.assign(row, edit, { updated_at: new Date().toISOString() });
          if (!edit) tables[table].unshift(row);
          for (const channel of listeners) {
            for (const handler of channel.handlers) {
              if (handler.table === table && handler.event === (edit ? 'UPDATE' : 'INSERT')) handler.callback();
            }
          }
          return { data: row };
        },
        then(resolve) {
          const rows = tables[table].map(row => table === 'task_comments' ? { ...row, tasks: task } : row)
            .filter(row => filters.every(filter => filter(row))).slice(0, limit);
          return Promise.resolve({ data: rows.map(row => ({ ...row })) }).then(resolve);
        }
      };
    }
  };
}

function openSession(user) {
  const { window } = new JSDOM(html, { url: 'https://workbench.example.test' });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const context = vm.createContext({ document: window.document, location: window.location, setTimeout, clearTimeout, api: sessionClient(user), user, task });
  const run = code => vm.runInContext(code, context);
  run(script);
  run(`
    client=api; session={user:{id:user}}; phase='ready';
    state.teams=[{id:'x',name:'Team X'},{id:'y',name:'Team Y'},
      {id:'x1',name:'Sensors',parent_team_id:'x'},{id:'y1',name:'Structures',parent_team_id:'y'}];
    state.memberships=[{user_id:user,team_id:'x'},{user_id:user,team_id:'y'}];
    state.projects=[{id:'project',status:'active'}];
    state.project='project'; state.team='x'; state.tasks=[task];
    loadTaskReferences=()=>{}; loadTaskHistory=()=>{};
    syncNotes();
  `);
  return { run, window, field: selector => window.document.querySelector(selector) };
}

const author = openSession('author');
const reader = openSession('reader');
await delay(0);
assert.equal(author.field('#overview-notes-destination').value, 'x');
assert.equal(author.field('#overview-notes-destination').disabled, true);
author.field('#overview-notes-body').value = '<b>New note</b>';
await author.run('saveNote(notesFeed)');
await delay(200);
assert.match(reader.field('#overview-notes-list summary').textContent, /<b>New note<\/b>/);
assert.equal(reader.field('#overview-notes-list b'), null);
assert.equal(reader.field('[data-note-edit]'), null);
author.run("handleNoteClick(notesFeed, { target: $('[data-note-edit]') })");
author.field('#overview-notes-body').value = 'Edited note';
await author.run('saveNote(notesFeed)');
await delay(200);
assert.match(reader.field('#overview-notes-list').textContent, /Edited note/);
author.run("openTask('task', true)");
await delay(0);
assert.equal(author.window.document.activeElement.id, 'task-discussion-title');
author.field('#task-discussion-body').value = 'New comment';
await author.run('saveNote(discussion)');
await delay(200);
const preview = reader.field('[data-discussion-task]');
assert.equal(preview.textContent, 'New comment');
reader.run(`openTask($('[data-discussion-task]').dataset.discussionTask, true)`);
await delay(0);
assert.match(reader.field('#task-discussion-list').textContent, /New comment/);
reader.run("state.team='y'; syncNotes()");
assert.equal(reader.field('#overview-notes-list').textContent, '');
await delay(0);
assert.match(reader.field('#overview-notes-status').textContent, /No notes or comments/);
reader.run("state.team='all'; syncNotes()");
await delay(0);
assert.equal(reader.field('#overview-notes-destination').value, '');
assert.equal(reader.field('#overview-notes-destination').disabled, false);
const teamPicker = reader.field('#overview-notes-destination');
const subteamPicker = reader.field('#overview-notes-subteam');
assert.deepEqual(Array.from(teamPicker.options, option => option.value), ['', 'x', 'y']);
teamPicker.value = 'x';
reader.run('fillNoteSubteams()');
assert.deepEqual(Array.from(subteamPicker.options, option => option.value), ['', 'x1']);
subteamPicker.value = 'x1';
reader.field('#overview-notes-body').value = 'Sensors update';
await reader.run('saveNote(notesFeed)');
assert.equal(tables.overview_notes[0].team_id, 'x1');
teamPicker.value = 'y';
reader.run('fillNoteSubteams()');
assert.deepEqual(Array.from(subteamPicker.options, option => option.value), ['', 'y1']);
assert.equal(subteamPicker.value, '');
await delay(200);
reader.run(`
  state.leadership=[{user_id:user,role:'exo_chair'}];
  state.memberships.push({user_id:'preview-member',team_id:'x'});
  preview.mode='member'; preview.subject='preview-member'; syncNotes();
`);
await delay(0);
assert.equal(reader.field('#overview-notes-composer').hidden, false);
assert.equal(reader.field('#overview-notes-save').disabled, true);
assert.equal(reader.field('#overview-notes-preview-message').hidden, false);
assert.deepEqual(Array.from(teamPicker.options, option => option.value), ['', 'x']);
reader.run(`
  preview.mode=''; state.leadership=[{user_id:user,role:'team_lead',team_id:'y'}];
  state.tasks=[{...task, team_ids:['x','y']}];
  $('#task-lens').value='team';
  state.team='all';
`);
assert.equal(reader.run('scopedTasks().length'), 1);
reader.run("state.team='y'");
assert.equal(reader.run('scopedTasks().length'), 1);
assert.equal(reader.run('canEdit(state.tasks[0])'), true);
assert.equal(reader.run('canChangeTaskTeams(state.tasks[0])'), false);
reader.run(`sharedTasksReady=true; $('#task-id').value='task'; renderExtraTaskTeams('project','x',['x','y'])`);
const secondaryAssignment = reader.field('#task-extra-teams input[value="y"]');
assert.equal(secondaryAssignment.checked, true);
assert.equal(secondaryAssignment.disabled, true);
for (const view of [author, reader]) view.window.close();
console.log('Overview notes UI checks passed across two simulated sessions.');
