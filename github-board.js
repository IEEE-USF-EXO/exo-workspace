// Public board reader adapted from IEEE-USF-EXO/exo-workspace,
// branch tasks-panel-from-public-board, github-board.js.
// Reads public board fields only; no Google roster, member names, or tokens.
window.ExoBoard = (() => {
  const API = 'https://api.github.com/orgs/IEEE-USF-EXO/projectsV2/3';
  const boardUrl = 'https://github.com/orgs/IEEE-USF-EXO/projects/3';
  const fieldIds = { Title: 420365759, Status: 420365761, Project: 420365787, Team: 420365788, Priority: 420365789, Due: 420365790, Kind: 430031468, 'Sub-team': 430031469 };
  const openStatuses = ['active', 'queued', 'todo', 'in progress', 'needs decision'];
  const statuses = { active: 'in_progress', queued: 'todo', todo: 'todo', 'in progress': 'in_progress', 'needs decision': 'blocked', 'on hold': 'blocked', done: 'done', cancelled: 'cancelled', canceled: 'cancelled' };
  const priorities = { p0: 'urgent', p1: 'high', p2: 'medium', p3: 'low', urgent: 'urgent', high: 'high', medium: 'medium', low: 'low' };
  const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const nameKey = value => clean(value).toLowerCase();
  function fieldValue(field) {
    if (field.value == null) return '';
    if (field.data_type === 'single_select') return field.value.name?.raw || '';
    return typeof field.value === 'object' ? field.value.raw || '' : field.value;
  }
  function normalize(item) {
    const fields = Object.fromEntries((item.fields || []).map(field => [field.name, fieldValue(field)]));
    if (!/^\d+$/.test(String(item.id))) throw new Error('A board item has no stable GitHub ID. Import stopped.');
    return { id: String(item.id), title: clean(fields.Title || item.content?.title), project: clean(fields.Project), team: clean(fields.Team) || 'Unassigned team', subteam: clean(fields['Sub-team']), status: clean(fields.Status), priority: clean(fields.Priority), due: String(fields.Due || '').slice(0, 10), kind: clean(fields.Kind), body: String(item.content?.body || ''), updatedAt: item.updated_at || null, archived: Boolean(item.archived_at) };
  }
  async function githubFetch(url) {
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/orgs/IEEE-USF-EXO/projectsV2/3/')) throw new Error('Unexpected GitHub pagination URL.');
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      if ((response.status === 403 || response.status === 429) && response.headers.get('X-RateLimit-Remaining') === '0') {
        const reset = Number(response.headers.get('X-RateLimit-Reset'));
        const error = new Error(`GitHub’s public request limit was reached.${reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : ' Try again later.'}`);
        error.rateLimited = true; throw error;
      }
      throw new Error(`GitHub board request failed (HTTP ${response.status}). No tasks have been imported.`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('GitHub returned an unexpected board response.');
    return { data, next: response.headers.get('link')?.split(',').map(link => link.trim()).find(link => /rel="next"/.test(link))?.match(/<([^>]+)>/)?.[1] || null };
  }
  async function readPages(startUrl) {
    const records = [], seen = new Set(); let url = startUrl;
    while (url) {
      if (seen.has(url) || seen.size >= 20) throw new Error('The GitHub board pagination could not be completed. Nothing was imported.');
      seen.add(url); const page = await githubFetch(new URL(url)); records.push(...page.data); url = page.next;
    }
    return records;
  }
  async function load() {
    let ids = fieldIds;
    try {
      const fields = await readPages(`${API}/fields?per_page=100`);
      const live = Object.fromEntries(fields.filter(field => Object.hasOwn(fieldIds, field.name)).map(field => [field.name, field.id]));
      if (Object.keys(fieldIds).every(name => live[name])) ids = live;
    } catch (error) { if (error.rateLimited) throw error; }
    const url = new URL(`${API}/items`); url.searchParams.set('per_page', '100'); url.searchParams.set('fields', Object.values(ids).join(','));
    const all = (await readPages(url.href)).map(normalize);
    const unique = new Map(all.map(row => [row.id, row]));
    return { rows: [...unique.values()], fetchedAt: new Date().toISOString() };
  }
  function selectRows(rows, includeClosed = false) {
    return rows.filter(row => nameKey(row.project) === 'exo' && !row.archived && (includeClosed || openStatuses.includes(nameKey(row.status))));
  }
  function validate(row) {
    if (!row.title || row.title.length > 160) throw new Error(`GitHub item ${row.id} needs a title of 1–160 characters.`);
    if (row.team.length > 120 || row.subteam.length > 120) throw new Error(`GitHub item ${row.id} has a team name longer than 120 characters.`);
    if (!Object.hasOwn(statuses, nameKey(row.status))) throw new Error(`Unmapped GitHub status “${row.status}”. Import stopped to avoid changing its meaning.`);
    if (row.priority && !Object.hasOwn(priorities, nameKey(row.priority))) throw new Error(`Unmapped GitHub priority “${row.priority}”.`);
    if (row.due && (!/^\d{4}-\d{2}-\d{2}$/.test(row.due) || new Date(`${row.due}T12:00:00Z`).toISOString().slice(0, 10) !== row.due)) throw new Error(`GitHub item ${row.id} has an invalid due date.`);
  }
  // Deterministic IDs keep repeated imports and concurrent retries from duplicating
  // board items. Project ID is included so two destination projects stay separate.
  async function stableId(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).slice(0, 16);
    bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const taskId = (projectId, itemId) => stableId(`${boardUrl}|project:${projectId.toLowerCase()}|item:${itemId}`);
  const teamId = (parentId, name) => stableId(`${boardUrl}|team:${parentId || 'root'}|${nameKey(name)}`);
  function taskValues(row, projectId, teamId, userId, id) {
    validate(row);
    return { id, project_id: projectId, team_id: teamId, title: row.title, description: [row.body.trim(), `Imported from: ${boardUrl}\nGitHub item: ${row.id}\nKind: ${row.kind || 'Task'}\nBoard status: ${row.status}`].filter(Boolean).join('\n\n'), status: statuses[nameKey(row.status)], priority: priorities[nameKey(row.priority)] || 'medium', due_at: row.due ? new Date(`${row.due}T23:59:59`).toISOString() : null, assignee_id: null, created_by: userId };
  }
  return { load, normalize, fieldValue, selectRows, validate, taskId, teamId, taskValues, nameKey, boardUrl };
})();
