import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import '../file-library.js';

const { foldersForProfile } = globalThis.EXO_FILES;
const rootFolder = { id: 'root', name: 'EXO' };
const teamFolders = ['Controls', 'Electrical', 'Mechanical'].map(name => ({ name, team: name, id: name.toLowerCase() }));
const base = {
  ready: true, userId: 'member', rootFolder, teamFolders,
  teams: [
    { id: 'c', name: 'Controls' }, { id: 'e', name: 'Electrical' }, { id: 'm', name: 'Mechanical' },
    { id: 'sub', name: 'Kit-Kat', parent_team_id: 'm' },
  ],
  memberships: [], leadership: [],
};
const ids = overrides => foldersForProfile({ ...base, ...overrides }).map(folder => folder.id);

test('members see only matching folders; multiple memberships are deduplicated', () => {
  assert.deepEqual(ids({ memberships: [{ user_id: 'member', team_id: 'c' }, { user_id: 'other', team_id: 'e' }] }), ['controls']);
  assert.deepEqual(ids({ memberships: ['m', 'sub', 'e'].map(team_id => ({ user_id: 'member', team_id })) }), ['electrical', 'mechanical']);
});

test('active scoped leaders and subteam members see the parent folder', () => {
  assert.deepEqual(ids({ memberships: [{ user_id: 'member', team_id: 'sub' }] }), ['mechanical']);
  assert.deepEqual(ids({ leadership: [{ user_id: 'member', role: 'team_lead', team_id: 'e' }, { user_id: 'member', role: 'project_lead', team_id: 'c', project_id: 'project' }] }), ['controls', 'electrical']);
  assert.deepEqual(ids({ leadership: [{ user_id: 'member', role: 'team_lead', team_id: 'e', revoked_at: '2026-11-01' }] }), []);
});

test('chairs see the EXO root and team folders; group previews stay scoped', () => {
  const leadership = [{ user_id: 'member', role: 'exo_chair' }];
  assert.deepEqual(ids({ leadership }), ['root', 'controls', 'electrical', 'mechanical']);
  assert.deepEqual(ids({ leadership, previewTeamId: 'sub' }), ['mechanical']);
  assert.deepEqual(ids({ ready: false, leadership }), []);
});

test('unmapped, archived, missing, and cyclic teams do not fall back to EXO root', () => {
  assert.deepEqual(ids({}), []);
  for (const teams of [
    [{ id: 'c', name: 'Research' }],
    [{ id: 'c', name: 'Controls', archived_at: '2026-11-01' }],
    [{ id: 'c', name: 'Controls', parent_team_id: 'missing' }],
    [{ id: 'c', name: 'Controls', parent_team_id: 'c' }],
  ]) assert.deepEqual(ids({ teams, memberships: [{ user_id: 'member', team_id: 'c' }] }), []);
});

test('the Files view loads the chosen folder, retains it across tabs, and clears it on identity changes', () => {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      attrs: {}, writes: 0,
      getAttribute(name) { return this.attrs[name] ?? null; },
      removeAttribute(name) { delete this.attrs[name]; },
      setAttribute(name, value) { this.attrs[name] = value; },
      set src(value) { this.attrs.src = value; this.writes++; },
      set href(value) { this.attrs.href = value; },
    });
    return nodes.get(id);
  };
  const context = {
    $, EXO_FILES: globalThis.EXO_FILES, EXO_CONFIG: { driveRootFolder: rootFolder, driveTeamFolders: teamFolders },
    session: { user: { id: 'member' } }, preview: { mode: '', subject: '' }, phase: 'ready', activeTab: 'files',
    state: { teams: base.teams, memberships: [{ user_id: 'member', team_id: 'c' }], leadership: [] },
    viewUserId: () => context.preview.mode === 'member' ? context.preview.subject : context.session?.user.id,
    viewIsMember: () => Boolean(context.session) && context.phase === 'ready',
    options: values => JSON.stringify(values), document: { querySelectorAll: () => [] },
  };
  vm.createContext(context);
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('let filesSelection'), source.indexOf('function switchTab(')), context);
  context.renderFiles();
  assert.match($('#files-frame').attrs.src, /id=controls#grid$/);
  assert.match($('#files-open').attrs.href, /folders\/controls$/);
  context.activeTab = 'tasks'; context.renderFiles();
  context.activeTab = 'files'; context.renderFiles();
  assert.equal($('#files-frame').writes, 1);
  context.preview = { mode: 'member', subject: 'another-member' }; context.renderFiles();
  assert.equal($('#files-frame').attrs.src, undefined);
  assert.equal($('#files-open').attrs.href, undefined);
  context.preview = { mode: '', subject: '' }; context.renderFiles();
  assert.equal($('#files-frame').writes, 2);
  context.session = null; context.renderFiles();
  assert.equal($('#files-frame').attrs.src, undefined);
  assert.equal($('#files-frame').hidden, true);
  assert.equal($('#files-empty').hidden, false);
});
