// Shared data lives in Supabase. Only view preferences are stored locally.
// The previous exo-workbench-v1 demo data is left untouched and never uploaded.
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done', cancelled: 'Cancelled' };
const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const STATUS_CLASS = { todo: 'todo', in_progress: 'progress', blocked: 'blocked', review: 'review', done: 'done', cancelled: 'cancelled' };
const CORE_TASK_FIELDS = 'id,project_id,team_id,milestone_id,title,description,status,priority,assignee_id,due_at,completed_at,created_by,created_at,updated_at';
const TASK_FIELDS = `${CORE_TASK_FIELDS},archived_at,archived_by`;
const ACTIVITY_FIELDS = 'id,task_id,actor_id,actor_name,task_title,project_id,team_id,action,changes,created_at';
const state = { tasks: [], teams: [], projects: [], profiles: [], memberships: [], leadership: [], activity: [], project: '', team: 'all', subteam: 'all' };
let activityReady = false, recentKey = '', recentRequest = 0, recentLoading = false, recentError = '';
let recentExpanded = false, recentScope = '';
let auditRequest = 0;
const audit = { rows: [], loading: false, more: false, loaded: false, error: '' };
let taskHistoryRequest = 0;
const taskHistory = { taskId: '', rows: [], more: false, loading: false };
const taskFields = () => activityReady ? TASK_FIELDS : CORE_TASK_FIELDS;
const TABS = ['overview', 'tasks', 'administration'];
let client, session = null, phase = 'connecting', busy = false, generation = 0, authReady = false, activeTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let pendingAuthError = '';
let signinDismissed = false, signinError = '';
let setupMode = 'project';
let importPlan = null;
let aiTaskPlan = null;
let checkingGroupAccess = false;
let taskLensChosen = false, taskLensUser = '', showClosedTasks = false, taskEditing = false;
let taskLayoutUser = '', taskLayoutChoice = '', previewLayoutChoice = '';
function taskLayout() { return (preview.mode ? previewLayoutChoice : taskLayoutChoice) || 'list'; }
const dialogBaselines = new WeakMap();
function dialogFormState(dialog) {
  return JSON.stringify([...dialog.querySelectorAll('input:not([type="hidden"]),select,textarea')].map(field => [field.id || field.name, ['checkbox', 'radio'].includes(field.type) ? field.checked : field.value]));
}
function showDialog(dialog) {
  dialogBaselines.set(dialog, dialogFormState(dialog));
  dialog.showModal();
}
function requestDialogClose(dialog) {
  if (!dialog.open || busy) return false;
  const protectsChanges = dialog.id === 'setup-dialog' || dialog.id === 'import-dialog' || (dialog.id === 'task-dialog' && taskEditing);
  if (protectsChanges && dialogBaselines.has(dialog) && dialogBaselines.get(dialog) !== dialogFormState(dialog) && !confirm('Discard unsaved changes?')) return false;
  if (dialog.id === 'signin-dialog') signinDismissed = true;
  dialog.close(); return true;
}
// Preview identity never replaces the authenticated session or enters storage.
const preview = { mode: '', subject: '', saved: null };
const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = () => dateValue(new Date());
const dueDate = task => task.due_at ? dateValue(new Date(task.due_at)) : '';
const isClosed = task => ['done', 'cancelled'].includes(task.status);
const overdue = task => !isClosed(task) && task.due_at && dueDate(task) < today();
const teamById = id => state.teams.find(team => team.id === id);
const userName = id => state.profiles.find(profile => profile.id === id)?.display_name || (id ? 'Workspace member' : 'Unassigned');
const options = entries => entries.map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join('');
function setLinkedText(container, value) {
  const text = String(value ?? ''); let cursor = 0;
  container.replaceChildren();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    container.append(document.createTextNode(text.slice(cursor, match.index)));
    let candidate = match[0].replace(/[.,;:!?]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) candidate = candidate.slice(0, -1);
    }
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link');
      const link = document.createElement('a');
      link.href = url.href; link.textContent = candidate;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      container.append(link, document.createTextNode(match[0].slice(candidate.length)));
    } catch { container.append(document.createTextNode(match[0])); }
    cursor = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(cursor)));
}
function preferenceKey() { return `exo-scope-v2:${session?.user.id || 'visitor'}`; }
function savePreferences() { if (preview.mode) return; try { localStorage.setItem(preferenceKey(), JSON.stringify({ project: state.project, team: state.team, subteam: state.subteam })); } catch { /* Shared records are never stored here. */ } }
function readPreferences() { try { return JSON.parse(localStorage.getItem(preferenceKey()) || '{}') || {}; } catch { return {}; } }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  $('#sidebar-toggle').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  $('#sidebar-toggle span').textContent = collapsed ? '›' : '‹';
  try { localStorage.setItem('exo-sidebar-collapsed', String(collapsed)); } catch { /* Still works without storage. */ }
}
function setBanner(title, description, type = '') { $('#connection-title').textContent = title; $('#connection-description').textContent = description; $('#connection-banner').className = `connection-banner ${type}`; }
function errorMessage(error) {
  const context = error?.table ? `Could not load public.${error.table} (${error.code || 'request failed'}). ` : '';
  if (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error?.code)) return `${context}${error.message || 'A required table or column is unavailable.'} Compare the database with schema.sql, then refresh.`;
  if (error?.code === '42501') return `${context}Supabase denied access. Check your membership, leadership assignment, and database policies.`;
  if (error?.code === '23503' && /project_teams|tasks_project_id_team_id_fkey/i.test(`${error.message || ''} ${error.details || ''}`)) return 'The database still requires project/team links. Run supabase/independent-teams.sql in the Supabase SQL Editor, then refresh.';
  if (error?.code === '23503') return 'A project, team, assignee, or milestone changed. Refresh the workspace and try again.';
  if (/fetch|network|load failed/i.test(error?.message || '')) return 'Could not reach Supabase. Check your connection and try Refresh.';
  return error?.message || 'The request could not be completed. Please try again.';
}
// Follow ancestors using IDs, including arbitrarily nested teams without name collisions.
function ancestors(id) { const result = [], seen = new Set(); while (id && !seen.has(id)) { result.push(id); seen.add(id); id = teamById(id)?.parent_team_id; } return result; }
function rootId(id) { return ancestors(id).at(-1) || id; }
function teamPath(id) { return ancestors(id).reverse().map(id => teamById(id)?.name || 'Unknown team').join(' / '); }
function descendantOf(id, parent) { return ancestors(id).includes(parent); }
function rootsForProject(projectId) {
  if (!viewIsMember()) return [];
  const ids = new Set(state.teams.filter(team => canWorkIn(team.id, projectId)).map(team => rootId(team.id)));
  return state.teams.filter(team => ids.has(team.id));
}
function subteamsForScope() {
  return state.teams.filter(team => team.id !== state.team && descendantOf(team.id, state.team) && canWorkIn(team.id, state.project));
}
function isAdmin() { return state.leadership.some(role => role.user_id === session?.user.id && role.role === 'exo_chair' && !role.revoked_at && !role.team_id && !role.project_id); }
function viewUserId() { return preview.mode === 'member' ? preview.subject : preview.mode === 'group' ? null : session?.user.id; }
function userIsAdmin(userId) { return Boolean(userId) && state.leadership.some(role => role.user_id === userId && role.role === 'exo_chair' && !role.revoked_at && !role.team_id && !role.project_id); }
function viewIsAdmin() { return preview.mode === 'group' ? false : userIsAdmin(viewUserId()); }
function viewIsMember() {
  if (!session || phase !== 'ready') return false;
  if (preview.mode === 'group') return Boolean(teamById(preview.subject));
  const id = viewUserId();
  return state.memberships.some(member => member.user_id === id) || state.leadership.some(role => role.user_id === id && !role.revoked_at && ['exo_chair', 'permanent_project_lead', 'team_lead', 'project_lead'].includes(role.role));
}
function canWorkIn(teamId, projectId) {
  if (!viewIsMember() || !teamById(teamId) || !state.projects.some(project => project.id === projectId)) return false;
  const parents = ancestors(teamId);
  if (preview.mode === 'group') return parents.includes(preview.subject);
  const id = viewUserId();
  return viewIsAdmin() || state.memberships.some(member => member.user_id === id && parents.includes(member.team_id)) || state.leadership.some(role => role.user_id === id && !role.revoked_at && ((role.role === 'project_lead' && role.project_id === projectId && parents.includes(role.team_id)) || (role.role === 'team_lead' && parents.includes(role.team_id) && !role.project_id)));
}
function userHasGroupAccess(userId, teamId, projectId) {
  const parents = ancestors(teamId);
  return userIsAdmin(userId) || state.memberships.some(member => member.user_id === userId && parents.includes(member.team_id)) || state.leadership.some(role => role.user_id === userId && !role.revoked_at && parents.includes(role.team_id) && ((role.role === 'team_lead' && !role.project_id) || (role.role === 'project_lead' && role.project_id === projectId)));
}
function fillTaskAssignees(projectId, teamId, preferred = $('#task-assignee').value) {
  const people = state.profiles.filter(profile => userHasGroupAccess(profile.id, teamId, projectId));
  $('#task-assignee').innerHTML = options([['', 'Unassigned group work'], ...people.map(profile => [profile.id, profile.display_name || 'Workspace member'])]);
  const existing = state.tasks.find(task => task.id === $('#task-id').value);
  if (existing?.assignee_id === preferred && !people.some(profile => profile.id === preferred)) $('#task-assignee').insertAdjacentHTML('beforeend', options([[preferred, `${userName(preferred)} · check group access`]]));
  if (people.some(profile => profile.id === preferred) || existing?.assignee_id === preferred) $('#task-assignee').value = preferred || '';
}
function canManageIn(teamId, projectId) {
  if (!canWorkIn(teamId, projectId) || preview.mode === 'group') return false;
  const parents = ancestors(teamId), id = viewUserId();
  return viewIsAdmin() || state.leadership.some(role => role.user_id === id && !role.revoked_at && parents.includes(role.team_id) && ((role.role === 'team_lead' && !role.project_id) || (role.role === 'project_lead' && role.project_id === projectId)));
}
function canCreate() { return phase === 'ready' && state.projects.some(project => state.teams.some(team => canManageIn(team.id, project.id))); }
function creationBlockReason() {
  if (preview.mode) return 'Read-only testing view. Exit preview to create, edit, or delete shared records.';
  if (phase !== 'ready' || canCreate()) return '';
  const prefix = isAdmin() ? 'Your EXO chair role is active. ' : '';
  if (!state.projects.length) return `${prefix}${isAdmin() ? 'Open Administration to create your first project.' : 'Ask your EXO chair to create a project before adding tasks.'}`;
  if (!state.teams.length) return `${prefix}${isAdmin() ? 'Open Administration to create a team and enable task creation.' : 'Ask your EXO chair to create a team.'}`;
  return viewIsMember() ? '' : 'An administrator needs to add you to a group.';
}
function canEdit(task) { return !busy && !preview.mode && !task.archived_at && canManageIn(task.team_id, task.project_id); }
function canProgress(task) { return !busy && !preview.mode && !task.archived_at && task.status !== 'cancelled' && canWorkIn(task.team_id, task.project_id); }
function scopedTasks() {
  if (!viewIsMember()) return [];
  const lens = $('#task-lens').value;
  return state.tasks.filter(task => canWorkIn(task.team_id, task.project_id) && task.project_id === state.project && (activeTab === 'tasks' && $('#archive-filter').value === 'archived' ? Boolean(task.archived_at) : !task.archived_at) && (state.team === 'all' || descendantOf(task.team_id, state.team)) && (state.subteam === 'all' || descendantOf(task.team_id, state.subteam)) && (lens !== 'assigned' || (viewUserId() && task.assignee_id === viewUserId())));
}
function clearData() { for (const key of ['tasks', 'teams', 'projects', 'profiles', 'memberships', 'leadership', 'activity']) state[key] = []; activityReady = false; recentKey = ''; ++recentRequest; ++auditRequest; Object.assign(audit, { rows: [], loading: false, more: false, loaded: false, error: '' }); state.project = ''; state.team = 'all'; state.subteam = 'all'; for (const selector of ['#task-dialog', '#setup-dialog', '#members-dialog']) if ($(selector).open) $(selector).close(); if (!session && $('#import-dialog').open) $('#import-dialog').close(); }
function normalizeScope() {
  if (!state.projects.some(project => project.id === state.project)) state.project = state.projects[0]?.id || '';
  const roots = rootsForProject(state.project);
  if (state.team !== 'all' && !roots.some(team => team.id === state.team)) state.team = 'all';
  if (!viewIsAdmin() && roots.length === 1) state.team = roots[0].id;
  const children = subteamsForScope();
  if (state.team === 'all' || (state.subteam !== 'all' && !children.some(team => team.id === state.subteam))) state.subteam = 'all';
  if (!viewIsAdmin() && children.length === 1 && !canWorkIn(state.team, state.project)) state.subteam = children[0].id;
}
function fillScope() {
  normalizeScope();
  $('#project-select').innerHTML = viewIsMember() && state.projects.length ? options(state.projects.map(project => [project.id, project.name])) : '<option value="">No projects loaded</option>';
  $('#project-select').value = state.project;
  const roots = rootsForProject(state.project);
  $('#team-select').innerHTML = options([...(viewIsAdmin() || roots.length !== 1 ? [['all', viewIsAdmin() ? 'All teams' : 'My teams']] : []), ...roots.map(team => [team.id, team.name])]);
  $('#team-select').value = state.team;
  const children = subteamsForScope();
  const singleSubteam = !viewIsAdmin() && children.length === 1 && !canWorkIn(state.team, state.project);
  $('#subteam-select').innerHTML = options([...(singleSubteam ? [] : [['all', viewIsAdmin() || canWorkIn(state.team, state.project) ? 'All subteams' : 'My subteams']]), ...children.map(team => [team.id, teamPath(team.id).split(' / ').slice(1).join(' / ')])]);
  $('#subteam-select').value = state.subteam;
  $('#project-select').disabled = !viewIsMember() || busy || !state.projects.length;
  $('#team-select').disabled = phase !== 'ready' || busy || !rootsForProject(state.project).length;
  $('#subteam-select').disabled = phase !== 'ready' || busy || state.team === 'all' || !children.length;
}
function formatDate(value) {
  if (!value) return 'No due date';
  const date = new Date(value), day = dateValue(date), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === today()) return 'Today'; if (day === dateValue(tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function checkbox(task) { return `<input class="complete-check" type="checkbox" data-complete="${escapeHTML(task.id)}" ${task.status === 'done' ? 'checked' : ''} ${canProgress(task) ? '' : 'disabled'} aria-label="Mark ${escapeHTML(task.title)} ${task.status === 'done' ? 'incomplete' : 'complete'}">`; }
function titleButton(task) { return `<button class="task-title-button" data-edit="${escapeHTML(task.id)}" title="Open task details">${escapeHTML(task.title)}</button>`; }
function activityVerb(event) {
  if (event.action === 'updated' && (event.task_id || event.entity_type === 'tasks')) {
    const status = event.changes?.status;
    if (status?.to === 'done') return 'completed';
    if (status?.to === 'cancelled') return 'cancelled';
    if (status?.from === 'done') return 'reopened';
    if (status?.to === 'blocked') return 'marked blocked';
    if (status?.to === 'review') return 'submitted for review';
    if (event.changes?.assignee_id) return 'reassigned';
  }
  if (event.entity_type === 'team_members') return event.action === 'deleted' ? 'removed membership for' : 'added membership for';
  return { created: 'created', updated: 'updated', deleted: 'deleted', archived: 'archived', restored: 'restored' }[event.action] || event.action;
}
function historyValue(field, value) {
  if (value == null || value === '') return 'None';
  if (field === 'status') return STATUS[value] || value;
  if (field === 'priority') return PRIORITY[value] || value;
  if (['assignee_id', 'created_by', 'user_id', 'assigned_by', 'added_by', 'author_id'].includes(field)) return userName(value);
  if (field === 'team_id') return teamById(value) ? teamPath(value) : String(value);
  if (field === 'project_id') return state.projects.find(project => project.id === value)?.name || String(value);
  if (field.endsWith('_at')) return new Date(value).toLocaleString();
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function activityHTML(event, details = false) {
  const taskId = event.task_id || (event.entity_type === 'tasks' ? event.entity_id : null);
  const task = state.tasks.find(task => task.id === taskId);
  const label = event.task_title || event.entity_label || task?.title || 'Task';
  const actor = event.actor_id && event.actor_id === viewUserId() ? 'You' : event.actor_name || (event.actor_id ? userName(event.actor_id) : 'Administration / system');
  const title = task && canWorkIn(task.team_id, task.project_id) ? `<button type="button" class="text-button" data-edit="${escapeHTML(taskId)}">${escapeHTML(label)}</button>` : escapeHTML(label);
  const changes = Object.entries(event.changes || {}).filter(([field]) => !['id', 'created_at', 'updated_at', 'completed_at', 'archived_by'].includes(field));
  const detail = details && changes.length ? `<details class="event-details"><summary>View changes</summary><dl>${changes.map(([field, change]) => `<div><dt>${escapeHTML(field.replaceAll('_', ' '))}</dt><dd>${escapeHTML(historyValue(field, change?.from))} → ${escapeHTML(historyValue(field, change?.to))}</dd></div>`).join('')}</dl></details>` : '';
  return `<li class="activity-item"><p><strong>${escapeHTML(actor)}</strong> ${escapeHTML(activityVerb(event))} ${title}</p><time datetime="${escapeHTML(event.created_at)}">${escapeHTML(new Date(event.created_at).toLocaleString())}</time>${detail}</li>`;
}
function activityPage(query, cursor, size = 30) {
  query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
  if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  return query.range(0, size);
}
function renderRecentUpdates() {
  const scope = `${generation}|${state.project}|${state.team}|${state.subteam}|${preview.mode}|${preview.subject}`;
  if (recentScope !== scope) { recentScope = scope; recentExpanded = false; }
  const rows = state.activity.filter(event => event.project_id === state.project && canWorkIn(event.team_id, event.project_id) && (state.team === 'all' || descendantOf(event.team_id, state.team)) && (state.subteam === 'all' || descendantOf(event.team_id, state.subteam)));
  const visible = recentExpanded ? rows : rows.slice(0, 3);
  $('#recent-updates').innerHTML = visible.length ? visible.map(event => activityHTML(event)).join('') : `<li class="activity-empty">${recentLoading ? 'Loading updates…' : recentError || 'No recent updates in this group.'}</li>`;
  $('#toggle-updates').hidden = rows.length <= 3;
  $('#toggle-updates').textContent = recentExpanded ? 'Show less' : `Show more updates (${rows.length - 3})`;
  $('#toggle-updates').setAttribute('aria-expanded', String(recentExpanded));
  $('#refresh-updates').disabled = recentLoading || phase !== 'ready' || !activityReady;
}
async function refreshRecentActivity() {
  if (phase !== 'ready' || !activityReady || !viewIsMember()) { state.activity = []; renderRecentUpdates(); return; }
  const owner = session.user.id, version = generation, request = ++recentRequest;
  const groups = state.teams.filter(team => canWorkIn(team.id, state.project) && (state.team === 'all' || descendantOf(team.id, state.team)) && (state.subteam === 'all' || descendantOf(team.id, state.subteam))).map(team => team.id);
  if (!groups.length) { state.activity = []; recentLoading = false; renderRecentUpdates(); return; }
  recentLoading = true; recentError = ''; renderRecentUpdates();
  try {
    const { data, error } = await client.from('task_activity').select(ACTIVITY_FIELDS).eq('project_id', state.project).in('team_id', groups).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 99);
    if (request !== recentRequest || owner !== session?.user.id || version !== generation) return;
    if (error) throw error; state.activity = data || [];
  } catch { if (request === recentRequest && owner === session?.user.id && version === generation) recentError = 'Could not load updates. Try Refresh.'; }
  finally { if (request === recentRequest && owner === session?.user.id && version === generation) { recentLoading = false; renderRecentUpdates(); } }
}
function renderAdminHistory() {
  const allowed = phase === 'ready' && isAdmin() && !preview.mode;
  $('#activity-setup-note').hidden = !allowed || activityReady;
  $('#history-error').hidden = !audit.error; $('#history-error').textContent = audit.error;
  $('#workspace-history').innerHTML = audit.rows.length ? audit.rows.map(event => activityHTML(event, true)).join('') : `<li class="activity-empty">${!activityReady ? 'History will be available after the workspace update.' : audit.loading ? 'Loading history…' : 'No activity recorded for these filters.'}</li>`;
  $('#history-more').hidden = !audit.more; $('#history-more').disabled = audit.loading;
  for (const id of ['#history-type', '#history-project', '#refresh-history']) $(id).disabled = !allowed || !activityReady || audit.loading;
  const selected = $('#history-project').value || 'all';
  $('#history-project').innerHTML = options([['all', 'All projects'], ...state.projects.map(project => [project.id, project.name])]);
  $('#history-project').value = selected === 'all' || state.projects.some(project => project.id === selected) ? selected : 'all';
}
async function loadAdminHistory(reset = true) {
  if (phase !== 'ready' || !isAdmin() || preview.mode || !activityReady || audit.loading) return;
  const owner = session.user.id, version = generation, request = ++auditRequest;
  if (reset) audit.rows = [];
  audit.loading = true; audit.error = ''; renderAdminHistory();
  try {
    let query = client.from('workspace_activity').select('id,entity_type,entity_id,entity_label,action,actor_id,actor_name,project_id,team_id,changes,created_at');
    if ($('#history-type').value !== 'all') query = query.eq('entity_type', $('#history-type').value);
    if ($('#history-project').value !== 'all') query = query.eq('project_id', $('#history-project').value);
    const { data, error } = await activityPage(query, reset ? null : audit.rows.at(-1));
    if (request !== auditRequest || owner !== session?.user.id || version !== generation || !isAdmin() || preview.mode) return;
    if (error) throw error;
    audit.rows.push(...(data || []).slice(0, 30)); audit.more = (data || []).length > 30; audit.loaded = true;
  } catch { if (request === auditRequest && owner === session?.user.id && version === generation) audit.error = 'History could not be loaded. Try Refresh history.'; }
  finally { if (request === auditRequest && owner === session?.user.id && version === generation) { audit.loading = false; renderAdminHistory(); } }
}
function renderOverview(tasks) {
  const done = tasks.filter(task => task.status === 'done').length, inProgress = tasks.filter(task => task.status === 'in_progress').length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const available = viewIsMember();
  const stats = [['Total tasks', tasks.length, 'Across this workspace view', '<span class="nav-icon nav-icon-tasks" aria-hidden="true"></span>'], ['In progress', inProgress, 'Work currently underway', '◷'], ['Completed', done, 'Tasks marked as done', '✓'], ['Overdue', tasks.filter(overdue).length, 'Tasks past their due date', '⚑']];
  $('#stats').innerHTML = stats.map(([label, count, note, icon], index) => `<div class="stat"><div class="stat-top"><span class="label-with-help">${label}<span class="help"><button type="button" class="help-button" aria-label="About ${escapeHTML(label)}" aria-describedby="stat-help-${index}" aria-expanded="false">ⓘ</button><span class="help-text" role="tooltip" id="stat-help-${index}">${escapeHTML(note)}</span></span></span><span class="stat-icon">${icon}</span></div><strong>${available ? count : '—'}</strong></div>`).join('');
  const upcoming = tasks.filter(task => !isClosed(task)).sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999')).slice(0, 4);
  $('#up-next').innerHTML = available && upcoming.length ? upcoming.map(task => `<div class="upcoming-task">${checkbox(task)}<div class="upcoming-detail">${titleButton(task)}<small>${escapeHTML(teamPath(task.team_id))} · ${escapeHTML(userName(task.assignee_id))}</small></div><span class="due ${overdue(task) ? 'overdue' : ''}">${formatDate(task.due_at)}</span></div>`).join('') : `<div class="up-next-empty">${available ? 'No upcoming tasks in this view.' : 'Your shared tasks will appear once the workspace is available.'}</div>`;
  $('#progress-percent').innerHTML = `${available ? percent : '—'}<span>%</span>`;
  $('#progress-bar').style.width = `${available ? percent : 0}%`;
  $('#status-breakdown').innerHTML = Object.entries(STATUS).map(([value, label]) => `<div class="breakdown-row"><span class="legend-dot ${STATUS_CLASS[value]}"></span>${label}<strong>${available ? tasks.filter(task => task.status === value).length : '—'}</strong></div>`).join('');
  $('#progress-footer').textContent = available ? `${done} of ${tasks.length} tasks complete in this view.` : 'Sign in to see your team’s progress.';
  renderRecentUpdates();
}
function renderTasks(tasks) {
  const query = $('#task-search').value.toLowerCase().trim();
  const filtered = tasks.filter(task => `${task.title} ${task.description} ${userName(task.assignee_id)} ${teamPath(task.team_id)}`.toLowerCase().includes(query) && ($('#status-filter').value === 'all' || task.status === $('#status-filter').value) && ($('#priority-filter').value === 'all' || task.priority === $('#priority-filter').value));
  const archivedView = $('#archive-filter').value === 'archived';
  const closed = filtered.filter(isClosed), includeClosed = archivedView || showClosedTasks || ['done', 'cancelled'].includes($('#status-filter').value);
  const visible = filtered.filter(task => !isClosed(task) || includeClosed);
  const groupFor = task => isClosed(task) ? 'Completed / cancelled' : overdue(task) ? 'Overdue' : ({ blocked: 'Blocked', in_progress: 'In progress', review: 'Awaiting review', todo: 'Not started' }[task.status] || 'Other');
  const order = ['Blocked', 'Overdue', 'In progress', 'Awaiting review', 'Not started', 'Completed / cancelled', 'Other'];
  visible.sort((a, b) => order.indexOf(groupFor(a)) - order.indexOf(groupFor(b)) || (a.due_at || '9999').localeCompare(b.due_at || '9999') || a.title.localeCompare(b.title));
  const showGroups = new Set(visible.map(task => task.team_id)).size > 1;
  $('#task-group-heading').hidden = !showGroups;
  $('#task-list-title').textContent = archivedView ? 'Archived tasks' : $('#task-lens').value === 'assigned' ? 'My tasks' : viewIsAdmin() ? 'Workspace tasks' : 'Group tasks';
  $('#list-count').textContent = viewIsMember() ? visible.length : '—';
  $('#show-closed').hidden = archivedView || !closed.length;
  $('#show-closed').textContent = `${includeClosed ? 'Hide' : 'Show'} completed (${closed.length})`;
  $('#show-closed').setAttribute('aria-expanded', String(includeClosed));
  let previous = '';
  $('#task-rows').innerHTML = visible.map(task => {
    const name = userName(task.assignee_id);
    const group = groupFor(task), heading = previous === group ? '' : `<tr class="task-section"><th colspan="${showGroups ? 6 : 5}" scope="rowgroup">${group}</th></tr>`; previous = group;
    return `${heading}<tr class="task-item ${task.status === 'done' ? 'is-done' : ''}"><td class="check-cell">${checkbox(task)}</td><td class="task-name-cell">${titleButton(task)}${!task.assignee_id ? '<small class="task-subtitle">Unassigned group work</small>' : ''}${['urgent', 'high'].includes(task.priority) ? `<small class="priority ${task.priority}">${PRIORITY[task.priority]}</small>` : ''}</td><td data-label="Status"><span class="badge ${STATUS_CLASS[task.status] || 'todo'}">${escapeHTML(STATUS[task.status] || task.status)}</span></td><td data-label="Due" class="due ${overdue(task) ? 'overdue' : ''}">${formatDate(task.due_at)}</td><td data-label="Assignee"><div class="assignee"><span class="avatar">${escapeHTML(task.assignee_id ? name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() : '–')}</span>${escapeHTML(task.assignee_id ? name : 'Group work')}</div></td><td data-label="Group" ${showGroups ? '' : 'hidden'}>${escapeHTML(teamPath(task.team_id))}</td></tr>`;
  }).join('');
  previous = '';
  $('#task-cards').innerHTML = visible.map(task => {
    const group = groupFor(task), heading = previous === group ? '' : `<h3 class="task-card-section">${group}</h3>`; previous = group;
    const description = (task.description || '').split('\n\nImported from: https://github.com/orgs/IEEE-USF-EXO/projects/3')[0].replace(/\s+/g, ' ').trim();
    const showOwner = $('#task-lens').value !== 'assigned';
    return `${heading}<article class="compact-task ${task.status === 'done' ? 'is-done' : ''}" data-task-card="${escapeHTML(task.id)}"><div class="task-card-heading"><h3>${titleButton(task)}</h3>${['urgent', 'high'].includes(task.priority) ? `<span class="priority ${task.priority}">${PRIORITY[task.priority]}</span>` : ''}<span class="task-card-arrow" aria-hidden="true">↗</span></div><div class="task-card-meta"><span class="badge ${STATUS_CLASS[task.status] || 'todo'}">${escapeHTML(STATUS[task.status] || task.status)}</span>${task.due_at ? `<span class="due ${overdue(task) ? 'overdue' : ''}">${formatDate(task.due_at)}</span>` : ''}${showOwner ? `<span>${escapeHTML(task.assignee_id ? userName(task.assignee_id) : 'Unassigned group work')}</span>` : ''}${showGroups ? `<span>${escapeHTML(teamPath(task.team_id))}</span>` : ''}</div>${description ? `<p class="task-card-description">${escapeHTML(description.slice(0, 180))}${description.length > 180 ? '…' : ''}</p>` : ''}</article>`;
  }).join('');
  const layout = taskLayout();
  $('#task-cards').hidden = layout !== 'list'; $('#task-table-view').hidden = layout !== 'table';
  for (const button of document.querySelectorAll('[data-task-layout]')) { button.setAttribute('aria-pressed', String(button.dataset.taskLayout === layout)); button.disabled = !viewIsMember(); }
  $('#task-empty').hidden = visible.length > 0;
  $('#task-empty h3').textContent = viewIsMember() ? closed.length && !includeClosed ? 'No active tasks' : 'No tasks in this view' : 'Workspace unavailable';
  $('#empty-description').textContent = !viewIsMember() ? 'This account has no workspace access. See the message above.' : $('#task-lens').value === 'assigned' ? 'You have no assignments matching this view.' : closed.length ? 'Use Show completed to see finished work.' : tasks.length ? 'Try another search or adjust your filters.' : 'Your group’s tasks will appear here.';
  $('#empty-group-tasks').hidden = !viewIsMember() || $('#task-lens').value !== 'assigned';
}
function render() {
  if (preview.mode && !['loading', 'connecting'].includes(phase) && (!session || !isAdmin())) resetPreview();
  if (preview.mode === 'member' && !state.profiles.some(profile => profile.id === preview.subject) && phase === 'ready') resetPreview();
  if (preview.mode === 'group' && !teamById(preview.subject) && phase === 'ready') resetPreview();
  const chair = phase === 'ready' && isAdmin() && !preview.mode;
  if (activeTab === 'administration' && !chair && !['connecting', 'loading'].includes(phase)) {
    activeTab = 'overview'; history.replaceState(null, '', '#overview');
  }
  fillScope();
  if (taskLayoutUser !== session?.user.id) {
    taskLayoutUser = session?.user.id || ''; taskLayoutChoice = '';
    try { const saved = localStorage.getItem(`exo-task-layout:${taskLayoutUser}`); if (['list', 'table'].includes(saved)) taskLayoutChoice = saved; } catch { /* The default layout remains usable. */ }
  }
  if (taskLensUser !== session?.user.id) { taskLensChosen = false; taskLensUser = session?.user.id || ''; }
  const groupTasks = state.tasks.filter(task => !task.archived_at && task.project_id === state.project && canWorkIn(task.team_id, task.project_id) && (state.team === 'all' || descendantOf(task.team_id, state.team)) && (state.subteam === 'all' || descendantOf(task.team_id, state.subteam)));
  const personalTasks = groupTasks.some(task => task.assignee_id === viewUserId());
  if (phase === 'ready' && preview.mode !== 'group' && !taskLensChosen) $('#task-lens').value = viewIsAdmin() ? 'all' : personalTasks ? 'assigned' : 'team';
  $('#task-scope-note').hidden = !viewIsMember() || viewIsAdmin() || preview.mode === 'group' || taskLensChosen || personalTasks || !groupTasks.length;
  $('#task-scope-note').textContent = 'No individual assignments here. Showing your group’s work.';
  for (const button of document.querySelectorAll('[data-task-scope]')) { button.setAttribute('aria-pressed', String(button.dataset.taskScope === 'assigned' ? $('#task-lens').value === 'assigned' : $('#task-lens').value !== 'assigned')); button.disabled = !viewIsMember() || (preview.mode === 'group' && button.dataset.taskScope === 'assigned'); }
  $('#group-tasks-button').textContent = viewIsAdmin() ? 'All groups' : 'My group';
  const managesTasks = state.teams.some(team => canManageIn(team.id, state.project));
  $('#archive-filter').hidden = !managesTasks || !activityReady;
  if (!managesTasks || !activityReady) $('#archive-filter').value = 'active';
  const team = teamById(state.team), subteam = teamById(state.subteam), tasks = scopedTasks();
  $('#overview-scope').textContent = subteam?.name || team?.name || (viewIsAdmin() ? 'Across all teams' : 'Across my groups');
  $('#nav-count').textContent = viewIsMember() ? tasks.filter(task => !isClosed(task)).length : '—';
  $('#tab-count').textContent = viewIsMember() ? tasks.length : '—';
  $('#page-title').textContent = { overview: 'Overview', tasks: 'Tasks', administration: 'Administration' }[activeTab];
  $('#new-task').hidden = activeTab === 'administration' || (phase === 'ready' && !canCreate());
  $('#add-task-row').hidden = phase === 'ready' && !canCreate();
  $('#nav-administration').hidden = !chair; $('#tab-administration').hidden = !chair;
  for (const element of document.querySelectorAll('[data-tab]')) {
    const active = element.dataset.tab === activeTab; element.classList.toggle('active', active);
    if (element.getAttribute('role') === 'tab') { element.setAttribute('aria-selected', String(active)); element.tabIndex = active ? 0 : -1; }
    else if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  }
  $('#overview-view').hidden = activeTab !== 'overview'; $('#tasks-view').hidden = activeTab !== 'tasks';
  $('#administration-view').hidden = !chair || activeTab !== 'administration';
  $('#auth-button').disabled = !authReady || busy;
  $('#auth-button').textContent = !authReady ? 'Connecting…' : session ? 'Sign out' : 'Sign in with Google';
  $('#google-signin').disabled = !authReady || busy;
  $('#google-signin-label').textContent = busy ? 'Opening Google…' : !authReady && phase !== 'error' ? 'Connecting…' : 'Continue with Google';
  const signinMessage = signinError || pendingAuthError || (phase === 'error' ? $('#connection-description').textContent : '');
  $('#signin-error').textContent = signinMessage;
  $('#signin-error').hidden = !signinMessage;
  $('#signin-reload').hidden = phase !== 'error' || authReady;
  $('#close-signin').disabled = busy;
  if (session && $('#signin-dialog').open) $('#signin-dialog').close();
  else if (!session && !signinDismissed && ['signed-out', 'error'].includes(phase) && !$('#signin-dialog').open) showDialog($('#signin-dialog'));
  $('#auth-user').hidden = !session;
  $('#auth-user').textContent = session ? (state.profiles.find(profile => profile.id === session.user.id)?.display_name || session.user.user_metadata?.full_name || 'Signed in') : '';
  $('#refresh-data').hidden = !client; $('#refresh-data').disabled = busy || phase === 'loading';
  for (const selector of ['#new-task', '#add-task-row']) $(selector).disabled = busy || Boolean(preview.mode) || !canCreate();
  const creationHint = creationBlockReason();
  $('#creation-hint').textContent = creationHint;
  $('#creation-hint').hidden = !creationHint || activeTab === 'administration';
  for (const selector of ['#new-task', '#add-task-row']) $(selector).title = creationHint;
  $('#admin-actions').hidden = !chair;
  for (const selector of ['#new-project', '#new-team']) $(selector).disabled = busy || Boolean(preview.mode) || !chair;
  $('#new-subteam').disabled = busy || Boolean(preview.mode) || !chair || !state.teams.some(team => !team.parent_team_id);
  $('#new-subteam').title = state.teams.some(team => !team.parent_team_id) ? '' : 'Create a parent team first.';
  $('#manage-members').disabled = busy || Boolean(preview.mode) || !chair;
  if ($('#members-dialog').open) {
    if (phase !== 'ready' || !isAdmin() || preview.mode) $('#members-dialog').close();
    else lockMembers();
  }
  $('#import-github').disabled = busy || Boolean(preview.mode) || !chair || !state.projects.length;
  $('#import-github').title = state.projects.length ? '' : 'Create a destination project first.';
  for (const selector of ['#task-search', '#task-lens', '#status-filter', '#priority-filter']) $(selector).disabled = !viewIsMember();
  $('#task-lens option[value="assigned"]').disabled = preview.mode === 'group';
  $('#task-lens option[value="all"]').textContent = viewIsAdmin() ? 'All workspace tasks' : 'My groups’ tasks';
  $('#view-as').hidden = phase !== 'ready' || !isAdmin() || Boolean(preview.mode);
  $('#view-as').disabled = busy || !state.profiles.length;
  renderPreview();
  if (phase === 'ready') updateConnectedBanner();
  $('#connection-banner').hidden = phase === 'ready' && viewIsMember() && state.projects.length > 0 && state.teams.length > 0;
  $('main').setAttribute('aria-busy', String(phase === 'loading' || phase === 'connecting'));
  const open = state.tasks.find(task => task.id === $('#task-id').value);
  $('#task-progress-status').disabled = !open || !canProgress(open);
  if ($('#task-dialog').open) $('#delete-task').disabled = busy || !activityReady;
  renderOverview(tasks); renderTasks(tasks); renderAdminHistory();
  const key = `${generation}|${state.project}|${state.team}|${state.subteam}|${preview.mode}|${preview.subject}`;
  if (phase === 'ready' && activityReady && recentKey !== key) { recentKey = key; setTimeout(refreshRecentActivity, 0); }
}
function switchTab(tab) { if (!TABS.includes(tab) || (tab === 'administration' && (phase !== 'ready' || !isAdmin() || preview.mode))) return; activeTab = tab; if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`); render(); if (tab === 'administration' && !audit.loaded) loadAdminHistory(); }
function resetPreview() {
  const saved = preview.saved;
  preview.mode = ''; preview.subject = ''; preview.saved = null;
  if (saved) {
    taskLensChosen = Boolean(saved.lensChosen);
    state.project = saved.project; state.team = saved.team; state.subteam = saved.subteam;
    $('#task-lens').value = saved.lens; $('#task-search').value = saved.search;
    $('#status-filter').value = saved.status; $('#priority-filter').value = saved.priority;
    if (saved.tab) { activeTab = saved.tab; history.replaceState(null, '', `#${activeTab}`); }
  }
  if ($('#task-dialog').open) $('#task-dialog').close();
}
function applyPreviewSubject() {
  previewLayoutChoice = '';
  taskLensChosen = false;
  state.team = 'all'; state.subteam = 'all';
  $('#task-lens').value = preview.mode === 'group' ? 'team' : 'all';
  $('#task-search').value = ''; $('#status-filter').value = 'all'; $('#priority-filter').value = 'all';
  if ($('#task-dialog').open) $('#task-dialog').close();
}
function startPreview() {
  if (busy || phase !== 'ready' || !isAdmin()) return;
  if (!preview.mode) preview.saved = { tab: activeTab, project: state.project, team: state.team, subteam: state.subteam, lens: $('#task-lens').value, lensChosen: taskLensChosen, search: $('#task-search').value, status: $('#status-filter').value, priority: $('#priority-filter').value };
  preview.mode = 'member'; preview.subject = state.profiles.find(profile => profile.id !== session.user.id)?.id || session.user.id;
  applyPreviewSubject(); switchTab('overview'); $('#preview-subject').focus();
}
function renderPreview() {
  $('#member-preview').hidden = !preview.mode;
  if (!preview.mode) return;
  $('#preview-mode').value = preview.mode;
  $('#preview-mode option[value="group"]').disabled = !state.teams.length;
  $('#preview-subject-label').textContent = preview.mode === 'member' ? 'Member' : 'Team / subteam';
  const subjects = preview.mode === 'member' ? state.profiles.map(profile => [profile.id, `${profile.display_name || 'Workspace member'} · ${profile.id.slice(0, 8)}`]) : state.teams.map(team => [team.id, teamPath(team.id)]);
  $('#preview-subject').innerHTML = subjects.length ? options(subjects) : '<option value="">No teams available</option>';
  $('#preview-subject').value = preview.subject;
  $('#preview-mode').disabled = phase !== 'ready' || busy;
  $('#preview-subject').disabled = phase !== 'ready' || busy || !subjects.length;
  $('#exit-preview').disabled = busy;
  if (phase !== 'ready') { $('#preview-summary').textContent = 'Refreshing the preview’s memberships and roles…'; return; }
  const label = preview.mode === 'group' ? `Ordinary member of ${teamPath(preview.subject)}` : userName(preview.subject);
  const roles = preview.mode === 'member' ? state.leadership.filter(role => role.user_id === preview.subject && !role.revoked_at).map(role => role.role.replaceAll('_', ' ')) : [];
  const tasks = scopedTasks(), editable = tasks.filter(task => canWorkIn(task.team_id, task.project_id)).length;
  $('#preview-summary').textContent = `${label}${roles.length ? ` · ${[...new Set(roles)].join(', ')}` : ''} · Workspace access: ${viewIsMember() ? 'yes' : 'no'} · Could create tasks: ${canCreate() ? 'yes' : 'no'} · Could edit ${editable} of ${tasks.length} tasks in this scope. Preview saves are disabled.`;
}
// Range pagination prevents silently dropping records at Supabase's default row cap.
async function readAll(table, fields, order = 'id') {
  const rows = []; let start = 0;
  for (;;) {
    let query = client.from(table).select(fields);
    for (const column of order.split(',')) query = query.order(column);
    const { data, error } = await query.range(start, start + 499);
    if (error) throw { ...error, table }; if (!Array.isArray(data)) throw new Error(`Invalid response loading ${table}.`);
    rows.push(...data); if (data.length < 500) return rows; start += data.length;
  }
}
async function readTaskDataset() {
  try { return { rows: await readAll('tasks', TASK_FIELDS), ready: true }; }
  catch (error) {
    if (!['PGRST204', '42703'].includes(error.code)) throw error;
    return { rows: await readAll('tasks', CORE_TASK_FIELDS), ready: false };
  }
}
async function loadWorkspace() {
  if (!client || busy) return;
  const current = ++generation, userId = session?.user.id;
  const previewScope = preview.mode ? { project: state.project, team: state.team, subteam: state.subteam } : null;
  clearData();
  if (!session) { phase = 'signed-out'; setBanner('Sign in to your workspace', pendingAuthError || 'Use Google sign-in to load your teams, projects, and shared tasks.'); render(); return; }
  phase = 'loading'; setBanner('Loading shared workspace', 'Reading projects, teams, members, and tasks from Supabase…'); render();
  try {
    const [teams, projects, profiles, memberships, leadership, tasks] = await Promise.all([
      readAll('teams', 'id,name,parent_team_id'), readAll('projects', 'id,name,status'),
      readAll('profiles', 'id,display_name'),
      readAll('team_members', 'team_id,user_id', 'team_id,user_id'),
      readAll('leadership_assignments', 'id,user_id,role,team_id,project_id,revoked_at'), readTaskDataset()
    ]);
    if (current !== generation || userId !== session?.user.id) return;
    activityReady = tasks.ready;
    Object.assign(state, { teams, projects, profiles, memberships, leadership, tasks: tasks.rows });
    const prefs = previewScope || readPreferences(); state.project = prefs.project || ''; state.team = prefs.team || 'all'; state.subteam = prefs.subteam || 'all';
    const member = memberships.some(member => member.user_id === userId) || leadership.some(role => role.user_id === userId && !role.revoked_at && ['exo_chair', 'permanent_project_lead', 'project_lead', 'team_lead'].includes(role.role));
    phase = member ? 'ready' : 'no-access';
    if (!member) setBanner('Waiting for group access', 'You’re signed in. An administrator needs to add you to a team or subteam before you can access your workspace.', 'notice');
    else updateConnectedBanner();
    if (!member) { state.tasks = []; state.teams = []; state.projects = []; }
  } catch (error) {
    if (current !== generation || userId !== session?.user.id) return;
    clearData(); phase = 'error'; setBanner('Workspace could not be loaded', errorMessage(error), 'error');
  }
  render();
  if (activeTab === 'administration' && isAdmin() && !preview.mode) loadAdminHistory();
}
// Recheck persisted memberships so edits in Supabase take effect without signing
// out. Do not interrupt an open form; the database still checks every request.
async function refreshGroupAccess() {
  if (!session || !client || busy || checkingGroupAccess || document.hidden || document.querySelector('dialog[open]') || !['ready', 'no-access'].includes(phase)) return;
  const owner = session.user.id, version = generation;
  checkingGroupAccess = true;
  try {
    const [memberships, leadership] = await Promise.all([
      readAll('team_members', 'team_id,user_id', 'team_id,user_id'),
      readAll('leadership_assignments', 'id,user_id,role,team_id,project_id,revoked_at')
    ]);
    if (owner !== session?.user.id || version !== generation || busy || document.querySelector('dialog[open]')) return;
    if (JSON.stringify(memberships) !== JSON.stringify(state.memberships) || JSON.stringify(leadership) !== JSON.stringify(state.leadership)) await loadWorkspace();
  } catch { /* Keep the current view during a network outage. RLS remains authoritative. */ }
  finally { checkingGroupAccess = false; }
}
function updateConnectedBanner() {
  if (preview.mode && !viewIsMember()) setBanner('Preview · membership needed', 'This member has no active team membership or leadership assignment. They would not have workspace access.', 'error');
  else if (!state.projects.length) setBanner('Connected · no projects yet', viewIsAdmin() ? 'Open Administration to create your first project.' : 'An EXO chair can create your first project.', 'ready');
  else if (!state.teams.length) setBanner('Connected · no teams yet', viewIsAdmin() ? 'Open Administration to create a team and start adding tasks.' : 'An EXO chair can create teams for task assignments.', 'ready');
  else {
    const count = state.tasks.filter(task => canWorkIn(task.team_id, task.project_id)).length;
    setBanner('Connected to Supabase', `${count} task${count === 1 ? '' : 's'} available to your groups across projects. Use Refresh to get the latest changes.`, 'ready');
  }
}
function resetImportPlan() {
  importPlan = null; $('#import-preview').hidden = true; $('#import-preview').textContent = '';
  $('#import-error').hidden = true; $('#import-progress').textContent = '';
  $('#save-import').textContent = 'Load GitHub tasks'; $('#save-import').disabled = false;
}
function openImport() {
  if (preview.mode || busy || phase !== 'ready' || !isAdmin() || !state.projects.length) return;
  if (!window.ExoBoard) { toast('The GitHub board reader did not load. Reload the page.'); return; }
  $('#import-form').reset(); resetImportPlan();
  $('#import-project').innerHTML = options(state.projects.map(project => [project.id, project.name]));
  $('#import-project').value = state.project || state.projects[0].id;
  showDialog($('#import-dialog')); $('#import-project').focus();
}
function lockImport(locked) { for (const field of $('#import-form').querySelectorAll('button,input,select')) field.disabled = locked; }
async function prepareImport() {
  if (preview.mode) return;
  const owner = session.user.id, version = generation, projectId = $('#import-project').value;
  busy = true; lockImport(true); $('#import-error').hidden = true; $('#import-progress').textContent = 'Reading the public GitHub board…'; render();
  try {
    const result = await ExoBoard.load();
    const selected = ExoBoard.selectRows(result.rows, $('#import-closed').checked);
    selected.forEach(ExoBoard.validate);
    const entries = await Promise.all(selected.map(async row => ({ row, id: await ExoBoard.taskId(projectId, row.id) })));
    if (owner !== session?.user.id || version !== generation) return;
    const existing = new Set(state.tasks.map(task => task.id));
    const fresh = entries.filter(entry => !existing.has(entry.id));
    importPlan = { projectId, entries, fetchedAt: result.fetchedAt };
    $('#import-preview').innerHTML = `<strong>${fresh.length} new task${fresh.length === 1 ? '' : 's'} ready to import</strong><p>${entries.length - fresh.length} already imported · ${new Set(selected.map(row => ExoBoard.nameKey(row.team))).size} teams · EXO items only</p><ul>${fresh.slice(0, 5).map(entry => `<li>${escapeHTML(entry.row.title)}<small>${escapeHTML(entry.row.team)}${entry.row.subteam ? ` / ${escapeHTML(entry.row.subteam)}` : ''} · ${escapeHTML(entry.row.status)}</small></li>`).join('')}</ul>${fresh.length > 5 ? `<p>And ${fresh.length - 5} more tasks.</p>` : ''}`;
    $('#import-preview').hidden = false;
    $('#import-progress').textContent = `Board snapshot loaded ${new Date(result.fetchedAt).toLocaleString()}. Existing dashboard tasks will not be overwritten.`;
  } catch (error) {
    if (owner === session?.user.id && version === generation) { importPlan = null; $('#import-error').textContent = errorMessage(error); $('#import-error').hidden = false; $('#import-progress').textContent = ''; }
  } finally {
    busy = false; lockImport(false);
    const count = importPlan?.entries.filter(entry => !state.tasks.some(task => task.id === entry.id)).length || 0;
    $('#save-import').textContent = importPlan ? (count ? `Import ${count} tasks to Supabase` : 'All tasks already imported') : 'Load GitHub tasks';
    $('#save-import').disabled = Boolean(importPlan && !count); render();
  }
}
async function executeImport() {
  if (preview.mode) return;
  const owner = session.user.id, version = generation, plan = importPlan;
  if (!plan || !state.projects.some(project => project.id === plan.projectId)) return;
  busy = true; lockImport(true); $('#import-error').hidden = true;
  $('#import-progress').textContent = 'Checking existing Supabase records…'; render();
  let imported = 0, failure = null;
  function assertSession() { if (owner !== session?.user.id || version !== generation) throw new Error('The signed-in account changed. Import stopped.'); }
  try {
    // Refresh before writing so manually added records and other imports are reused.
    const [teams, tasks] = await Promise.all([readAll('teams', 'id,name,parent_team_id'), readAll('tasks', 'id')]);
    assertSession();
    const pending = plan.entries.filter(entry => !tasks.some(task => task.id === entry.id));
    // INSERT ... ON CONFLICT DO NOTHING makes retries safe across tabs/devices.
    async function ensure(table, values, fields, keys = ['id']) {
      assertSession();
      const { data, error } = await client.from(table).upsert(values, { onConflict: keys.join(','), ignoreDuplicates: true }).select(fields).maybeSingle();
      if (error) throw error; assertSession(); if (data) return data;
      let query = client.from(table).select(fields); for (const key of keys) query = query.eq(key, values[key]);
      const existing = await query.maybeSingle(); if (existing.error) throw existing.error; assertSession();
      if (!existing.data) throw new Error(`Could not confirm the saved ${table} record. Refresh and retry.`);
      return existing.data;
    }
    async function ensureTeam(name, parentId = null) {
      const matches = teams.filter(team => (team.parent_team_id || null) === parentId && ExoBoard.nameKey(team.name) === ExoBoard.nameKey(name));
      if (matches.length > 1) throw new Error(`More than one team is named “${name}” under the same parent. Resolve the duplicate before importing.`);
      if (matches.length) return matches[0];
      const team = await ensure('teams', { id: await ExoBoard.teamId(parentId, name), name, parent_team_id: parentId }, 'id,name,parent_team_id');
      teams.push(team); return team;
    }
    const values = [];
    for (const entry of pending) {
      assertSession(); $('#import-progress').textContent = `Preparing ${entry.row.team}${entry.row.subteam ? ` / ${entry.row.subteam}` : ''}…`;
      const root = await ensureTeam(entry.row.team);
      const team = entry.row.subteam ? await ensureTeam(entry.row.subteam, root.id) : root;
      values.push(ExoBoard.taskValues(entry.row, plan.projectId, team.id, owner, entry.id));
    }
    for (let offset = 0; offset < values.length; offset += 100) {
      assertSession(); $('#import-progress').textContent = `Saving tasks ${offset + 1}–${Math.min(offset + 100, values.length)} of ${values.length} to Supabase…`;
      const { data, error } = await client.from('tasks').upsert(values.slice(offset, offset + 100), { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) throw error; if (!Array.isArray(data)) throw new Error('Supabase did not confirm the imported tasks. Refresh and retry.');
      imported += data.length; assertSession();
    }
    state.project = plan.projectId; state.team = 'all'; state.subteam = 'all'; savePreferences();
  } catch (error) { failure = error; }
  finally {
    busy = false; lockImport(false);
    if (owner === session?.user.id && version === generation) {
      await loadWorkspace(); importPlan = null;
      if (failure) {
        $('#import-error').textContent = `${errorMessage(failure)} ${imported} tasks were saved before the import stopped. Any teams already created are retained. Reload the board and retry; existing items will be skipped.`;
        $('#import-error').hidden = false; $('#import-preview').hidden = true; $('#save-import').textContent = 'Load GitHub tasks'; $('#save-import').disabled = false; $('#import-progress').textContent = '';
      } else {
        $('#import-dialog').close(); toast(`${imported} tasks saved to Supabase; ${plan.entries.length - imported} existing items skipped.`);
      }
    }
    render();
  }
}
async function submitImport(event) {
  event.preventDefault(); if (preview.mode || busy || !session || phase !== 'ready' || !isAdmin()) return;
  if (importPlan) await executeImport(); else await prepareImport();
}
function openSetup(mode) {
  if (preview.mode || busy || phase !== 'ready' || !isAdmin() || !['project', 'team', 'subteam'].includes(mode)) return;
  const roots = state.teams.filter(team => !team.parent_team_id);
  if (mode === 'subteam' && !roots.length) return;
  setupMode = mode;
  $('#setup-form').reset(); $('#setup-error').hidden = true;
  for (const field of $('#setup-form').querySelectorAll('input,select,textarea,button')) field.disabled = false;
  const labels = { project: 'New project', team: 'New team', subteam: 'New subteam' };
  $('#setup-title').textContent = labels[mode];
  $('#save-setup').textContent = `Create ${mode}`;
  $('#setup-description').textContent = {
    project: 'Create a project shared across the workspace. Assign its tasks to any team or subteam.',
    team: 'Create a workspace team. It can receive tasks from any project.',
    subteam: 'Create a group within a parent team. It can receive tasks from any project.'
  }[mode];
  $('#setup-name').maxLength = mode === 'project' ? 160 : 120;
  $('#setup-parent-field').hidden = mode !== 'subteam'; $('#setup-parent').required = mode === 'subteam';
  $('#setup-parent').innerHTML = options(roots.map(team => [team.id, team.name]));
  if (roots.some(team => team.id === state.team)) $('#setup-parent').value = state.team;
  showDialog($('#setup-dialog')); $('#setup-name').focus();
}
async function saveSetup(event) {
  event.preventDefault(); if (preview.mode || busy || phase !== 'ready' || !session || !isAdmin()) return;
  const name = $('#setup-name').value.trim(), description = $('#setup-notes').value.trim() || null;
  if (!name) { $('#setup-name').setCustomValidity('Enter a name.'); $('#setup-name').reportValidity(); return; }
  const owner = session.user.id, version = generation, mode = setupMode;
  let table, values, fields;
  if (mode === 'project') { table = 'projects'; values = { name, description, status: 'active', created_by: owner }; fields = 'id,name,status'; }
  else {
    table = 'teams'; values = { name, description, parent_team_id: mode === 'subteam' ? $('#setup-parent').value : null }; fields = 'id,name,parent_team_id';
    if (mode === 'subteam' && !state.teams.some(team => team.id === values.parent_team_id && !team.parent_team_id)) return;
  }
  busy = true; $('#setup-error').hidden = true;
  for (const field of $('#setup-form').querySelectorAll('input,select,textarea,button')) field.disabled = true;
  $('#save-setup').textContent = 'Saving to Supabase…'; render();
  try {
    const { data, error } = await client.from(table).insert(values).select(fields).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Supabase did not return a saved record. Check your permissions and refresh.');
    if (owner !== session?.user.id || version !== generation) return;
    if (mode === 'project') { state.projects.push(data); state.project = data.id; state.team = 'all'; state.subteam = 'all'; }
    else state.teams.push(data);
    savePreferences(); updateConnectedBanner(); $('#setup-dialog').close();
    toast(`${mode === 'subteam' ? 'Subteam' : mode === 'team' ? 'Team' : 'Project'} created in Supabase.`);
  } catch (error) {
    if (owner === session?.user.id && version === generation) {
      $('#setup-error').textContent = error.code === '23505' ? 'This record already exists. Close this dialog and refresh to see the latest data.' : errorMessage(error);
      $('#setup-error').hidden = false;
    }
  } finally {
    busy = false;
    for (const field of $('#setup-form').querySelectorAll('input,select,textarea,button')) field.disabled = false;
    $('#save-setup').textContent = `Create ${mode}`;
    render();
  }
}
function lockMembers() {
  const locked = busy || phase !== 'ready' || !isAdmin() || Boolean(preview.mode);
  for (const field of $('#members-form').querySelectorAll('button,select')) field.disabled = locked;
  $('#member-select').disabled = locked || !state.profiles.length;
  $('#member-team').disabled = locked || !$('#member-select').value || !$('#member-team').value;
  $('#add-member').disabled = $('#member-team').disabled;
}
function renderMemberGroups() {
  const userId = $('#member-select').value;
  const groups = state.memberships.filter(member => member.user_id === userId);
  const roles = state.leadership.filter(role => role.user_id === userId && !role.revoked_at);
  const available = state.teams.filter(team => !groups.some(member => member.team_id === team.id));
  const previousTeam = $('#member-team').value;
  $('#member-groups').innerHTML = groups.map(member => `<li><span>${escapeHTML(teamPath(member.team_id))}<small>${state.teams.some(team => team.parent_team_id === member.team_id) ? 'Includes descendant subteams' : 'Direct membership'}</small></span><button type="button" class="button danger" data-remove-membership="${escapeHTML(member.team_id)}" aria-label="Remove ${escapeHTML(userName(userId))} from ${escapeHTML(teamPath(member.team_id))}">Remove</button></li>`).join('');
  $('#member-summary').textContent = !userId ? (state.profiles.length ? 'Select a person to view their groups.' : 'No profiles found. Members appear after their first Google sign-in; use Refresh people afterward.') : `${groups.length} direct group${groups.length === 1 ? '' : 's'}${roles.length ? ` · Active roles: ${[...new Set(roles.map(role => role.role.replaceAll('_', ' ')))].join(', ')}` : groups.length ? '' : ' · Membership needed for workspace access'}`;
  $('#member-team').innerHTML = available.length ? options(available.map(team => [team.id, teamPath(team.id)])) : options([['', state.teams.length ? 'Already in every group' : 'Create a team first']]);
  if (available.some(team => team.id === previousTeam)) $('#member-team').value = previousTeam;
  lockMembers();
}
function fillMemberPeople() {
  const selected = $('#member-select').value;
  const people = [...state.profiles].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  $('#member-select').innerHTML = options([['', 'Choose a person…'], ...people.map(profile => [profile.id, `${profile.display_name || 'Workspace member'} · ${profile.id.slice(0, 8)}${state.memberships.some(member => member.user_id === profile.id) ? '' : ' · No group'}`])]);
  if (people.some(profile => profile.id === selected)) $('#member-select').value = selected;
  renderMemberGroups();
}
async function readMemberData(owner, version) {
  const [profiles, teams, memberships, leadership] = await Promise.all([
    readAll('profiles', 'id,display_name'), readAll('teams', 'id,name,parent_team_id'),
    readAll('team_members', 'team_id,user_id', 'team_id,user_id'),
    readAll('leadership_assignments', 'id,user_id,role,team_id,project_id,revoked_at')
  ]);
  if (owner !== session?.user.id || version !== generation) return false;
  Object.assign(state, { profiles, teams, memberships, leadership });
  fillMemberPeople(); return true;
}
async function refreshMembers() {
  if (busy || preview.mode || phase !== 'ready' || !isAdmin()) return;
  const owner = session.user.id, version = generation;
  busy = true; $('#members-error').hidden = true; $('#members-status').textContent = 'Loading signed-in people and group memberships…'; render();
  try {
    if (await readMemberData(owner, version)) $('#members-status').textContent = 'Memberships are saved directly to Supabase.';
  } catch (error) {
    if (owner === session?.user.id && version === generation) { $('#members-error').textContent = errorMessage(error); $('#members-error').hidden = false; $('#members-status').textContent = ''; }
  } finally { if (owner === session?.user.id && version === generation) { busy = false; render(); } }
}
function openMembers() {
  if (busy || preview.mode || phase !== 'ready' || !isAdmin()) return;
  $('#members-form').reset(); $('#members-error').hidden = true; $('#members-status').textContent = '';
  fillMemberPeople(); showDialog($('#members-dialog')); refreshMembers();
}
async function changeMembership(teamId, remove = false) {
  if (busy || preview.mode || phase !== 'ready' || !session || !isAdmin() || !$('#members-dialog').open) return;
  const userId = $('#member-select').value;
  if (!state.profiles.some(profile => profile.id === userId) || !teamById(teamId)) return;
  if (remove && !confirm(`Remove ${userName(userId)} from ${teamPath(teamId)}? If this is their last group and they have no leadership role, they will lose workspace access.`)) return;
  const owner = session.user.id, version = generation;
  let saved = false;
  busy = true; $('#members-error').hidden = true; $('#members-status').textContent = remove ? 'Removing membership…' : 'Adding membership…'; render();
  try {
    const query = remove ? client.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId) : client.from('team_members').insert({ team_id: teamId, user_id: userId });
    const { data, error } = await query.select('team_id,user_id').maybeSingle();
    if (owner !== session?.user.id || version !== generation) return;
    if (error) {
      if (error.code === '23505') { await readMemberData(owner, version); throw new Error('This person is already in that group. Memberships have been refreshed.'); }
      throw error;
    }
    if (!data) { await readMemberData(owner, version); throw new Error('The membership changed or access was denied. Review the refreshed groups and try again.'); }
    saved = true;
    if (remove) state.memberships = state.memberships.filter(member => member.user_id !== userId || member.team_id !== teamId);
    else state.memberships.push(data);
    fillMemberPeople();
    if (await readMemberData(owner, version)) {
      $('#members-status').textContent = remove ? 'Membership removed from Supabase.' : 'Membership saved to Supabase. The member can refresh their workspace to see their access.';
      toast(remove ? 'Group membership removed.' : 'Member added to the group.');
    }
  } catch (error) {
    if (owner === session?.user.id && version === generation) {
      $('#members-error').textContent = `${saved ? 'Your change was saved, but the latest memberships could not be reloaded. ' : ''}${errorMessage(error)}`;
      $('#members-error').hidden = false; $('#members-status').textContent = '';
    }
  } finally { if (owner === session?.user.id && version === generation) { busy = false; render(); } }
}
function populateTaskScope(projectId, preferredRoot, preferredTeam) {
  const roots = rootsForProject(projectId).filter(root => state.teams.some(team => rootId(team.id) === root.id && canManageIn(team.id, projectId)));
  $('#task-team').innerHTML = options(roots.map(team => [team.id, team.name]));
  $('#task-team').value = roots.some(team => team.id === preferredRoot) ? preferredRoot : roots[0]?.id || '';
  const available = state.teams.filter(team => rootId(team.id) === $('#task-team').value && canManageIn(team.id, projectId));
  $('#task-subteam').innerHTML = options(available.map(team => [team.id, team.parent_team_id ? teamPath(team.id).split(' / ').slice(1).join(' / ') : 'Team-wide']));
  $('#task-subteam').value = available.some(team => team.id === preferredTeam) ? preferredTeam : available[0]?.id || '';
  fillTaskAssignees(projectId, $('#task-subteam').value);
  $('#save-task').disabled = busy || !available.length;
}
function taskAIPrompt() {
  const project = state.projects.find(item => item.id === $('#task-project').value)?.name || 'the selected project';
  const group = teamPath($('#task-subteam').value);
  return `Convert the user's work notes below into practical EXO Workbench tasks.
Project: ${project}. Group: ${group}. Today: ${today()}.
Use these task-writing conventions: concise action titles, descriptions beginning with "Deliverable:" and followed by "Evidence:", and "Decision: [topic]" titles for decisions. Preserve only dates, priorities, dependencies, links, and requirements stated in the notes. Interpret "today" as ${today()} and "tomorrow" as the next calendar day. If the notes request one task, return one task; otherwise split independent deliverables into separate tasks. The assignee is selected in EXO Workbench, so do not include an assignee field.
Respond with only one JSON object in this shape, with no Markdown or explanation. If your interface wraps the response in a one-item JSON array, that format is also accepted:
{"tasks":[{"title":"Verify sensor readings on the bench","description":"Deliverable: Compare sensor readings against a known reference.\\nEvidence: Results and discrepancies are documented.","priority":"medium","due_date":null}]}
Each task must contain only title, description, priority, and due_date. Use priority low, medium, high, or urgent. Use null for an unstated due date.
WORK_NOTES_START
WORK_NOTES_END
`;
}
const AI_AGENTS = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' }
};
function selectedAIAgent() { return AI_AGENTS[$('#task-ai-agent').value] || AI_AGENTS.chatgpt; }
function updateAIAgentButton() { $('#copy-task-prompt').textContent = `Copy prompt & open ${selectedAIAgent().name}`; }
function setTaskCreationMode(mode) {
  if (busy || ($('#task-id').value && mode === 'ai')) return;
  const ai = mode === 'ai';
  $('#task-creation-mode').value = ai ? 'ai' : 'single';
  $('#task-ai-panel').hidden = !ai; $('#single-task-fields').hidden = ai;
  for (const field of $('#single-task-fields').querySelectorAll('input,select,textarea')) field.disabled = ai;
  for (const button of document.querySelectorAll('[data-creation-mode]')) button.setAttribute('aria-pressed', String(button.dataset.creationMode === mode));
  $('#save-task').textContent = ai ? 'Create tasks' : 'Save task';
  $('#form-error').hidden = true;
  if (ai) $('#task-ai-prompt').value = taskAIPrompt();
}
function aiTaskError(message) { $('#task-ai-error').textContent = message; $('#task-ai-error').hidden = !message; }
function invalidateAITasks() {
  aiTaskPlan = null; $('#task-ai-preview').replaceChildren(); $('#task-ai-summary').textContent = ''; aiTaskError('');
}
function normalizeAIResponse(text) {
  return text.trim()
    .replace(/&#x20;|&#32;/gi, ' ')
    .replace(/&#x09;|&#9;/gi, '\t')
    .replace(/&#x0a;|&#10;/gi, '\n')
    .replace(/\\[ \t]*(?:\r?\n|$)/g, '');
}
function validateAITasks(text) {
  if (text.length > 250000) throw new Error('The response is too long. Use at most 30 tasks.');
  const source = normalizeAIResponse(text).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
  let parsed; try { parsed = JSON.parse(source); } catch { throw new Error('Paste the JSON response from your agent. Check for missing commas or quotation marks.'); }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error('Use one JSON object or a one-item array containing {"tasks": [...]} with 1–30 tasks.');
    [parsed] = parsed;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.tasks) || !parsed.tasks.length || parsed.tasks.length > 30) throw new Error('Use {"tasks": [...]} or [{"tasks": [...]}] with 1–30 tasks.');
  const seen = new Set();
  return parsed.tasks.map((item, index) => {
    const fail = message => { throw new Error(`Task ${index + 1}: ${message}`); };
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'description,due_date,priority,title') fail('use only title, description, priority and due_date.');
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 160) fail('the title must be 1–160 characters.');
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.trim().length > 10000) fail('instructions must be 1–10000 characters.');
    if (typeof item.priority !== 'string' || !Object.hasOwn(PRIORITY, item.priority)) fail('priority must be low, medium, high or urgent.');
    if (item.due_date !== null && (typeof item.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date) || !Number.isFinite(Date.parse(item.due_date)) || new Date(item.due_date).toISOString().slice(0, 10) !== item.due_date)) fail('use a valid YYYY-MM-DD due date or null.');
    const key = item.title.trim().toLowerCase(); if (seen.has(key)) fail('this title appears twice in the response.'); seen.add(key);
    return { id: crypto.randomUUID(), title: item.title.trim(), description: item.description.trim(), priority: item.priority, date: item.due_date };
  });
}
function checkAIDuplicates(rows, projectId, teamId) {
  const titles = new Set(state.tasks.filter(task => task.project_id === projectId && task.team_id === teamId && !task.archived_at).map(task => task.title.trim().toLowerCase()));
  const duplicate = rows.find(task => titles.has(task.title.toLowerCase()));
  if (duplicate) throw new Error(`“${duplicate.title}” already exists in this group and project. Remove it from the response or give the new task a distinct title.`);
}
function reviewAITasks() {
  if (busy || preview.mode || $('#task-id').value) return;
  invalidateAITasks();
  try {
    const rows = validateAITasks($('#task-ai-response').value);
    checkAIDuplicates(rows, $('#task-project').value, $('#task-subteam').value);
    aiTaskPlan = rows;
    $('#task-ai-preview').innerHTML = rows.map(task => `<li><h3>${escapeHTML(task.title)}</h3><div class="task-detail-meta"><span class="priority ${task.priority}">${escapeHTML(PRIORITY[task.priority])}</span><span class="muted">${escapeHTML(task.date || 'No due date')}</span></div><p>${escapeHTML(task.description)}</p></li>`).join('');
    $('#task-ai-summary').textContent = `${rows.length} task${rows.length === 1 ? '' : 's'} ready for review. All start as To do. Edit the response and review again to make changes.`;
  } catch (error) { aiTaskError(error.message); }
}
async function copyTaskPrompt() {
  const field = $('#task-ai-prompt'); field.value = taskAIPrompt();
  const agent = selectedAIAgent();
  const agentWindow = window.open(agent.url, '_blank', 'noopener,noreferrer');
  try {
    await navigator.clipboard.writeText(field.value);
    toast(agentWindow ? `Prompt copied. Add your work notes in ${agent.name}.` : `Prompt copied. Open ${agent.name} in a new tab.`);
  } catch {
    $('#task-ai-panel details').open = true; field.focus(); field.select();
    toast(agentWindow ? `Select and copy the prompt above, then paste it into ${agent.name}.` : `Select and copy the prompt above, then open ${agent.name}.`);
  }
}
async function saveAITasks() {
  if (busy || preview.mode || !session || $('#task-id').value || !taskEditing) return;
  if (!aiTaskPlan) { aiTaskError('Review the agent response before creating tasks.'); return; }
  const projectId = $('#task-project').value, teamId = $('#task-subteam').value, assignee = $('#task-assignee').value || null;
  if (!canManageIn(teamId, projectId)) { aiTaskError('Choose a project and group you lead.'); return; }
  if (assignee && !userHasGroupAccess(assignee, teamId, projectId)) { aiTaskError('The assignee needs access to this group first.'); return; }
  try { checkAIDuplicates(aiTaskPlan, projectId, teamId); } catch (error) { aiTaskError(error.message); return; }
  const owner = session.user.id, version = generation;
  const rows = aiTaskPlan.map(task => ({ id: task.id, title: task.title, description: task.description, priority: task.priority, status: 'todo', due_at: task.date ? new Date(`${task.date}T23:59:59`).toISOString() : null, project_id: projectId, team_id: teamId, assignee_id: assignee, created_by: owner }));
  busy = true; aiTaskError(''); lockForm(true); render();
  try {
    // One atomic batch. Stable IDs make retrying a lost response safe without updating existing tasks.
    const { error } = await client.from('tasks').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    const { data, error: readError } = await client.from('tasks').select(taskFields()).in('id', rows.map(task => task.id));
    if (readError || data?.length !== rows.length) throw new Error('The batch was saved, but could not be reloaded. Refresh the workspace before trying again.');
    if (owner !== session?.user.id || version !== generation) return;
    const ids = new Set(data.map(task => task.id)); state.tasks = [...state.tasks.filter(task => !ids.has(task.id)), ...data];
    state.project = projectId; state.team = rootId(teamId); state.subteam = teamId === state.team ? 'all' : teamId;
    $('#task-search').value = ''; $('#status-filter').value = 'all'; $('#priority-filter').value = 'all'; $('#archive-filter').value = 'active';
    taskLensChosen = true; $('#task-lens').value = 'team';
    savePreferences(); $('#task-dialog').close(); aiTaskPlan = null; recentKey = ''; audit.loaded = false;
    toast(`${data.length} tasks created.`);
  } catch (error) { if (owner === session?.user.id && version === generation) aiTaskError(errorMessage(error)); }
  finally { busy = false; lockForm(false); render(); }
}
function openTask(id) {
  const task = id ? state.tasks.find(task => task.id === id) : null;
  if (id && (!task || !canWorkIn(task.team_id, task.project_id))) return;
  if ((!task && (!canCreate() || preview.mode)) || busy || !viewIsMember()) return;
  $('#task-form').reset(); $('#form-error').hidden = true;
  aiTaskPlan = null;
  $('#task-ai-response').value = ''; $('#task-ai-preview').replaceChildren();
  $('#task-ai-summary').textContent = ''; $('#task-ai-error').hidden = true;
  $('#task-creation-options').hidden = Boolean(task);
  for (const field of $('#task-form').querySelectorAll('input,select,textarea')) field.disabled = false;
  $('#task-id').value = task?.id || ''; $('#dialog-title').textContent = task ? 'Task details' : 'New task';
  setTaskCreationMode('single');
  $('#task-title').value = task?.title || ''; $('#task-description').value = task?.description || '';
  $('#task-status').value = task?.status || 'todo'; $('#task-priority').value = task?.priority || 'medium';
  $('#task-assignee').innerHTML = options([['', 'Unassigned'], ...state.profiles.map(profile => [profile.id, profile.display_name || 'Workspace member'])]);
  if (task?.assignee_id && !state.profiles.some(profile => profile.id === task.assignee_id)) $('#task-assignee').insertAdjacentHTML('beforeend', options([[task.assignee_id, 'Workspace member']]));
  $('#task-assignee').value = task?.assignee_id || ''; $('#task-due').value = task ? dueDate(task) : '';
  if (task) {
    $('#task-project').innerHTML = options([[task.project_id, state.projects.find(project => project.id === task.project_id)?.name || 'Project']]);
    $('#task-team').innerHTML = options([[rootId(task.team_id), teamById(rootId(task.team_id))?.name || 'Team']]);
    $('#task-subteam').innerHTML = options([[task.team_id, teamPath(task.team_id)]]);
    for (const selector of ['#task-project', '#task-team', '#task-subteam']) $(selector).disabled = true;
    if (!canEdit(task)) for (const field of $('#task-form').querySelectorAll('input,select,textarea')) field.disabled = true;
    $('#dialog-title').textContent = preview.mode ? 'Task details · testing view' : canEdit(task) ? 'Edit task' : 'Task details · read only';
    $('#save-task').disabled = !canEdit(task);
  } else {
    const projects = state.projects.filter(project => state.teams.some(team => canManageIn(team.id, project.id)));
    $('#task-project').innerHTML = options(projects.map(project => [project.id, project.name]));
    $('#task-project').value = projects.some(project => project.id === state.project) ? state.project : projects[0]?.id || '';
    populateTaskScope($('#task-project').value, state.team, state.subteam);
  }
  $('#delete-task').hidden = !task || !canEdit(task);
  if (task) fillTaskAssignees(task.project_id, task.team_id, task.assignee_id);
  taskEditing = !task;
  $('#task-detail-view').hidden = !task;
  $('#task-edit-fields').hidden = Boolean(task);
  $('#edit-task').hidden = !task || !canEdit(task);
  $('#save-task').hidden = Boolean(task); $('#delete-task').hidden = true;
  $('#cancel-dialog').textContent = task ? 'Close' : 'Cancel';
  $('#task-progress-control').hidden = !task || !canProgress(task);
  $('#task-progress-status').disabled = !task || !canProgress(task);
  $('#task-progress-status').value = task?.status || 'todo';
  $('#task-history-section').open = false;
  if (task) {
    $('#dialog-title').textContent = preview.mode ? 'Task details · preview' : 'Task details';
    $('#task-detail-title').textContent = task.title;
    $('#task-detail-meta').innerHTML = `<span class="badge ${STATUS_CLASS[task.status]}">${STATUS[task.status]}</span><span class="priority ${task.priority}">${escapeHTML(PRIORITY[task.priority])}</span>`;
    setLinkedText($('#task-instructions'), task.description || 'No instructions added yet.');
    $('#task-detail-facts').innerHTML = [['Assignee', task.assignee_id ? userName(task.assignee_id) : 'Unassigned group work'], ['Due date', formatDate(task.due_at)], ['Group', teamPath(task.team_id)], ['Project', state.projects.find(project => project.id === task.project_id)?.name || 'Project']].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
    loadTaskReferences(task);
    loadTaskHistory(task, true);
    $('#delete-task').hidden = Boolean(preview.mode) || !canManageIn(task.team_id, task.project_id);
    $('#delete-task').textContent = task.archived_at ? 'Restore task' : 'Archive task';
    $('#delete-task').disabled = !activityReady;
    $('#delete-task').title = activityReady ? '' : 'The activity database update is needed first.';
    if (task.archived_at) $('#task-detail-meta').insertAdjacentHTML('beforeend', '<span class="badge cancelled">Archived</span>');
  }
  showDialog($('#task-dialog'));
  if (task) { $('#task-detail-title').tabIndex = -1; $('#task-detail-title').focus(); }
  else $('#task-title').focus();
}
async function loadTaskReferences(task) {
  const owner = session?.user.id, version = generation;
  $('#task-references').textContent = 'Loading references…';
  try {
    const { data, error } = await client.from('task_links').select('id,label,url').eq('task_id', task.id).order('created_at').range(0, 499);
    if (owner !== session?.user.id || version !== generation || $('#task-id').value !== task.id || !$('#task-dialog').open) return;
    if (error) throw error;
    const links = (data || []).filter(link => { try { return ['https:', 'http:'].includes(new URL(link.url).protocol); } catch { return false; } });
    $('#task-references').innerHTML = links.length ? links.map(link => `<li><a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.label || new URL(link.url).hostname)} ↗</a></li>`).join('') : '<li class="muted">No references attached.</li>';
  } catch { if (owner === session?.user.id && version === generation && $('#task-id').value === task.id) $('#task-references').textContent = 'References could not be loaded. Close and reopen this task to retry.'; }
}
async function loadTaskHistory(task, reset = true) {
  if (!activityReady) { $('#task-history').innerHTML = '<li class="activity-empty">History will be available after the workspace update.</li>'; $('#task-history-more').hidden = true; return; }
  if (!reset && taskHistory.loading) return;
  const owner = session?.user.id, version = generation, request = ++taskHistoryRequest;
  if (reset) { taskHistory.taskId = task.id; taskHistory.rows = []; }
  taskHistory.loading = true; $('#task-history-more').disabled = true;
  if (!taskHistory.rows.length) $('#task-history').innerHTML = '<li class="activity-empty">Loading history…</li>';
  try {
    const { data, error } = await activityPage(client.from('task_activity').select(ACTIVITY_FIELDS).eq('task_id', task.id), reset ? null : taskHistory.rows.at(-1), 20);
    if (request !== taskHistoryRequest || owner !== session?.user.id || version !== generation || $('#task-id').value !== task.id || !$('#task-dialog').open) return;
    if (error) throw error;
    taskHistory.rows.push(...(data || []).slice(0, 20)); taskHistory.more = (data || []).length > 20;
    $('#task-history').innerHTML = taskHistory.rows.length ? taskHistory.rows.map(event => activityHTML(event, true)).join('') : '<li class="activity-empty">No activity recorded yet.</li>';
    $('#task-history-more').hidden = !taskHistory.more;
  } catch { if (request === taskHistoryRequest && owner === session?.user.id && version === generation && $('#task-id').value === task.id) $('#task-history').innerHTML = '<li class="activity-empty">Could not load history. Close and reopen this task to retry.</li>'; }
  finally { if (request === taskHistoryRequest) { taskHistory.loading = false; $('#task-history-more').disabled = false; } }
}
function editOpenTask() {
  const task = state.tasks.find(task => task.id === $('#task-id').value);
  if (!task || !canEdit(task) || busy || preview.mode) return;
  taskEditing = true; $('#task-detail-view').hidden = true; $('#task-edit-fields').hidden = false;
  $('#edit-task').hidden = true; $('#save-task').hidden = false; $('#delete-task').hidden = false;
  $('#cancel-dialog').textContent = 'Cancel'; $('#dialog-title').textContent = 'Edit task'; $('#task-title').focus();
  $('#delete-task').hidden = true;
  dialogBaselines.set($('#task-dialog'), dialogFormState($('#task-dialog')));
}
function lockForm(locked) {
  for (const button of $('#task-form').querySelectorAll('button')) button.disabled = locked;
  // A fieldset-equivalent lock also stops changing values while a request is pending.
  for (const field of $('#task-form').querySelectorAll('input,select,textarea')) {
    if (locked) { field.dataset.wasDisabled = String(field.disabled); field.disabled = true; }
    else { field.disabled = field.dataset.wasDisabled === 'true'; delete field.dataset.wasDisabled; }
  }
  $('#save-task').textContent = locked ? 'Saving…' : $('#task-creation-mode').value === 'ai' ? 'Create tasks' : 'Save task';
}
function formError(error) { $('#form-error').textContent = errorMessage(error); $('#form-error').hidden = false; }
async function saveTask(event) {
  event.preventDefault(); if (preview.mode || busy || !session || !taskEditing) return;
  if (!$('#task-id').value && $('#task-creation-mode').value === 'ai') { await saveAITasks(); return; }
  const id = $('#task-id').value, existing = state.tasks.find(task => task.id === id);
  const title = $('#task-title').value.trim();
  if (!title) { $('#task-title').setCustomValidity('Give your task a name.'); $('#task-title').reportValidity(); return; }
  if (existing && !canEdit(existing)) return;
  const date = $('#task-due').value;
  const values = { title, description: $('#task-description').value.trim(), status: $('#task-status').value, priority: $('#task-priority').value, assignee_id: $('#task-assignee').value || null,
    due_at: !date ? null : existing && dueDate(existing) === date ? existing.due_at : new Date(`${date}T23:59:59`).toISOString() };
  const teamId = $('#task-subteam').value, projectId = $('#task-project').value;
  if (!existing && !canManageIn(teamId, projectId)) { formError(new Error('Choose a project and group you lead.')); return; }
  const owner = session.user.id, version = generation;
  busy = true; lockForm(true); render();
  try {
    const query = existing ? activityReady ? client.rpc('manage_task', { p_task: id, p_expected: existing.updated_at, p_values: values }) : client.from('tasks').update(values).eq('id', id).eq('updated_at', existing.updated_at) : client.from('tasks').insert({ ...values, project_id: projectId, team_id: teamId, created_by: owner });
    const { data, error } = await query.select(taskFields()).maybeSingle();
    if (error) throw error; if (!data) throw new Error('This task changed or you no longer have permission. Close this dialog, refresh, and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = existing ? state.tasks.map(task => task.id === id ? data : task) : [...state.tasks, data];
    state.project = data.project_id; state.team = rootId(data.team_id); state.subteam = data.team_id === state.team ? 'all' : data.team_id;
    $('#task-search').value = ''; $('#status-filter').value = 'all'; $('#priority-filter').value = 'all';
    savePreferences(); $('#task-dialog').close(); recentKey = ''; audit.loaded = false; toast(existing ? 'Task saved.' : 'Task created.');
  } catch (error) { if (owner === session?.user.id && version === generation) formError(error); }
  finally { busy = false; lockForm(false); render(); }
}
async function toggleTask(event) {
  if (!event.target.matches('[data-complete]')) return;
  const task = state.tasks.find(task => task.id === event.target.dataset.complete);
  if (!task || !canProgress(task)) { render(); return; }
  await updateTaskProgress(task, event.target.checked ? 'done' : 'todo');
}
async function updateTaskProgress(task, status) {
  if (!canProgress(task) || !['todo', 'in_progress', 'blocked', 'review', 'done'].includes(status)) return;
  const owner = session.user.id, version = generation;
  busy = true; render();
  try {
    const { data, error } = await client.from('tasks').update({ status }).eq('id', task.id).eq('updated_at', task.updated_at).select(taskFields()).maybeSingle();
    if (error) throw error; if (!data) throw new Error('Task changed or access was removed. Refresh and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = state.tasks.map(task => task.id === data.id ? data : task); recentKey = ''; audit.loaded = false;
    if ($('#task-dialog').open && $('#task-id').value === task.id) {
      $('#task-status').value = data.status; $('#task-progress-status').value = data.status;
      $('#task-detail-meta .badge').className = `badge ${STATUS_CLASS[data.status]}`; $('#task-detail-meta .badge').textContent = STATUS[data.status];
      dialogBaselines.set($('#task-dialog'), dialogFormState($('#task-dialog'))); loadTaskHistory(data, true);
    }
    toast(status === 'done' ? 'Task completed.' : 'Progress updated.');
  } catch (error) { if (owner === session?.user.id) toast(errorMessage(error)); }
  finally { busy = false; if ($('#task-dialog').open && $('#task-id').value === task.id) $('#task-progress-status').value = state.tasks.find(item => item.id === task.id)?.status || task.status; render(); }
}
async function deleteTask() {
  if (preview.mode) return;
  const task = state.tasks.find(task => task.id === $('#task-id').value);
  if (!task || busy || !activityReady || !canManageIn(task.team_id, task.project_id) || !confirm(task.archived_at ? 'Restore this task to the active workspace?' : 'Archive this task? Its instructions and history will be kept.')) return;
  const owner = session.user.id, version = generation; busy = true; lockForm(true); render();
  try {
    const { data, error } = await client.rpc('manage_task', { p_task: task.id, p_expected: task.updated_at, p_values: { archived: !task.archived_at } }).select(TASK_FIELDS).maybeSingle();
    if (error) throw error; if (!data) throw new Error('Task changed or access was removed. Refresh and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = state.tasks.map(item => item.id === task.id ? data : item); recentKey = ''; audit.loaded = false;
    $('#task-dialog').close(); toast(task.archived_at ? 'Task restored.' : 'Task archived. History preserved.');
  } catch (error) { if (owner === session?.user.id) formError(error); }
  finally { busy = false; lockForm(false); render(); }
}
async function authenticate() {
  if (!client || busy) return;
  signinError = ''; pendingAuthError = '';
  busy = true; render();
  try {
    if (session) {
      const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error;
      session = null; clearData(); busy = false; await loadWorkspace();
    } else {
      const { error } = await client.auth.signInWithOAuth({ provider: EXO_CONFIG.authProvider, options: { redirectTo: EXO_CONFIG.authRedirectUrl, queryParams: { prompt: 'select_account' } } });
      if (error) throw error;
    }
  } catch (error) { signinError = errorMessage(error); toast(signinError); }
  finally { busy = false; render(); }
}
async function initialize() {
  try {
    const callback = new URLSearchParams(location.hash.slice(1));
    if (callback.has('error_description')) { pendingAuthError = callback.get('error_description'); history.replaceState(null, '', location.pathname + location.search + '#overview'); }
    if (typeof EXO_CONFIG === 'undefined' || !EXO_CONFIG.supabaseUrl || !EXO_CONFIG.supabaseAnonKey) throw new Error('Supabase configuration is missing. Check config.js.');
    if (!window.supabase?.createClient) throw new Error('The Supabase library did not load. Check your connection and reload this page.');
    if (!['http:', 'https:'].includes(location.protocol)) throw new Error('Open the app through its localhost preview. Google sign-in cannot run from a file URL.');
    client = window.supabase.createClient(EXO_CONFIG.supabaseUrl, EXO_CONFIG.supabaseAnonKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    // Do not await database requests inside the auth callback (it holds an auth lock).
    client.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION') return;
      const changedUser = session?.user.id !== nextSession?.user.id;
      session = nextSession;
      if (changedUser || event === 'SIGNED_OUT') {
        resetPreview();
        if ($('#import-dialog').open) $('#import-dialog').close(); importPlan = null;
        signinDismissed = false; signinError = '';
        ++generation; busy = false; clearData(); phase = nextSession ? 'loading' : 'signed-out';
        setBanner(nextSession ? 'Loading shared workspace' : 'Sign in to your workspace', nextSession ? 'Reading shared data…' : 'Use Google sign-in to load your shared tasks.');
        render(); setTimeout(() => loadWorkspace(), 0);
      } else render();
    });
    const { data, error } = await client.auth.getSession(); if (error) throw error;
    session = data.session; authReady = true; await loadWorkspace();
  } catch (error) { phase = 'error'; authReady = Boolean(client); setBanner('Connection setup needed', errorMessage(error), 'error'); render(); }
}
$('#task-status').innerHTML = options(Object.entries(STATUS));
$('#status-filter').innerHTML = options([['all', 'All statuses'], ...Object.entries(STATUS)]);
$('#task-priority').innerHTML = options(Object.entries(PRIORITY));
$('#priority-filter').innerHTML = options([['all', 'All priorities'], ...Object.entries(PRIORITY)]);
$('#task-progress-status').innerHTML = options(Object.entries(STATUS).filter(([value]) => value !== 'cancelled'));
$('#task-progress-status').addEventListener('change', () => { const task = state.tasks.find(task => task.id === $('#task-id').value); if (task) updateTaskProgress(task, $('#task-progress-status').value); });
$('#task-history-more').addEventListener('click', () => { const task = state.tasks.find(task => task.id === taskHistory.taskId); if (task) loadTaskHistory(task, false); });
$('#refresh-updates').addEventListener('click', refreshRecentActivity);
$('#toggle-updates').addEventListener('click', () => { recentExpanded = !recentExpanded; renderRecentUpdates(); });
for (const id of ['#history-type', '#history-project']) $(id).addEventListener('change', () => loadAdminHistory(true));
$('#refresh-history').addEventListener('click', () => loadAdminHistory(true));
$('#history-more').addEventListener('click', () => loadAdminHistory(false));
$('#archive-filter').addEventListener('change', () => render());
$('#project-select').addEventListener('change', event => { state.project = event.target.value; state.team = 'all'; state.subteam = 'all'; savePreferences(); render(); });
$('#team-select').addEventListener('change', event => { state.team = event.target.value; state.subteam = 'all'; savePreferences(); render(); });
$('#subteam-select').addEventListener('change', event => { state.subteam = event.target.value; savePreferences(); render(); });
$('#view-as').addEventListener('click', startPreview);
$('#exit-preview').addEventListener('click', () => { if (!busy) { resetPreview(); render(); $('#view-as').focus(); } });
$('#preview-mode').addEventListener('change', event => {
  if (busy || !preview.mode || !isAdmin()) return;
  if (event.target.value === 'group' && !state.teams.length) { event.target.value = preview.mode; toast('Create a team before using the group preview.'); return; }
  preview.mode = event.target.value;
  preview.subject = preview.mode === 'member' ? state.profiles.find(profile => profile.id !== session.user.id)?.id || session.user.id : state.teams[0]?.id || '';
  applyPreviewSubject(); render();
});
$('#preview-subject').addEventListener('change', event => {
  if (busy || !preview.mode || !isAdmin()) return;
  const valid = preview.mode === 'member' ? state.profiles.some(profile => profile.id === event.target.value) : Boolean(teamById(event.target.value));
  if (!valid) return; preview.subject = event.target.value; applyPreviewSubject(); render();
});
$('#task-lens').addEventListener('change', () => { taskLensChosen = true; if (preview.mode === 'group' && $('#task-lens').value === 'assigned') $('#task-lens').value = 'team'; render(); });
for (const button of document.querySelectorAll('[data-task-scope]')) button.addEventListener('click', () => { if (!viewIsMember() || button.disabled) return; taskLensChosen = true; $('#task-lens').value = button.dataset.taskScope; render(); });
$('#empty-group-tasks').addEventListener('click', () => { taskLensChosen = true; $('#task-lens').value = 'team'; render(); });
$('#show-closed').addEventListener('click', () => { showClosedTasks = $('#show-closed').getAttribute('aria-expanded') !== 'true'; if (!showClosedTasks && ['done', 'cancelled'].includes($('#status-filter').value)) $('#status-filter').value = 'all'; renderTasks(scopedTasks()); });
for (const button of document.querySelectorAll('[data-task-layout]')) button.addEventListener('click', () => {
  if (!viewIsMember()) return;
  if (preview.mode) previewLayoutChoice = button.dataset.taskLayout;
  else { taskLayoutChoice = button.dataset.taskLayout; try { localStorage.setItem(`exo-task-layout:${session.user.id}`, taskLayoutChoice); } catch { /* Keep the session choice. */ } }
  renderTasks(scopedTasks());
});
$('#edit-task').addEventListener('click', editOpenTask);
for (const element of document.querySelectorAll('[data-tab]')) element.addEventListener('click', event => { event.preventDefault(); switchTab(element.dataset.tab); });
$('.tabs').addEventListener('keydown', event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = [...$('.tabs').querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden), index = Math.max(0, tabs.findIndex(tab => tab.dataset.tab === activeTab)); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; switchTab(tabs[next].dataset.tab); tabs[next].focus(); } });
window.addEventListener('hashchange', () => { if (TABS.includes(location.hash.slice(1)) || !location.hash) { activeTab = location.hash.slice(1) || 'overview'; render(); if (activeTab === 'administration' && !audit.loaded) loadAdminHistory(); } });
for (const selector of ['#new-task', '#add-task-row']) $(selector).addEventListener('click', () => openTask());
$('#see-tasks').addEventListener('click', () => switchTab('tasks'));
for (const selector of ['#close-dialog', '#cancel-dialog']) $(selector).addEventListener('click', () => requestDialogClose($('#task-dialog')));
$('#task-title').addEventListener('input', () => $('#task-title').setCustomValidity(''));
$('#task-dialog').addEventListener('close', () => $('#task-title').setCustomValidity(''));
for (const button of document.querySelectorAll('[data-creation-mode]')) button.addEventListener('click', () => setTaskCreationMode(button.dataset.creationMode));
$('#task-ai-agent').addEventListener('change', updateAIAgentButton);
updateAIAgentButton();
$('#copy-task-prompt').addEventListener('click', copyTaskPrompt);
$('#review-ai-tasks').addEventListener('click', reviewAITasks);
$('#task-ai-response').addEventListener('input', invalidateAITasks);
$('#task-project').addEventListener('change', () => populateTaskScope($('#task-project').value));
$('#task-team').addEventListener('change', () => populateTaskScope($('#task-project').value, $('#task-team').value));
$('#task-subteam').addEventListener('change', () => fillTaskAssignees($('#task-project').value, $('#task-subteam').value));
for (const selector of ['#task-project', '#task-team', '#task-subteam']) $(selector).addEventListener('change', () => { if ($('#task-creation-mode').value === 'ai') { $('#task-ai-prompt').value = taskAIPrompt(); invalidateAITasks(); } });
for (const selector of ['#task-search', '#status-filter', '#priority-filter']) $(selector).addEventListener(selector === '#task-search' ? 'input' : 'change', () => renderTasks(scopedTasks()));
document.addEventListener('click', event => { const button = event.target.closest('[data-edit]'); if (button) openTask(button.dataset.edit); });
document.addEventListener('change', toggleTask);
$('#task-form').addEventListener('submit', saveTask);
for (const [selector, mode] of [['#new-project', 'project'], ['#new-team', 'team'], ['#new-subteam', 'subteam']]) $(selector).addEventListener('click', () => openSetup(mode));
$('#setup-form').addEventListener('submit', saveSetup);
$('#setup-name').addEventListener('input', () => $('#setup-name').setCustomValidity(''));
$('#setup-dialog').addEventListener('close', () => $('#setup-name').setCustomValidity(''));
for (const selector of ['#close-setup', '#cancel-setup']) $(selector).addEventListener('click', () => requestDialogClose($('#setup-dialog')));
$('#manage-members').addEventListener('click', openMembers);
$('#refresh-members').addEventListener('click', refreshMembers);
$('#member-select').addEventListener('change', () => { if (!busy) { $('#members-error').hidden = true; $('#members-status').textContent = ''; renderMemberGroups(); } });
$('#members-form').addEventListener('submit', event => { event.preventDefault(); changeMembership($('#member-team').value); });
$('#member-groups').addEventListener('click', event => { const button = event.target.closest('[data-remove-membership]'); if (button) changeMembership(button.dataset.removeMembership, true); });
for (const selector of ['#close-members', '#done-members']) $(selector).addEventListener('click', () => requestDialogClose($('#members-dialog')));
$('#import-github').addEventListener('click', openImport);
$('#import-form').addEventListener('submit', submitImport);
for (const selector of ['#import-project', '#import-closed']) $(selector).addEventListener('change', resetImportPlan);
for (const selector of ['#close-import', '#cancel-import']) $(selector).addEventListener('click', () => requestDialogClose($('#import-dialog')));
$('#delete-task').addEventListener('click', deleteTask);
$('#auth-button').addEventListener('click', () => {
  if (session) authenticate();
  else { signinDismissed = false; render(); if (!$('#signin-dialog').open) showDialog($('#signin-dialog')); }
});
$('#google-signin').addEventListener('click', authenticate);
$('#close-signin').addEventListener('click', () => requestDialogClose($('#signin-dialog')));
$('#signin-reload').addEventListener('click', () => location.reload());
// Dialog backdrops retarget pointer events to the dialog element. Require both
// ends of the gesture outside its bounds so dragging from a field cannot close it.
for (const dialog of document.querySelectorAll('dialog')) {
  let startedOutside = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('click', event => {
    const dismiss = startedOutside && outside(event); startedOutside = false;
    if (dismiss) requestDialogClose(dialog);
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestDialogClose(dialog); });
  dialog.addEventListener('close', () => { startedOutside = false; dialogBaselines.delete(dialog); });
}
$('#refresh-data').addEventListener('click', () => loadWorkspace());
$('#sidebar-toggle').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
try { setSidebarCollapsed(localStorage.getItem('exo-sidebar-collapsed') === 'true'); } catch { setSidebarCollapsed(false); }
document.addEventListener('click', event => {
  const button = event.target.closest('.help-button');
  for (const help of document.querySelectorAll('.help.is-open')) if (help !== button?.closest('.help')) { help.classList.remove('is-open'); help.querySelector('button').setAttribute('aria-expanded', 'false'); }
  if (button) { button.closest('.help').classList.remove('is-dismissed'); const open = button.closest('.help').classList.toggle('is-open'); button.setAttribute('aria-expanded', String(open)); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') for (const help of document.querySelectorAll('.help')) { help.classList.remove('is-open'); help.classList.add('is-dismissed'); help.querySelector('button').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('focusout', event => { const help = event.target.closest('.help'); if (help && !help.contains(event.relatedTarget)) help.classList.remove('is-dismissed', 'is-open'); });
document.addEventListener('pointerover', event => event.target.closest('.help')?.classList.remove('is-dismissed'));
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.legal-menu[open]')) {
    if (!menu.contains(event.target) || event.target.closest('a')) menu.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const menu of document.querySelectorAll('.legal-menu[open]')) {
    const restoreFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (restoreFocus) menu.querySelector('summary').focus();
  }
});
window.addEventListener('focus', refreshGroupAccess);
document.addEventListener('visibilitychange', refreshGroupAccess);
setInterval(refreshGroupAccess, 30000);
render(); initialize();
