const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const views = {
  overview: ["Overview", "overview"],
  tasks: ["Tasks", "tasks"],
  "drawing-board": ["Drawing board", "drawing-board"],
  files: ["Files", "files"],
  bom: ["BOM", "bom"],
  gallery: ["Photos", "gallery"],
  repos: ["Repos & Links", "repo-and-links"],
};

export function createWorkspaceShell({ root, engine, initialView, onViewChange, onScopeChange, onLogin }) {
  let view = initialView;
  let files = [];
  let bom = [];
  let drawingScope = null;
  let lastError = "";

  const renderShell = () => {
    root.innerHTML = `
      <div class="v2-app">
        <header class="v2-header">
          <div class="v2-brand"><img src="content/project-icon.png" alt="EXO project icon"><div><b>EXO</b><small>PROJECT WORKSPACE</small></div>${engine.token() ? "" : '<button class="secondary v2-login" data-login>Sign in</button>'}</div>
          <div class="v2-scope">
            <div class="v2-scope-label">ENGINEERING PILLAR</div>
            <div class="v2-pillar-row" role="tablist" aria-label="Engineering pillars">
              ${engine.teams.map((team) => `<button class="v2-pillar ${team.id === engine.scope.teamId ? "active" : ""}" data-team="${esc(team.id)}" role="tab">${esc(team.name)}</button>`).join("") || '<span class="v2-empty-scope">Sign in with Google to load Drive teams.</span>'}
            </div>
            <div class="v2-scope-label">SQUAD</div>
            <div class="v2-squad-row" aria-label="Sub-team squads">
              ${engine.teams.length ? `<button class="v2-squad ${engine.scope.subteamId === engine.scope.teamId ? "active" : ""}" data-team-scope="${esc(engine.scope.teamId)}">All squads</button>` : ""}
              ${engine.children.map((subteam) => `<button class="v2-squad ${subteam.id === engine.scope.subteamId ? "active" : ""}" data-subteam="${esc(subteam.id)}">${esc(subteam.name)}</button>`).join("") || (engine.teams.length ? "" : '<span class="v2-empty-scope">No sub-teams in this pillar.</span>')}
            </div>
          </div>
        </header>
        <div class="v2-body">
          <aside class="v2-sidebar"><div class="v2-nav-label">WORKSPACE</div><nav aria-label="Workspace views">
            ${Object.entries(views).map(([key, [label, icon]]) => `<button class="v2-nav ${key === view ? "active" : ""}" data-view="${key}"><span class="nav-icon nav-icon-${icon}" aria-hidden="true"></span>${label}</button>`).join("")}
          </nav></aside>
          <main class="v2-main"><div class="v2-context"><span>${esc(engine.scope.teamName || "EXO Workspace")}</span><span aria-hidden="true">›</span><b>${esc(engine.scope.subteamName || "All squads")}</b><code>${esc(engine.activeFolderId)}</code></div>${lastError ? `<div class="alert" role="alert">${esc(lastError)}</div>` : ""}<section id="v2-view">${content()}</section></main>
        </div>
      </div>`;
    bind();
    if (view === "tasks" && window.ExoBoard) window.ExoBoard.mount(document.querySelector("#v2-task-panel"));
  };

  const content = () => {
    if (view === "overview") return `<div class="v2-dashboard-grid"><section class="panel v2-welcome"><div class="panel-head"><div><span class="eyebrow">SCOPED ENGINEERING WORKSPACE</span><h1>${esc(engine.scope.subteamName || engine.scope.teamName || "EXO Workspace")}</h1><p>Work packages, documents, BOM records, and project links for the active Drive scope.</p></div></div><div class="v2-stat-grid"><div><b>${files.length}</b><span>Drive files</span></div><div><b>${bom.length}</b><span>BOM records</span></div><div><b>${engine.children.length}</b><span>Squads</span></div></div></section><aside class="panel v2-context-panel"><h2>Scope context</h2><dl><div><dt>Drive folder</dt><dd><code>${esc(engine.activeFolderId)}</code></dd></div><div><dt>Workspace</dt><dd>${esc(engine.scope.teamName || "All pillars")}</dd></div><div><dt>Squad</dt><dd>${esc(engine.scope.subteamName || "All squads")}</dd></div></dl><p class="muted">Select Tasks, Files, BOM, or Drawing board to work in this scope.</p></aside></div>`;
    if (view === "tasks") return `<div id="v2-task-panel">${window.ExoBoard?.panelHTML?.() || "Tasks unavailable."}</div>`;
    if (view === "files") return `<section class="panel"><div class="panel-head"><div><h2>Scoped Drive files</h2><p>${files.length} items in the selected squad folder.</p></div><button class="primary" disabled title="The Team and Sub-team container is read-only">＋ New</button></div>${files.length ? `<div class="v2-file-list">${files.map((file) => `<a href="${esc(file.webViewLink || "#")}" target="_blank" rel="noopener">${esc(file.name)}</a>`).join("")}</div>` : '<div class="empty"><h3>No files loaded</h3><p>Sign in with Google Drive to browse this scope.</p></div>'}</section>`;
    if (view === "bom") return `<section class="panel"><div class="panel-head"><div><h2>Scoped BOM</h2><p>${bom.length} records keyed to the active folder.</p></div></div><div class="v2-file-list">${bom.map((row) => `<span>${esc(row.component || row.item_id || "BOM item")}</span>`).join("") || "No folder-scoped BOM records found."}</div></section>`;
    if (view === "drawing-board") return `<section class="panel"><div class="panel-head"><div><h2>Drawing board</h2><p>Canvas state follows folder ${esc(drawingScope || engine.activeFolderId)}.</p></div></div><div class="empty"><h3>Scoped canvas ready</h3><p>The v2 canvas adapter is isolated to this Team/Sub-team folder.</p></div></section>`;
    return `<section class="panel"><div class="panel-head"><div><h2>${views[view][0]}</h2><p>Active scope: ${esc(engine.scope.subteamName || engine.scope.teamName || "EXO Workspace")}</p></div></div></section>`;
  };

  const showError = (message) => {
    lastError = message;
    renderShell();
  };

  const bind = () => {
    root.querySelectorAll("[data-view]").forEach((button) => button.onclick = () => {
      view = button.dataset.view;
      onViewChange(view);
      renderShell();
    });
    root.querySelectorAll("[data-team]").forEach((button) => button.onclick = () => engine.selectTeam(button.dataset.team));
    root.querySelectorAll("[data-subteam]").forEach((button) => button.onclick = () => engine.selectSubteam(button.dataset.subteam));
    root.querySelectorAll("[data-team-scope]").forEach((button) => button.onclick = () => engine.selectTeam(button.dataset.teamScope));
    root.querySelector("[data-login]")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await onLogin();
      } catch (error) {
        event.currentTarget.disabled = false;
        root.insertAdjacentHTML(
          "afterbegin",
          `<div class="alert" role="alert">${esc(error instanceof Error ? error.message : "Google sign-in failed.")}</div>`,
        );
      }
    });
  };

  engine.subscribe(async (scope) => {
    renderShell();
    try {
      await onScopeChange(scope);
      lastError = "";
    } catch (error) {
      showError(error instanceof Error ? error.message : "The selected scope could not be loaded.");
    }
  });

  return {
    render: renderShell,
    setView(nextView) { view = nextView; renderShell(); },
    showError,
    async loadFiles(scope) {
      if (!engine.token?.()) return;
      const items = await engine.listChildren(scope.subteamId, sessionStorage.getItem("google_provider_token"));
      if (scope.subteamId !== engine.scope.subteamId) return;
      files = items.filter((item) => item.mimeType !== "application/vnd.google-apps.folder");
      if (view === "files" || view === "overview") renderShell();
    },
    async loadBOM(scope, client) {
      if (!client) return;
      const result = await client.from("bom_items").select("*").eq("folder_id", scope.subteamId);
      if (result.error) throw result.error;
      if (scope.subteamId !== engine.scope.subteamId) return;
      bom = result.data || [];
      if (view === "bom" || view === "overview") renderShell();
    },
    async loadDrawing(scope) {
      if (scope.subteamId !== engine.scope.subteamId) return;
      drawingScope = scope.subteamId;
      if (view === "drawing-board") renderShell();
    },
  };
}
