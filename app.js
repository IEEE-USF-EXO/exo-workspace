// Shared data lives in Supabase. Only view preferences are stored locally.
// The previous exo-workbench-v1 demo data is left untouched and never uploaded.
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done', cancelled: 'Cancelled' };
const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const STATUS_CLASS = { todo: 'todo', in_progress: 'progress', blocked: 'blocked', review: 'review', done: 'done', cancelled: 'cancelled' };
const TASK_FIELDS = 'id,project_id,team_id,milestone_id,title,description,status,priority,assignee_id,due_at,completed_at,created_by,created_at,updated_at';
const state = { tasks: [], teams: [], projects: [], projectTeams: [], profiles: [], memberships: [], leadership: [], project: '', team: 'all', subteam: 'all' };
let client, session = null, phase = 'connecting', busy = false, generation = 0, authReady = false, activeTab = location.hash === '#tasks' ? 'tasks' : 'overview';
let pendingAuthError = '';
let signinDismissed = false, signinError = '';
let setupMode = 'project';
const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = () => dateValue(new Date());
const dueDate = task => task.due_at ? dateValue(new Date(task.due_at)) : '';
const isClosed = task => ['done', 'cancelled'].includes(task.status);
const overdue = task => !isClosed(task) && task.due_at && dueDate(task) < today();
const teamById = id => state.teams.find(team => team.id === id);
const userName = id => state.profiles.find(profile => profile.id === id)?.display_name || (id ? 'Workspace member' : 'Unassigned');
const options = entries => entries.map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join('');
function preferenceKey() { return `exo-scope-v2:${session?.user.id || 'visitor'}`; }
function savePreferences() { try { localStorage.setItem(preferenceKey(), JSON.stringify({ project: state.project, team: state.team, subteam: state.subteam })); } catch { /* Shared records are never stored here. */ } }
function readPreferences() { try { return JSON.parse(localStorage.getItem(preferenceKey()) || '{}') || {}; } catch { return {}; } }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
function setBanner(title, description, type = '') { $('#connection-title').textContent = title; $('#connection-description').textContent = description; $('#connection-banner').className = `connection-banner ${type}`; }
function errorMessage(error) {
  const context = error?.table ? `Could not load public.${error.table} (${error.code || 'request failed'}). ` : '';
  if (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error?.code)) return `${context}${error.message || 'A required table or column is unavailable.'} Compare the database with schema.sql, then refresh.`;
  if (error?.code === '42501') return `${context}Supabase denied access. Check your membership, leadership assignment, and database policies.`;
  if (error?.code === '23503') return 'A linked project, team, assignee, or milestone changed. Refresh the workspace and try again.';
  if (/fetch|network|load failed/i.test(error?.message || '')) return 'Could not reach Supabase. Check your connection and try Refresh.';
  return error?.message || 'The request could not be completed. Please try again.';
}
// Follow ancestors using IDs, including arbitrarily nested teams without name collisions.
function ancestors(id) { const result = [], seen = new Set(); while (id && !seen.has(id)) { result.push(id); seen.add(id); id = teamById(id)?.parent_team_id; } return result; }
function rootId(id) { return ancestors(id).at(-1) || id; }
function teamPath(id) { return ancestors(id).reverse().map(id => teamById(id)?.name || 'Unknown team').join(' / '); }
function descendantOf(id, parent) { return ancestors(id).includes(parent); }
function linkedTeams(projectId) { const ids = new Set(state.projectTeams.filter(link => link.project_id === projectId).map(link => link.team_id)); return state.teams.filter(team => ids.has(team.id)); }
function rootsForProject(projectId, writable = false) {
  const ids = new Set(linkedTeams(projectId).filter(team => !writable || canWorkIn(team.id, projectId)).map(team => rootId(team.id)));
  return state.teams.filter(team => ids.has(team.id));
}
function isAdmin() { return state.leadership.some(role => role.user_id === session?.user.id && role.role === 'exo_chair' && !role.revoked_at && !role.team_id && !role.project_id); }
function canWorkIn(teamId, projectId) {
  if (!session || phase !== 'ready') return false;
  const parents = ancestors(teamId);
  return isAdmin() || state.memberships.some(member => member.user_id === session.user.id && parents.includes(member.team_id)) || state.leadership.some(role => role.user_id === session.user.id && !role.revoked_at && ((role.role === 'project_lead' && role.project_id === projectId && parents.includes(role.team_id)) || (role.role === 'team_lead' && parents.includes(role.team_id) && !role.project_id)));
}
function canCreate() { return phase === 'ready' && state.projects.some(project => linkedTeams(project.id).some(team => canWorkIn(team.id, project.id))); }
function creationBlockReason() {
  if (phase !== 'ready' || canCreate()) return '';
  const prefix = isAdmin() ? 'Your EXO chair role is active. ' : '';
  if (!state.projects.length) return `${prefix}${isAdmin() ? 'Use New project below to create your first project.' : 'Ask your EXO chair to create a project before adding tasks.'}`;
  if (!state.teams.length) return `${prefix}${isAdmin() ? 'Use New team, then Link team to project to enable task creation.' : 'Ask your EXO chair to create and link a team to this project.'}`;
  if (!state.projects.some(project => linkedTeams(project.id).length)) return `${prefix}${isAdmin() ? 'Use Link team to project below to enable New task.' : 'Ask your EXO chair to link a team to a project.'}`;
  return 'Your account can view tasks, but needs team membership or a matching leadership assignment to create them.';
}
function canEdit(task) { return !busy && canWorkIn(task.team_id, task.project_id); }
function scopedTasks() { return state.tasks.filter(task => task.project_id === state.project && (state.team === 'all' || descendantOf(task.team_id, state.team)) && (state.subteam === 'all' || descendantOf(task.team_id, state.subteam))); }
function clearData() { for (const key of ['tasks', 'teams', 'projects', 'projectTeams', 'profiles', 'memberships', 'leadership']) state[key] = []; state.project = ''; state.team = 'all'; state.subteam = 'all'; for (const selector of ['#task-dialog', '#setup-dialog']) if ($(selector).open) $(selector).close(); }
function normalizeScope() {
  if (!state.projects.some(project => project.id === state.project)) state.project = state.projects[0]?.id || '';
  if (state.team !== 'all' && !rootsForProject(state.project).some(team => team.id === state.team)) state.team = 'all';
  if (state.team === 'all' || (state.subteam !== 'all' && !state.teams.some(team => team.id === state.subteam && team.id !== state.team && descendantOf(team.id, state.team)))) state.subteam = 'all';
}
function fillScope() {
  normalizeScope();
  $('#project-select').innerHTML = state.projects.length ? options(state.projects.map(project => [project.id, project.name])) : '<option value="">No projects loaded</option>';
  $('#project-select').value = state.project;
  $('#team-select').innerHTML = options([['all', 'All teams'], ...rootsForProject(state.project).map(team => [team.id, team.name])]);
  $('#team-select').value = state.team;
  const children = state.teams.filter(team => team.id !== state.team && descendantOf(team.id, state.team));
  $('#subteam-select').innerHTML = options([['all', 'All subteams'], ...children.map(team => [team.id, teamPath(team.id).split(' / ').slice(1).join(' / ')])]);
  $('#subteam-select').value = state.subteam;
  $('#project-select').disabled = phase !== 'ready' || busy || !state.projects.length;
  $('#team-select').disabled = phase !== 'ready' || busy || !rootsForProject(state.project).length;
  $('#subteam-select').disabled = phase !== 'ready' || busy || state.team === 'all' || !children.length;
}
function formatDate(value) {
  if (!value) return 'No due date';
  const date = new Date(value), day = dateValue(date), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === today()) return 'Today'; if (day === dateValue(tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function checkbox(task) { return `<input class="complete-check" type="checkbox" data-complete="${escapeHTML(task.id)}" ${task.status === 'done' ? 'checked' : ''} ${canEdit(task) && task.status !== 'cancelled' ? '' : 'disabled'} aria-label="Mark ${escapeHTML(task.title)} ${task.status === 'done' ? 'incomplete' : 'complete'}">`; }
function titleButton(task) { return `<button class="task-title-button" data-edit="${escapeHTML(task.id)}">${escapeHTML(task.title)}</button>`; }
function renderOverview(tasks) {
  const done = tasks.filter(task => task.status === 'done').length, inProgress = tasks.filter(task => task.status === 'in_progress').length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const available = phase === 'ready';
  const stats = [['Total tasks', tasks.length, 'Across this workspace view', '<span class="nav-icon nav-icon-tasks" aria-hidden="true"></span>'], ['In progress', inProgress, 'Work currently underway', '◷'], ['Completed', done, 'Tasks marked as done', '✓'], ['Overdue', tasks.filter(overdue).length, 'Tasks past their due date', '⚑']];
  $('#stats').innerHTML = stats.map(([label, count, note, icon]) => `<div class="stat"><div class="stat-top">${label}<span class="stat-icon">${icon}</span></div><strong>${available ? count : '—'}</strong><small>${available ? note : 'Waiting for workspace data'}</small></div>`).join('');
  const upcoming = tasks.filter(task => !isClosed(task)).sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999')).slice(0, 4);
  $('#up-next').innerHTML = available && upcoming.length ? upcoming.map(task => `<div class="upcoming-task">${checkbox(task)}<div class="upcoming-detail">${titleButton(task)}<small>${escapeHTML(teamPath(task.team_id))} · ${escapeHTML(userName(task.assignee_id))}</small></div><span class="due ${overdue(task) ? 'overdue' : ''}">${formatDate(task.due_at)}</span></div>`).join('') : `<div class="up-next-empty">${available ? 'No upcoming tasks in this view.' : 'Your shared tasks will appear once the workspace is available.'}</div>`;
  $('#progress-percent').innerHTML = `${available ? percent : '—'}<span>%</span>`;
  $('#progress-bar').style.width = `${available ? percent : 0}%`;
  $('#status-breakdown').innerHTML = Object.entries(STATUS).map(([value, label]) => `<div class="breakdown-row"><span class="legend-dot ${STATUS_CLASS[value]}"></span>${label}<strong>${available ? tasks.filter(task => task.status === value).length : '—'}</strong></div>`).join('');
  $('#progress-footer').textContent = available ? `${done} of ${tasks.length} tasks complete in this view.` : 'Sign in to see your team’s progress.';
}
function renderTasks(tasks) {
  const query = $('#task-search').value.toLowerCase().trim();
  const filtered = tasks.filter(task => `${task.title} ${task.description} ${userName(task.assignee_id)} ${teamPath(task.team_id)}`.toLowerCase().includes(query) && ($('#status-filter').value === 'all' || task.status === $('#status-filter').value) && ($('#priority-filter').value === 'all' || task.priority === $('#priority-filter').value));
  $('#list-count').textContent = phase === 'ready' ? filtered.length : '—';
  $('#task-rows').innerHTML = filtered.map(task => {
    const name = userName(task.assignee_id);
    return `<tr class="${task.status === 'done' ? 'is-done' : ''}"><td class="check-cell">${checkbox(task)}</td><td>${titleButton(task)}</td><td><span class="badge ${STATUS_CLASS[task.status] || 'todo'}">${escapeHTML(STATUS[task.status] || task.status)}</span></td><td><span class="priority ${Object.hasOwn(PRIORITY, task.priority) ? task.priority : 'medium'}">${escapeHTML(PRIORITY[task.priority] || task.priority)}</span></td><td><div class="assignee"><span class="avatar">${escapeHTML(task.assignee_id ? name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() : '–')}</span>${escapeHTML(name)}</div></td><td class="due ${overdue(task) ? 'overdue' : ''}">${formatDate(task.due_at)}</td><td>${escapeHTML(teamPath(task.team_id))}</td></tr>`;
  }).join('');
  $('#task-empty').hidden = filtered.length > 0;
  $('#task-empty h3').textContent = phase === 'ready' ? 'No tasks in this view' : 'Workspace unavailable';
  $('#empty-description').textContent = phase !== 'ready' ? 'See the connection message above for the next step.' : tasks.length ? 'Try another search or adjust your filters.' : 'Choose another scope or create the first task.';
}
function render() {
  fillScope();
  const project = state.projects.find(project => project.id === state.project), team = teamById(state.team), subteam = teamById(state.subteam), tasks = scopedTasks();
  $('#breadcrumb-team').textContent = project?.name || 'EXO Workbench';
  $('#scope-heading').textContent = `${team?.name || 'All teams'} / ${subteam?.name || 'All subteams'}`;
  $('#overview-scope').textContent = subteam?.name || team?.name || 'Across all teams';
  $('#nav-count').textContent = phase === 'ready' ? tasks.filter(task => !isClosed(task)).length : '—';
  $('#tab-count').textContent = phase === 'ready' ? tasks.length : '—';
  $('#page-title').textContent = activeTab === 'overview' ? 'Overview' : 'Tasks';
  $('#page-description').textContent = activeTab === 'overview' ? 'An overview of your team’s priorities and progress.' : 'Manage tasks and track work across your team.';
  for (const element of document.querySelectorAll('[data-tab]')) {
    const active = element.dataset.tab === activeTab; element.classList.toggle('active', active);
    if (element.getAttribute('role') === 'tab') { element.setAttribute('aria-selected', String(active)); element.tabIndex = active ? 0 : -1; }
    else if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  }
  $('#overview-view').hidden = activeTab !== 'overview'; $('#tasks-view').hidden = activeTab !== 'tasks';
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
  else if (!session && !signinDismissed && ['signed-out', 'error'].includes(phase) && !$('#signin-dialog').open) $('#signin-dialog').showModal();
  $('#auth-user').hidden = !session;
  $('#auth-user').textContent = session ? (state.profiles.find(profile => profile.id === session.user.id)?.display_name || session.user.user_metadata?.full_name || 'Signed in') : '';
  $('#storage-note').textContent = phase === 'ready' ? 'Tasks are saved to Supabase.' : session ? 'Waiting for workspace access.' : 'Sign in to load shared tasks.';
  $('#refresh-data').hidden = !client; $('#refresh-data').disabled = busy || phase === 'loading';
  for (const selector of ['#new-task', '#add-task-row']) $(selector).disabled = busy || !canCreate();
  const creationHint = creationBlockReason();
  $('#creation-hint').textContent = creationHint;
  $('#creation-hint').hidden = !creationHint;
  for (const selector of ['#new-task', '#add-task-row']) $(selector).title = creationHint;
  const chair = phase === 'ready' && isAdmin();
  $('#admin-actions').hidden = !chair;
  for (const selector of ['#new-project', '#new-team']) $(selector).disabled = busy || !chair;
  $('#new-subteam').disabled = busy || !chair || !state.teams.some(team => !team.parent_team_id);
  $('#new-subteam').title = state.teams.some(team => !team.parent_team_id) ? '' : 'Create a parent team first.';
  $('#link-team').disabled = busy || !chair || !state.projects.length || !state.teams.length;
  $('#link-team').title = !state.projects.length || !state.teams.length ? 'Create a project and a team first.' : '';
  for (const selector of ['#task-search', '#status-filter', '#priority-filter']) $(selector).disabled = phase !== 'ready';
  $('main').setAttribute('aria-busy', String(phase === 'loading' || phase === 'connecting'));
  renderOverview(tasks); renderTasks(tasks);
}
function switchTab(tab) { activeTab = tab; if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`); render(); }
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
async function loadWorkspace() {
  if (!client || busy) return;
  const current = ++generation, userId = session?.user.id;
  clearData();
  if (!session) { phase = 'signed-out'; setBanner('Sign in to your workspace', pendingAuthError || 'Use Google sign-in to load your teams, projects, and shared tasks.'); render(); return; }
  phase = 'loading'; setBanner('Loading shared workspace', 'Reading projects, teams, members, and tasks from Supabase…'); render();
  try {
    const [teams, projects, projectTeams, profiles, memberships, leadership, tasks] = await Promise.all([
      readAll('teams', 'id,name,parent_team_id'), readAll('projects', 'id,name,status'),
      readAll('project_teams', 'project_id,team_id', 'project_id,team_id'), readAll('profiles', 'id,display_name'),
      readAll('team_members', 'team_id,user_id', 'team_id,user_id'),
      readAll('leadership_assignments', 'id,user_id,role,team_id,project_id,revoked_at'), readAll('tasks', TASK_FIELDS)
    ]);
    if (current !== generation || userId !== session?.user.id) return;
    Object.assign(state, { teams, projects, projectTeams, profiles, memberships, leadership, tasks });
    const prefs = readPreferences(); state.project = prefs.project || ''; state.team = prefs.team || 'all'; state.subteam = prefs.subteam || 'all';
    const member = memberships.some(member => member.user_id === userId) || leadership.some(role => role.user_id === userId && !role.revoked_at && ['exo_chair', 'permanent_project_lead', 'project_lead', 'team_lead'].includes(role.role));
    phase = member ? 'ready' : 'no-access';
    if (!member) setBanner('Signed in · membership needed', 'Your account has no workspace membership. Ask an administrator to add you to a team. For a new database, bootstrap your administrator using schema.sql.', 'error');
    else updateConnectedBanner();
    if (!member) { state.tasks = []; state.teams = []; state.projects = []; state.projectTeams = []; }
  } catch (error) {
    if (current !== generation || userId !== session?.user.id) return;
    clearData(); phase = 'error'; setBanner('Workspace could not be loaded', errorMessage(error), 'error');
  }
  render();
}
function updateConnectedBanner() {
  if (!state.projects.length) setBanner('Connected · no projects yet', isAdmin() ? 'Create your first project using the EXO chair controls below.' : 'An EXO chair can create your first project.', 'ready');
  else if (!state.projectTeams.length) setBanner('Connected · link teams to projects', isAdmin() ? 'Create your teams, then use Link team to project to start adding tasks.' : 'An EXO chair needs to link teams to projects before tasks can be added.', 'ready');
  else setBanner('Connected to Supabase', `${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} loaded across your workspace. Use Refresh to get the latest changes.`, 'ready');
}
function fillLinkTeams() {
  const projectId = $('#setup-project').value;
  const available = state.teams.filter(team => !state.projectTeams.some(link => link.project_id === projectId && link.team_id === team.id));
  $('#setup-link-team').innerHTML = options(available.map(team => [team.id, teamPath(team.id)]));
  const preferred = state.subteam !== 'all' ? state.subteam : state.team;
  if (available.some(team => team.id === preferred)) $('#setup-link-team').value = preferred;
  $('#setup-link-hint').textContent = available.length ? 'Links apply to the selected team or subteam. Link each subteam separately if it needs its own tasks.' : 'All teams are already linked to this project.';
  $('#save-setup').disabled = busy || !available.length;
}
function openSetup(mode) {
  if (busy || phase !== 'ready' || !isAdmin()) return;
  const roots = state.teams.filter(team => !team.parent_team_id);
  if (mode === 'subteam' && !roots.length) return;
  if (mode === 'link' && (!state.projects.length || !state.teams.length)) return;
  setupMode = mode;
  $('#setup-form').reset(); $('#setup-error').hidden = true;
  for (const field of $('#setup-form').querySelectorAll('input,select,textarea,button')) field.disabled = false;
  const labels = { project: 'New project', team: 'New team', subteam: 'New subteam', link: 'Link team to project' };
  $('#setup-title').textContent = labels[mode];
  $('#save-setup').textContent = mode === 'link' ? 'Link team' : `Create ${mode}`;
  $('#setup-description').textContent = {
    project: 'Create a shared project. Then link a team to it to begin adding tasks.',
    team: 'Create a team for your workspace. You can add subteams and link it to projects afterward.',
    subteam: 'Create a group within a parent team, then link it to any projects it will work on.',
    link: 'Connect an existing team or subteam to a project so tasks can be assigned to it.'
  }[mode];
  $('#setup-name-field').hidden = mode === 'link'; $('#setup-name').required = mode !== 'link';
  $('#setup-name').maxLength = mode === 'project' ? 160 : 120;
  $('#setup-parent-field').hidden = mode !== 'subteam'; $('#setup-parent').required = mode === 'subteam';
  $('#setup-parent').innerHTML = options(roots.map(team => [team.id, team.name]));
  if (roots.some(team => team.id === state.team)) $('#setup-parent').value = state.team;
  $('#setup-link-fields').hidden = mode !== 'link';
  $('#setup-project').required = mode === 'link'; $('#setup-link-team').required = mode === 'link';
  if (mode === 'link') {
    $('#setup-project').innerHTML = options(state.projects.map(project => [project.id, project.name]));
    $('#setup-project').value = state.project || state.projects[0].id;
    fillLinkTeams();
  }
  $('#setup-dialog').showModal(); (mode === 'link' ? $('#setup-project') : $('#setup-name')).focus();
}
async function saveSetup(event) {
  event.preventDefault(); if (busy || phase !== 'ready' || !session || !isAdmin()) return;
  const name = $('#setup-name').value.trim(), description = $('#setup-notes').value.trim() || null;
  if (setupMode !== 'link' && !name) { $('#setup-name').setCustomValidity('Enter a name.'); $('#setup-name').reportValidity(); return; }
  const owner = session.user.id, version = generation, mode = setupMode;
  let table, values, fields;
  if (mode === 'project') { table = 'projects'; values = { name, description, status: 'active', created_by: owner }; fields = 'id,name,status'; }
  else if (mode === 'link') {
    table = 'project_teams'; values = { project_id: $('#setup-project').value, team_id: $('#setup-link-team').value }; fields = 'project_id,team_id';
    if (!state.projects.some(project => project.id === values.project_id) || !teamById(values.team_id)) return;
  } else {
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
    else if (mode === 'link') { state.projectTeams.push(data); state.project = data.project_id; state.team = rootId(data.team_id); state.subteam = data.team_id === state.team ? 'all' : data.team_id; }
    else state.teams.push(data);
    savePreferences(); updateConnectedBanner(); $('#setup-dialog').close();
    toast(mode === 'link' ? 'Team linked to the project in Supabase.' : `${mode === 'subteam' ? 'Subteam' : mode === 'team' ? 'Team' : 'Project'} created in Supabase.`);
  } catch (error) {
    if (owner === session?.user.id && version === generation) {
      $('#setup-error').textContent = error.code === '23505' ? 'This record already exists. Close this dialog and refresh to see the latest data.' : errorMessage(error);
      $('#setup-error').hidden = false;
    }
  } finally {
    busy = false;
    for (const field of $('#setup-form').querySelectorAll('input,select,textarea,button')) field.disabled = false;
    $('#save-setup').textContent = mode === 'link' ? 'Link team' : `Create ${mode}`;
    if (mode === 'link' && $('#setup-dialog').open) fillLinkTeams();
    render();
  }
}
function populateTaskScope(projectId, preferredRoot, preferredTeam) {
  const roots = rootsForProject(projectId, true);
  $('#task-team').innerHTML = options(roots.map(team => [team.id, team.name]));
  $('#task-team').value = roots.some(team => team.id === preferredRoot) ? preferredRoot : roots[0]?.id || '';
  const linked = linkedTeams(projectId).filter(team => rootId(team.id) === $('#task-team').value && canWorkIn(team.id, projectId));
  $('#task-subteam').innerHTML = options(linked.map(team => [team.id, team.parent_team_id ? teamPath(team.id).split(' / ').slice(1).join(' / ') : 'Team-wide']));
  $('#task-subteam').value = linked.some(team => team.id === preferredTeam) ? preferredTeam : linked[0]?.id || '';
  $('#save-task').disabled = busy || !linked.length;
}
function openTask(id) {
  const task = id ? state.tasks.find(task => task.id === id) : null;
  if ((!task && !canCreate()) || busy) return;
  $('#task-form').reset(); $('#form-error').hidden = true;
  for (const field of $('#task-form').querySelectorAll('input,select,textarea')) field.disabled = false;
  $('#task-id').value = task?.id || ''; $('#dialog-title').textContent = task ? 'Task details' : 'New task';
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
    $('#dialog-title').textContent = canEdit(task) ? 'Edit task' : 'Task details · read only';
    $('#save-task').disabled = !canEdit(task);
  } else {
    const projects = state.projects.filter(project => linkedTeams(project.id).some(team => canWorkIn(team.id, project.id)));
    $('#task-project').innerHTML = options(projects.map(project => [project.id, project.name]));
    $('#task-project').value = projects.some(project => project.id === state.project) ? state.project : projects[0]?.id || '';
    populateTaskScope($('#task-project').value, state.team, state.subteam);
  }
  $('#delete-task').hidden = !task || !canEdit(task);
  $('#task-dialog').showModal(); if (!$('#task-title').disabled) $('#task-title').focus();
}
function lockForm(locked) {
  for (const button of $('#task-form').querySelectorAll('button')) button.disabled = locked;
  // A fieldset-equivalent lock also stops changing values while a request is pending.
  for (const field of $('#task-form').querySelectorAll('input,select,textarea')) {
    if (locked) { field.dataset.wasDisabled = String(field.disabled); field.disabled = true; }
    else { field.disabled = field.dataset.wasDisabled === 'true'; delete field.dataset.wasDisabled; }
  }
  $('#save-task').textContent = locked ? 'Saving…' : 'Save task';
}
function formError(error) { $('#form-error').textContent = errorMessage(error); $('#form-error').hidden = false; }
async function saveTask(event) {
  event.preventDefault(); if (busy || !session) return;
  const id = $('#task-id').value, existing = state.tasks.find(task => task.id === id);
  const title = $('#task-title').value.trim();
  if (!title) { $('#task-title').setCustomValidity('Give your task a name.'); $('#task-title').reportValidity(); return; }
  if (existing && !canEdit(existing)) return;
  const date = $('#task-due').value;
  const values = { title, description: $('#task-description').value.trim(), status: $('#task-status').value, priority: $('#task-priority').value, assignee_id: $('#task-assignee').value || null,
    due_at: !date ? null : existing && dueDate(existing) === date ? existing.due_at : new Date(`${date}T23:59:59`).toISOString() };
  const teamId = $('#task-subteam').value, projectId = $('#task-project').value;
  if (!existing && (!canWorkIn(teamId, projectId) || !state.projectTeams.some(link => link.project_id === projectId && link.team_id === teamId))) { formError(new Error('Choose a team linked to this project that you can edit.')); return; }
  const owner = session.user.id, version = generation;
  busy = true; lockForm(true); render();
  try {
    const query = existing ? client.from('tasks').update(values).eq('id', id).eq('updated_at', existing.updated_at) : client.from('tasks').insert({ ...values, project_id: projectId, team_id: teamId, created_by: owner });
    const { data, error } = await query.select(TASK_FIELDS).maybeSingle();
    if (error) throw error; if (!data) throw new Error('This task changed or you no longer have permission. Close this dialog, refresh, and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = existing ? state.tasks.map(task => task.id === id ? data : task) : [...state.tasks, data];
    state.project = data.project_id; state.team = rootId(data.team_id); state.subteam = data.team_id === state.team ? 'all' : data.team_id;
    $('#task-search').value = ''; $('#status-filter').value = 'all'; $('#priority-filter').value = 'all';
    savePreferences(); $('#task-dialog').close(); toast(existing ? 'Task saved to Supabase.' : 'Task created in Supabase.');
  } catch (error) { if (owner === session?.user.id && version === generation) formError(error); }
  finally { busy = false; lockForm(false); render(); }
}
async function toggleTask(event) {
  if (!event.target.matches('[data-complete]')) return;
  const task = state.tasks.find(task => task.id === event.target.dataset.complete);
  if (!task || !canEdit(task)) { render(); return; }
  const status = event.target.checked ? 'done' : 'todo', owner = session.user.id, version = generation;
  busy = true; render();
  try {
    const { data, error } = await client.from('tasks').update({ status }).eq('id', task.id).eq('updated_at', task.updated_at).select(TASK_FIELDS).maybeSingle();
    if (error) throw error; if (!data) throw new Error('Task changed or access was removed. Refresh and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = state.tasks.map(task => task.id === data.id ? data : task); toast(status === 'done' ? 'Task completed.' : 'Task reopened.');
  } catch (error) { if (owner === session?.user.id) toast(errorMessage(error)); }
  finally { busy = false; render(); }
}
async function deleteTask() {
  const task = state.tasks.find(task => task.id === $('#task-id').value);
  if (!task || !canEdit(task) || !confirm('Delete this task and its comments, links, checklist, and activity? This cannot be undone.')) return;
  const owner = session.user.id, version = generation; busy = true; lockForm(true); render();
  try {
    const { data, error } = await client.from('tasks').delete().eq('id', task.id).eq('updated_at', task.updated_at).select('id').maybeSingle();
    if (error) throw error; if (!data) throw new Error('Task changed or access was removed. Refresh and try again.');
    if (owner !== session?.user.id || version !== generation) return;
    state.tasks = state.tasks.filter(item => item.id !== task.id); $('#task-dialog').close(); toast('Task deleted from Supabase.');
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
$('#project-select').addEventListener('change', event => { state.project = event.target.value; state.team = 'all'; state.subteam = 'all'; savePreferences(); render(); });
$('#team-select').addEventListener('change', event => { state.team = event.target.value; state.subteam = 'all'; savePreferences(); render(); });
$('#subteam-select').addEventListener('change', event => { state.subteam = event.target.value; savePreferences(); render(); });
for (const element of document.querySelectorAll('[data-tab]')) element.addEventListener('click', event => { event.preventDefault(); switchTab(element.dataset.tab); });
$('.tabs').addEventListener('keydown', event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tab = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'tasks' : activeTab === 'overview' ? 'tasks' : 'overview'; switchTab(tab); $(`#tab-${tab}`).focus(); } });
window.addEventListener('hashchange', () => { if (['#overview', '#tasks', ''].includes(location.hash)) { activeTab = location.hash === '#tasks' ? 'tasks' : 'overview'; render(); } });
for (const selector of ['#new-task', '#add-task-row']) $(selector).addEventListener('click', () => openTask());
for (const selector of ['#see-tasks', '#view-all-tasks']) $(selector).addEventListener('click', () => switchTab('tasks'));
for (const selector of ['#close-dialog', '#cancel-dialog']) $(selector).addEventListener('click', () => { if (!busy) $('#task-dialog').close(); });
$('#task-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#task-title').addEventListener('input', () => $('#task-title').setCustomValidity(''));
$('#task-dialog').addEventListener('close', () => $('#task-title').setCustomValidity(''));
$('#task-project').addEventListener('change', () => populateTaskScope($('#task-project').value));
$('#task-team').addEventListener('change', () => populateTaskScope($('#task-project').value, $('#task-team').value));
for (const selector of ['#task-search', '#status-filter', '#priority-filter']) $(selector).addEventListener(selector === '#task-search' ? 'input' : 'change', () => renderTasks(scopedTasks()));
document.addEventListener('click', event => { const button = event.target.closest('[data-edit]'); if (button) openTask(button.dataset.edit); });
document.addEventListener('change', toggleTask);
$('#task-form').addEventListener('submit', saveTask);
for (const [selector, mode] of [['#new-project', 'project'], ['#new-team', 'team'], ['#new-subteam', 'subteam'], ['#link-team', 'link']]) $(selector).addEventListener('click', () => openSetup(mode));
$('#setup-form').addEventListener('submit', saveSetup);
$('#setup-name').addEventListener('input', () => $('#setup-name').setCustomValidity(''));
$('#setup-dialog').addEventListener('close', () => $('#setup-name').setCustomValidity(''));
$('#setup-project').addEventListener('change', fillLinkTeams);
for (const selector of ['#close-setup', '#cancel-setup']) $(selector).addEventListener('click', () => { if (!busy) $('#setup-dialog').close(); });
$('#setup-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#delete-task').addEventListener('click', deleteTask);
$('#auth-button').addEventListener('click', () => {
  if (session) authenticate();
  else { signinDismissed = false; render(); if (!$('#signin-dialog').open) $('#signin-dialog').showModal(); }
});
$('#google-signin').addEventListener('click', authenticate);
$('#close-signin').addEventListener('click', () => { if (!busy) { signinDismissed = true; $('#signin-dialog').close(); } });
$('#signin-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else signinDismissed = true; });
$('#signin-reload').addEventListener('click', () => location.reload());
$('#refresh-data').addEventListener('click', () => loadWorkspace());
render(); initialize();
