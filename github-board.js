/*
  Reads the public EXO Org Board (GitHub Projects v2, project number 3) straight
  from the browser and renders the open items grouped by team.

  No token and no backend: the board is public, and the REST endpoint sends
  Access-Control-Allow-Origin: *. The unauthenticated rate limit is 60 requests
  per hour per visitor IP, so the normalised array is cached in localStorage and
  only refetched when the cache is older than CACHE_TTL_MS or the visitor asks.
  Nothing here polls.

  Per Master Log D-021 the public board deliberately carries no member names, no
  budget figures and no purchase information. Assignee names come instead from a
  private Google Sheet in Drive, read at runtime with the viewer's own Google
  token — never from the board, and never from this repository.

  NAMES MUST NOT BE PERSISTED. The roster is held in memory only: it is never
  written to localStorage, never merged into the cached board array, and never
  committed to this public repository or served to an anonymous visitor. Signing
  out reloads the page (see signOut in app.js), which discards it. Only columns
  A-E of the Tasks tab are read, so Drive emails and GitHub logins from the
  Members tab never reach the browser.

  The board is regenerated from the EXO Master Log, so it lags the log. The panel
  labels itself with the board's own last-changed time rather than implying live
  data.
*/
window.ExoBoard = (function () {
  const ORG = "IEEE-USF-EXO";
  const PROJECT_NUMBER = 3;
  const API = `https://api.github.com/orgs/${ORG}/projectsV2/${PROJECT_NUMBER}`;
  const BOARD_URL = `https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}`;

  const CACHE_KEY = "exo_board_cache_v1";
  const CACHE_TTL_MS = 10 * 60 * 1000;

  // Read once from the fields endpoint; these are the fallback if that read fails.
  const FALLBACK_FIELD_IDS = {
    Title: 420365759,
    Status: 420365761,
    Project: 420365787,
    Team: 420365788,
    Priority: 420365789,
    Due: 420365790,
    Kind: 430031468,
    "Sub-team": 430031469,
  };
  const WANTED_FIELDS = Object.keys(FALLBACK_FIELD_IDS);

  const PROJECT_FILTER = "EXO"; // PID Spoon is on hold (D-019)
  const OPEN_STATUSES = [
    "Active",
    "Queued",
    "Todo",
    "In Progress",
    "Needs decision",
  ];
  const TEAM_ORDER = [
    "Project Leads",
    "Mechanical",
    "Electrical",
    "Controls",
    "Interfaces",
  ];
  const NO_TEAM = "No team set";
  const BODY_PREVIEW_CHARS = 170;

  // "EXO Teams and Task Manager", 00 Program Management. Private; read with the
  // viewer's own Google token, the same sign-in the Files section uses (the app
  // holds the full Drive scope, which authorises the Sheets API).
  const ROSTER_SHEET_ID = "1DFEJTdtidSPWh2iKWhcnIEYAjKnnuxHlV_6MOjffGuc";
  // Columns A-E only: Package, Title, Team, Sub-team, Assigned to. F and G are
  // the sheet's own copy of Status and Due, which go stale; the board stays
  // authoritative for both, so they are deliberately not read. The Members tab
  // is never read at all.
  const ROSTER_RANGE = "Tasks!A2:E";
  const GOOGLE_TOKEN_KEY = "google_provider_token";

  let container = null;
  let rows = null; // normalised, cached array — public board data only
  let meta = null; // { fetchedAt, boardUpdatedAt }
  let loading = false;
  let problem = null; // { kind, detail }

  // Memory only. Never cached, never written into `rows`. See the header.
  let roster = null; // Map packageId -> { team, subteam, assignee }
  let rosterState = "idle"; // idle | ok | no-token | denied | failed

  /* ---------- small helpers ---------- */

  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function formatDate(iso) {
    if (!iso) return "";
    // Due comes back as a date at midnight UTC; read the calendar date straight
    // out of the string so a western timezone does not shift it back a day.
    const parts = String(iso).slice(0, 10).split("-");
    if (parts.length !== 3) return "";
    const date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function relativeTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours === 1) return "1 hour ago";
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  function truncate(text, limit) {
    const flat = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (flat.length <= limit) return flat;
    return `${flat.slice(0, limit).replace(/\s+\S*$/, "")}…`;
  }

  /* ---------- cache ---------- */

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.rows)) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (error) {
      // A full or blocked localStorage is not a reason to drop the panel.
    }
  }

  function cacheIsStale() {
    if (!meta || !meta.fetchedAt) return true;
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    return !(age >= 0) || age > CACHE_TTL_MS;
  }

  /* ---------- fetch and normalise ---------- */

  // A single-select label nests two levels down, a title or text value one
  // level down, and a date arrives as a plain ISO string.
  function fieldValue(field) {
    const value = field.value;
    if (value == null) return null;
    if (field.data_type === "single_select") {
      return (value.name && value.name.raw) || null;
    }
    if (typeof value === "object") return value.raw == null ? null : value.raw;
    return value;
  }

  function normalise(item) {
    const out = {};
    for (const field of item.fields || []) out[field.name] = fieldValue(field);
    out.body = (item.content && item.content.body) || "";
    // item_url points at the JSON item, not a page a person can read. Real
    // repository issues carry content.html_url; draft items carry neither, and
    // today every EXO item on the board is a draft.
    out.htmlUrl = (item.content && item.content.html_url) || null;
    out.itemUrl = item.item_url || null;
    out.updatedAt = item.updated_at || null;
    return out;
  }

  async function githubFetch(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!response.ok) {
      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (response.status === 403 && remaining === "0") {
        const reset = Number(response.headers.get("X-RateLimit-Reset"));
        const error = new Error("rate limited");
        error.kind = "rate-limit";
        error.resetAt = reset ? new Date(reset * 1000).toISOString() : null;
        throw error;
      }
      const error = new Error(`GitHub returned ${response.status}`);
      error.kind = "http";
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function loadFieldIds() {
    try {
      const fields = await githubFetch(`${API}/fields?per_page=50`);
      const found = {};
      for (const field of Array.isArray(fields) ? fields : []) {
        if (WANTED_FIELDS.includes(field.name)) found[field.name] = field.id;
      }
      // Only trust the live read if it covers everything the panel groups by.
      const complete = WANTED_FIELDS.every((name) => found[name]);
      return complete ? found : FALLBACK_FIELD_IDS;
    } catch (error) {
      if (error.kind === "rate-limit") throw error;
      return FALLBACK_FIELD_IDS;
    }
  }

  async function loadBoard() {
    const fieldIds = await loadFieldIds();
    const ids = WANTED_FIELDS.map((name) => fieldIds[name])
      .filter(Boolean)
      .join(",");
    // Without fields= every item comes back with Title only.
    const items = await githubFetch(
      `${API}/items?per_page=100&fields=${encodeURIComponent(ids)}`,
    );
    const list = Array.isArray(items) ? items : [];
    const normalised = list.map(normalise);
    const boardUpdatedAt = normalised.reduce(
      (latest, row) =>
        row.updatedAt && row.updatedAt > latest ? row.updatedAt : latest,
      "",
    );
    return {
      rows: normalised,
      meta: {
        fetchedAt: new Date().toISOString(),
        boardUpdatedAt: boardUpdatedAt || null,
      },
    };
  }

  /* ---------- roster join (private sheet, viewer's own token) ---------- */

  function googleToken() {
    try {
      return sessionStorage.getItem(GOOGLE_TOKEN_KEY);
    } catch (error) {
      return null;
    }
  }

  // Board titles start with the package ID, e.g. "ELEC-013 BMS integration
  // concept", which is what column A of the Tasks tab holds.
  function packageId(title) {
    const first = String(title || "")
      .trim()
      .split(/\s+/)[0];
    return first ? first.toUpperCase() : "";
  }

  async function loadRoster() {
    const token = googleToken();
    if (!token) {
      roster = null;
      rosterState = "no-token";
      return;
    }
    try {
      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}` +
        `/values/${encodeURIComponent(ROSTER_RANGE)}?majorDimension=ROWS`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        // The Google token expired. The board view carries on without names.
        roster = null;
        rosterState = "expired";
        return;
      }
      if (response.status === 403 || response.status === 404) {
        // Signed in, but this viewer cannot see the sheet.
        roster = null;
        rosterState = "denied";
        return;
      }
      if (!response.ok) {
        roster = null;
        rosterState = "failed";
        return;
      }
      const data = await response.json();
      const map = new Map();
      for (const row of data.values || []) {
        const id = packageId(row[0]);
        if (!id) continue;
        map.set(id, {
          team: String(row[2] || "").trim(),
          subteam: String(row[3] || "").trim(),
          assignee: String(row[4] || "").trim(),
        });
      }
      roster = map;
      rosterState = "ok";
    } catch (error) {
      roster = null;
      rosterState = "failed";
    }
  }

  function rosterFor(item) {
    if (!roster) return null;
    return roster.get(packageId(item.Title)) || null;
  }

  // The board is authoritative for team and sub-team; the sheet only fills gaps.
  function teamOf(item) {
    const entry = rosterFor(item);
    return item.Team || (entry && entry.team) || NO_TEAM;
  }

  function subteamOf(item) {
    const fromBoard = String(item["Sub-team"] || "").trim();
    if (fromBoard) return fromBoard;
    const entry = rosterFor(item);
    return entry ? entry.subteam : "";
  }

  function assigneeOf(item) {
    const entry = rosterFor(item);
    return entry && entry.assignee ? entry.assignee : "";
  }

  /* ---------- filtering and grouping ---------- */

  function isOpen(row) {
    return OPEN_STATUSES.includes(row.Status);
  }

  function inProject(row) {
    return row.Project === PROJECT_FILTER;
  }

  function sortItems(a, b) {
    if (Boolean(a.Due) !== Boolean(b.Due)) return a.Due ? -1 : 1;
    if (a.Due && b.Due && a.Due !== b.Due) return a.Due < b.Due ? -1 : 1;
    return String(a.Title || "").localeCompare(String(b.Title || ""));
  }

  function teamRank(team) {
    const index = TEAM_ORDER.indexOf(team);
    return index === -1 ? TEAM_ORDER.length + 1 : index;
  }

  // -> [{ team, count, direct: [item], subteams: [{ name, items }] }]
  function groupByTeam(items) {
    const teams = new Map();
    for (const item of items) {
      const team = teamOf(item);
      if (!teams.has(team)) teams.set(team, { direct: [], subteams: new Map() });
      const bucket = teams.get(team);
      const subteam = subteamOf(item);
      if (!subteam) {
        bucket.direct.push(item);
        continue;
      }
      if (!bucket.subteams.has(subteam)) bucket.subteams.set(subteam, []);
      bucket.subteams.get(subteam).push(item);
    }
    return [...teams.entries()]
      .map(([team, bucket]) => {
        const subteams = [...bucket.subteams.entries()]
          .map(([name, list]) => ({ name, items: list.sort(sortItems) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const count =
          bucket.direct.length +
          subteams.reduce((total, group) => total + group.items.length, 0);
        return { team, count, direct: bucket.direct.sort(sortItems), subteams };
      })
      .sort(
        (a, b) =>
          teamRank(a.team) - teamRank(b.team) || a.team.localeCompare(b.team),
      );
  }

  /* ---------- markup ---------- */

  function statusSlug(status) {
    return String(status || "")
      .toLowerCase()
      .replace(/[^a-z]+/g, "-");
  }

  function itemHTML(item) {
    const title = esc(item.Title || "Untitled item");
    const body = truncate(item.body, BODY_PREVIEW_CHARS);
    const assignee = assigneeOf(item);
    const meta = [];
    if (item.Status) {
      meta.push(
        `<span class="board-chip board-chip-${statusSlug(item.Status)}">${esc(item.Status)}</span>`,
      );
    }
    if (item.Priority) meta.push(`<span>${esc(item.Priority)}</span>`);
    if (item.Due) meta.push(`<span>Due ${esc(formatDate(item.Due))}</span>`);
    return `
      <li class="board-item">
        ${
          item.htmlUrl
            ? `<a class="board-item-title" href="${esc(item.htmlUrl)}" target="_blank" rel="noopener noreferrer">${title} &#8599;</a>`
            : `<span class="board-item-title">${title}</span>`
        }
        ${body ? `<p class="board-item-body">${esc(body)}</p>` : ""}
        ${
          assignee
            ? `<p class="board-item-assignee">Assigned to <b>${esc(assignee)}</b></p>`
            : ""
        }
        ${meta.length ? `<div class="board-item-meta">${meta.join("")}</div>` : ""}
      </li>`;
  }

  function teamHTML(group) {
    return `
      <article class="board-team">
        <header class="board-team-head">
          <b>${esc(group.team)}</b>
          <span class="pill">${group.count}</span>
        </header>
        ${
          group.direct.length
            ? `<ul class="board-items">${group.direct.map(itemHTML).join("")}</ul>`
            : ""
        }
        ${group.subteams
          .map(
            (subteam) => `
          <div class="board-subteam">
            <h4>${esc(subteam.name)} <span class="pill">${subteam.items.length}</span></h4>
            <ul class="board-items">${subteam.items.map(itemHTML).join("")}</ul>
          </div>`,
          )
          .join("")}
      </article>`;
  }

  function sectionHTML(options) {
    const groups = groupByTeam(options.items);
    return `
      <section class="panel board-panel">
        <div class="panel-head">
          <div>
            <b>${esc(options.title)}</b>
            <p>${options.description}</p>
          </div>
          <div class="row">
            <span class="pill">${options.items.length} open</span>
            ${options.tools || ""}
          </div>
        </div>
        ${
          groups.length
            ? `<div class="board-teams">${groups.map(teamHTML).join("")}</div>`
            : `<div class="empty">
                 <div class="empty-symbol" aria-hidden="true">◇</div>
                 <h3>${esc(options.emptyTitle)}</h3>
                 <p>${esc(options.emptyBody)}</p>
               </div>`
        }
      </section>`;
  }

  function problemHTML() {
    if (!problem) return "";
    const stale =
      rows && rows.length && meta && meta.fetchedAt
        ? ` Showing the cached board read ${esc(relativeTime(meta.fetchedAt))}.`
        : " Nothing is cached yet, so there is nothing to show.";
    const messages = {
      offline:
        "No network connection, so the board could not be read from GitHub.",
      "rate-limit": `GitHub's unauthenticated rate limit (60 requests per hour) is used up for this network${
        problem.resetAt ? `, until ${esc(formatDateTime(problem.resetAt))}` : ""
      }.`,
      http: `GitHub returned ${esc(problem.status || "an error")} for the board request.`,
    };
    return `<div class="alert board-alert" role="alert">${
      messages[problem.kind] || "The board could not be read from GitHub."
    }${stale}</div>`;
  }

  function panelMarkup() {
    if (loading && !rows) {
      return `<div class="empty"><p>Reading the EXO Org Board…</p></div>`;
    }

    const open = (rows || []).filter((row) => inProject(row) && isOpen(row));
    const workPackages = open.filter((row) => row.Kind !== "Decision");
    const decisions = open.filter((row) => row.Kind === "Decision");

    const freshness = [];
    if (meta && meta.boardUpdatedAt) {
      freshness.push(`Board last changed ${esc(formatDateTime(meta.boardUpdatedAt))}`);
    }
    if (meta && meta.fetchedAt) {
      freshness.push(`read ${esc(relativeTime(meta.fetchedAt))}`);
    }
    const refresh = `<button class="secondary" type="button" data-board-action="refresh" ${
      loading ? "disabled" : ""
    }>${loading ? "Refreshing…" : "Refresh"}</button>`;

    return `
      ${problemHTML()}
      ${sectionHTML({
        title: "Open work packages",
        description: `Grouped by team from the public EXO Org Board. ${
          freshness.join(" · ") || "Not read yet"
        }. The board is regenerated from the EXO Master Log, so it can lag the log.`,
        items: workPackages,
        tools: refresh,
        emptyTitle: "No open work packages",
        emptyBody:
          "Nothing on the board is currently in Active, Queued, Todo, In Progress or Needs decision for EXO.",
      })}
      ${sectionHTML({
        title: "Decisions waiting on a Project Lead",
        description: `Items the board marks as decisions rather than work. <a href="${BOARD_URL}" target="_blank" rel="noopener noreferrer">Open the board on GitHub &#8599;</a>`,
        items: decisions,
        emptyTitle: "No open decisions",
        emptyBody: "Every decision on the board has been settled.",
      })}
      <p class="board-note">
        Status, due dates and the item list come from the public board, which
        carries no individual names, budget figures or purchase information by
        decision D-021. Assignees are read from the private “EXO Teams and Task
        Manager” sheet in Drive with your own Google sign-in, and are never
        stored by this page.${
          rosterState === "no-token"
            ? " Sign in with Google to see who is assigned to each package."
            : rosterState === "expired"
              ? " Your Google sign-in expired, so assignees are not shown. Reconnect Google to see them."
              : rosterState === "denied"
                ? " You do not have access to that sheet, so assignees are not shown."
                : rosterState === "failed"
                  ? " The roster sheet could not be read just now, so assignees are not shown."
                  : ""
        }
      </p>`;
  }

  function paint() {
    if (!container) return;
    try {
      container.innerHTML = panelMarkup();
    } catch (error) {
      container.innerHTML = `<div class="alert" role="alert">The board panel could not be drawn.</div>`;
    }
  }

  /* ---------- lifecycle ---------- */

  async function syncRoster() {
    await loadRoster();
    paint();
  }

  async function refresh(force) {
    if (loading) return;
    if (force) syncRoster();
    if (!force && !cacheIsStale()) return;
    if (navigator.onLine === false) {
      problem = { kind: "offline" };
      paint();
      return;
    }
    loading = true;
    paint();
    try {
      const result = await loadBoard();
      rows = result.rows;
      meta = result.meta;
      problem = null;
      writeCache({ rows, meta });
    } catch (error) {
      problem =
        error && error.kind === "rate-limit"
          ? { kind: "rate-limit", resetAt: error.resetAt }
          : error && error.kind === "http"
            ? { kind: "http", status: error.status }
            : { kind: "offline" };
    } finally {
      loading = false;
      paint();
    }
  }

  // app.js drops this shell into the view; everything inside belongs to us.
  function panelHTML() {
    return `<div id="exo-board-panel" class="board-root"></div>`;
  }

  function mount(element) {
    try {
      container = element || document.getElementById("exo-board-panel");
      if (!container) return;
      if (!rows) {
        const cached = readCache();
        if (cached) {
          rows = cached.rows;
          meta = cached.meta || null;
        }
      }
      container.onclick = (event) => {
        const button = event.target.closest("[data-board-action='refresh']");
        if (!button) return;
        event.preventDefault();
        refresh(true);
      };
      // A sign-out reloads the page, but drop the names here too if the token
      // has gone for any other reason.
      if (!googleToken() && roster) {
        roster = null;
        rosterState = "no-token";
      }
      paint();
      if (rosterState === "idle" || rosterState === "no-token") syncRoster();
      refresh(false);
    } catch (error) {
      if (element) {
        element.innerHTML = `<div class="alert" role="alert">The board panel could not be loaded.</div>`;
      }
    }
  }

  function clearRoster() {
    roster = null;
    rosterState = "no-token";
    paint();
  }

  return {
    panelHTML,
    mount,
    refresh,
    clearRoster,
    normalise,
    fieldValue,
    groupByTeam,
    packageId,
  };
})();
