"use strict";

// ==========================================
// 1. GOOGLE & SUPABASE CONFIGURATION
// ==========================================
const GITHUB_ORG_OR_USERNAME = "IEEE-USF-EXO";
const GITHUB_REPOSITORIES = {
  exo: {},
  "pid-spoon": {
    Controls: "pid-spoon-controls",
    Electrical: "pid-spoon-electrical",
    Mechanical: "pid-spoon-mechanical",
    Shared: "pid-spoon-interfaces",
  },
};
//hello
const SUPABASE_URL = "https://tnupwlucufewosslvcaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXB3bHVjdWZld29zc2x2Y2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTM4MjIsImV4cCI6MjEwNzMyOTgyMn0.4TFRb6t4pE547wywotP_SWZG50NiJzlxs1_Ds51aQmM";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      storage: window.localStorage,
      autoRefreshToken: true,
    },
  },
);

let googleAccessToken = null;
let sharedBOMRows = [];
let driveFolders = [];

async function signInWithGoogle() {
  if (window.location.protocol === "file:") {
    notify(
      "Google sign-in requires this app to run from http://localhost, not a file:// URL.",
    );
    return;
  }
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes:
          "https://www.googleapis.com/auth/drive",
        queryParams: { access_type: "offline", prompt: "consent" },
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (error) throw error;
  } catch (error) {
    notify("Google sign-in failed: " + error.message);
  }
}

async function loadSharedBOM() {
  const { data, error } = await supabaseClient
    .from("bom_items")
    .select("id, project_id, item_id, subsystem, component, purpose, quantity, unit_cost, extended_cost, supplier, cost_basis, stage, source")
    .order("project_id")
    .order("item_id");
  if (error) {
    if (error.code === "42P01") return;
    notify("Shared BOM could not be loaded: " + error.message);
    return;
  }
  sharedBOMRows = data || [];
  if (view === "bom") previewBOM();
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

async function checkUserSession() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");

  if (session) {
    googleAccessToken = session.provider_token || null;
    if (loginBtn) loginBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-flex";
    await ensureMemberProfile(session.user);
    await loadSharedBOM();
    try {
      await syncDriveFiles();
    } catch (error) {
      driveSyncing = false;
      notify("Google Drive files could not be synchronized: " + error.message);
    }
  } else {
    googleAccessToken = null;
    sharedBOMRows = [];
    if (loginBtn) loginBtn.style.display = "inline-flex";
    if (logoutBtn) logoutBtn.style.display = "none";
  }

  async function ensureMemberProfile(user) {
    const metadata = user.user_metadata || {};
    const displayName =
      metadata.user_name || metadata.full_name || metadata.name || user.email || "";
    const { error } = await supabaseClient.from("members").upsert(
      {
        user_id: user.id,
        display_name: displayName,
        email: user.email || "",
      },
      { onConflict: "user_id" },
    );
    if (error && error.code !== "42P01") {
      notify("Your group membership could not be saved: " + error.message);
    }
  }
}

supabaseClient.auth.onAuthStateChange((event, session) => {
  checkUserSession();
});

async function uploadFileToGoogleDrive(file, folderId) {
  if (!googleAccessToken) {
    throw new Error("Google Drive access is unavailable. Sign in again.");
  }
  const sessionResponse = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink,thumbnailLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "application/octet-stream",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify({
        name: file.name,
        ...(folderId ? { parents: [folderId] } : {}),
      }),
    },
  );
  if (!sessionResponse.ok) {
    const details = await sessionResponse.json().catch(() => ({}));
    throw new Error(
      details.error?.message ||
        `Google Drive upload could not start (HTTP ${sessionResponse.status})`,
    );
  }

  const uploadUrl = sessionResponse.headers.get("Location");
  if (!uploadUrl) throw new Error("Google Drive did not return an upload session.");
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let result = null;
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - offset),
        "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file.slice(offset, end),
    });
    if (response.status !== 308 && !response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(
        details.error?.message ||
          `Google Drive upload failed (HTTP ${response.status})`,
      );
    }
    offset = end;
    if (response.status !== 308) result = await response.json();
  }
  return result;
}

function showDriveTestUpload() {
  openModal(
    "Test Google Drive upload",
    `<form id="drive-test-upload-form"><p class="hint" style="margin-bottom:14px">Choose one file to test the Google Drive connection. It will be uploaded to the <strong>Testing</strong> folder.</p><label class="field">File<input type="file" name="file" required><small>This test does not use the project folder structure.</small></label>${actions("Upload test file")}</form>`,
  );
  $("#drive-test-upload-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      notify("Choose a nonempty file.");
      return;
    }
    const button = $("[type=submit]", event.target);
    button.disabled = true;
    button.textContent = "Uploading to Google Drive…";
    try {
      const driveFile = await uploadFileToGoogleDrive(file, driveTestFolderId);
      $("#dialog").close();
      notify(
        `Test upload succeeded: ${driveFile.name || file.name}. ` +
          `Open it in Drive: ${driveFile.webViewLink || "check your Drive root."}`,
      );
    } catch (error) {
      notify("Test upload failed: " + error.message);
      button.disabled = false;
      button.textContent = "Try again";
    }
  };
}

async function createDriveFolder(name, parentId) {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    },
  );
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(
      details.error?.message ||
        `Google Drive folder could not be created (HTTP ${response.status})`,
    );
  }
  return response.json();
}

async function listDriveChildren(parentId) {
  const children = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed = false`,
      pageSize: "1000",
      fields:
        "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,parents)",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${googleAccessToken}` } },
    );
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(
        details.error?.message ||
          `Google Drive folders could not be listed (HTTP ${response.status})`,
      );
    }
    const data = await response.json();
    children.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return children;
}

async function syncDriveFiles() {
  if (!googleAccessToken) return;
  if (driveSyncing) return;
  driveSyncing = true;
  const driveFiles = [];
  const folders = [];
  const visited = new Set();
  for (const [project, team, folderId] of folderIds) {
    const walk = async (parentId, path) => {
      if (visited.has(parentId)) return;
      visited.add(parentId);
      folders.push({ id: parentId, project, team, path });
      for (const file of await listDriveChildren(parentId)) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          await walk(file.id, `${path}/${file.name}`);
          continue;
        }
      driveFiles.push({
        id: `drive-${file.id}`,
        driveId: file.id,
        driveUrl:
          file.webViewLink ||
          `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
        thumbnailUrl:
          file.thumbnailLink ||
          `https://drive.google.com/thumbnail?id=${encodeURIComponent(file.id)}&sz=w1200`,
        name: file.name,
        type: file.mimeType || "application/octet-stream",
        size: Number(file.size || 0),
        project,
        team,
        folderId: parentId,
        folderPath: path,
        note: "",
        created: file.modifiedTime || new Date().toISOString(),
      });
      }
    };
    await walk(folderId, "");
  }
  driveFolders = folders;
  const localOnly = state.files.filter(
    (file) => !file.driveId && !driveFiles.some((drive) => drive.name === file.name),
  );
  state.files = [...localOnly, ...driveFiles];
  await persist();
  driveSyncing = false;
  if (view === "files" || view === "gallery" || view === "bom") render();
}

// Helper to push a File object directly to GitHub REST API (supports creating & updating files)
async function pushFileToGitHub(file, owner, repo, folderPath, note = "") {
  if (!githubAccessToken) {
    throw new Error(
      "Not signed in with GitHub (or token expired). Please click Sign out and Sign in with GitHub again.",
    );
  }

  const base64Content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const cleanFolder = String(folderPath || "")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  const fullPath = cleanFolder ? `${cleanFolder}/${file.name}` : file.name;
  const encodedPath = fullPath.split("/").map(encodeURIComponent).join("/");
  const repoApiUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const apiUrl = `${repoApiUrl}/contents/${encodedPath}`;
  const repoHeaders = {
    Authorization: `Bearer ${githubAccessToken}`,
    Accept: "application/vnd.github.v3+json",
  };
  const repoResponse = await fetch(repoApiUrl, { headers: repoHeaders });
  if (!repoResponse.ok) {
    const errorData = await repoResponse.json().catch(() => ({}));
    throw new Error(errorData.message || `Could not read repository (HTTP ${repoResponse.status})`);
  }
  const repository = await repoResponse.json();
  const baseBranch = repository.default_branch;
  const uploadKey = `exo-dashboard-upload:${owner}/${repo}:${cleanFolder}`;
  let branchName = localStorage.getItem(uploadKey);
  let pullRequest = null;
  if (branchName) {
    const openPullRequestsResponse = await fetch(
      `${repoApiUrl}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branchName}`)}&base=${encodeURIComponent(baseBranch)}`,
      { headers: repoHeaders },
    );
    if (openPullRequestsResponse.ok) {
      const openPullRequests = await openPullRequestsResponse.json();
      pullRequest = openPullRequests[0] || null;
    }
    if (!pullRequest) {
      localStorage.removeItem(uploadKey);
      branchName = null;
    }
  }
  if (!branchName) {
    branchName = `exo-dashboard/${Date.now()}-${cleanFolder
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "uploads"}`;
  const baseRefResponse = await fetch(
    `${repoApiUrl}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers: repoHeaders },
  );
  if (!baseRefResponse.ok) {
    const errorData = await baseRefResponse.json().catch(() => ({}));
    throw new Error(errorData.message || `Could not read the default branch (HTTP ${baseRefResponse.status})`);
  }
  const baseRef = await baseRefResponse.json();
  const branchResponse = await fetch(`${repoApiUrl}/git/refs`, {
    method: "POST",
    headers: { ...repoHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha,
    }),
  });
  if (!branchResponse.ok) {
    const errorData = await branchResponse.json().catch(() => ({}));
    throw new Error(errorData.message || `Could not create upload branch (HTTP ${branchResponse.status})`);
  }
  }

  // Check if file already exists so we can pass its SHA to update it instead of failing with 422
  let existingSha = null;
  try {
    const checkRes = await fetch(
      `${apiUrl}?ref=${encodeURIComponent(branchName)}`,
      {
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (checkRes.ok) {
      const existingData = await checkRes.json();
      existingSha = existingData.sha;
    }
  } catch (_) {}

  const payload = {
    message: note
      ? `Upload ${file.name}: ${note}`
      : `Upload ${file.name} via EXO Dashboard`,
    content: base64Content,
    branch: branchName,
  };
  if (existingSha) payload.sha = existingSha;

  const response = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${githubAccessToken}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `HTTP ${response.status}`);
  }
  if (!pullRequest) {
  const pullRequestResponse = await fetch(`${repoApiUrl}/pulls`, {
    method: "POST",
    headers: { ...repoHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: note ? `Upload ${file.name}: ${note}` : `Upload ${file.name}`,
      head: branchName,
      base: baseBranch,
      body: `Uploaded through the EXO Dashboard.${note ? `\n\n${note}` : ""}`,
    }),
  });
  if (!pullRequestResponse.ok) {
    const errorData = await pullRequestResponse.json().catch(() => ({}));
    throw new Error(
      errorData.message ||
        `File uploaded, but could not open a pull request (HTTP ${pullRequestResponse.status})`,
    );
  }
  pullRequest = await pullRequestResponse.json();
  localStorage.setItem(uploadKey, branchName);
  }
  return pullRequest;
}

// ==========================================
// 2. ORIGINAL EXO-DASHBOARD APPLICATION LOGIC
// ==========================================
const $ = (s, root = document) => root.querySelector(s),
  $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
$("#close-startup-overlay").onclick = () => {
  $("#startup-overlay").hidden = true;
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bomLinkHTML = (value) => {
  const link = String(value ?? "").trim();
  if (!link) return "—";
  try {
    const url = new URL(link);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open link">Link</a>`;
  } catch {
    return esc(link);
  }
};
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
const teams = ["Controls", "Electrical", "Mechanical", "Shared"];
const teamColors = {
  Controls: "#658e99",
  Electrical: "#b29a58",
  Mechanical: "#769667",
  Shared: "#869b76",
};
const initial = () => ({
  version: 1,
  projects: [
    { id: "exo", name: "EXO", description: "Lower-limb exoskeleton" },
    {
      id: "pid-spoon",
      name: "PID Spoon",
      description: "Stabilized assistive utensil",
    },
  ],
  files: [],
  nodes: [],
  edges: [],
  strokes: [],
  resources: [],
  bom: {},
  bomEntries: [],
});
let penColor = "#346d4b";
document.addEventListener("input", (event) => {
  if (event.target.id === "pen-color") penColor = event.target.value;
});
let state = initial(),
  db = null,
  view = "overview",
  scope = "exo",
  tool = "select",
  selected = null,
  connectFrom = null,
  zoom = 1,
  search = "",
  fileTeam = "all",
  bomSearch = "",
  bomTeam = "all",
  bomStage = "all",
  bomPrice = "all",
  storageAvailable = false,
  history = [],
  saving = Promise.resolve(),
  urls = new Map(),
  gesture = null,
  toastTimer,
  driveSyncing = false;
const folderIds = [
  ["exo", "Controls", "1Pdx0N6EHctdZKqb7P29tVHuNVr8v8yrN"],
  ["exo", "Electrical", "1WLCSZ5bMisg1GjJH-oVJhsXjM938elaR"],
  ["exo", "Mechanical", "1sMgbFofCqB6DEapmZF6tF5tD1TZEUM76"],
  ["pid-spoon", "Controls", "1jie8n23dzmk5Pc_jcJEEmj1bJYQxc9Tl"],
  ["pid-spoon", "Electrical", "16DcGIMgwtcuZrYI7QaQJs6lVmQ6q1_ZE"],
  ["pid-spoon", "Mechanical", "1a1LPEQUeCjfbkV6nDJag9Hsq55-Go0J8"],
];
const driveTestFolderId = "1kldWFbtd0S_Mr8zsrYBCrYiGJsc1zhl_";
const teamLabel = (project, team) =>
  project === "pid-spoon" && team === "Mechanical" ? "CAD" : team;
const driveFolderFor = (project, team) =>
  folderIds.find(([folderProject, folderTeam]) =>
    folderProject === project && folderTeam === team)?.[2] || null;
const driveFoldersFor = (project, team) =>
  driveFolders.filter(
    (folder) => folder.project === project && folder.team === team,
  );
const driveFolderOptions = (project, team, selectedId = "") => {
  const folders = driveFoldersFor(project, team);
  return (folders.length
    ? folders
    : [{ id: driveFolderFor(project, team), path: "" }]
  )
    .map((folder) => {
      const rootName = teamLabel(project, team) + " folder";
      const label = folder.path
        ? `${rootName} / ${folder.path.slice(1)}`
        : rootName;
      return `<option value="${esc(folder.id)}" ${folder.id === selectedId ? "selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
};
const knownResources = [
  ...Object.entries(GITHUB_REPOSITORIES).flatMap(([project, repos]) =>
    Object.entries(repos).map(([team, repo]) => ({
      id: `${project}-${team}-repo`,
      project,
      team,
      title: `${team} repository`,
      url: `https://${"github.com"}/${GITHUB_ORG_OR_USERNAME}/${repo}`,
    })),
  ),
  ...folderIds.map(([project, team, id]) => ({
    id,
    project,
    team,
    title: teamLabel(project, team) + " Drive folder",
    url: "https://drive.google.com/drive/folders/" + id,
  })),
];
const nameOf = (id) =>
  state.projects.find((p) => p.id === id)?.name || "Unknown project";
const inScope = (item) => scope === "all" || item.project === scope;
const currentProject = () => (scope === "all" ? state.projects[0].id : scope);
const githubRepoFor = (project, team) => {
  const configuredRepo = GITHUB_REPOSITORIES[project]?.[team];
  if (configuredRepo) {
    return { owner: GITHUB_ORG_OR_USERNAME, repo: configuredRepo };
  }

  const resource = state.resources.find(
    (item) =>
      item.project === project &&
      item.team === team &&
      item.url.startsWith("https://github.com/"),
  );
  const match = resource?.url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i,
  );
  return match ? { owner: match[1], repo: match[2] } : null;
};
const teamOptions = (value, project = null) =>
  (project
    ? folderIds
        .filter(([folderProject]) => folderProject === project)
        .map(([, team]) => team)
    : teams
  )
    .map(
      (t) =>
        `<option value="${esc(t)}" ${value === t ? "selected" : ""}>${esc(teamLabel(project, t))}</option>`,
    )
    .join("");
const projectOptions = (value) =>
  state.projects
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${value === p.id ? "selected" : ""}>${esc(p.name)}</option>`,
    )
    .join("");
const sizeOf = (n) =>
  n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
const isPhoto = (f) => /^image\/(png|jpeg|webp|gif|avif)$/.test(f.type);
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
function warn(message) {
  $("#storage-warning").textContent = message;
  $("#storage-warning").classList.remove("hidden");
}
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("exo-html-workspace-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("state");
      request.result.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function record(store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function writeStores(nextState, blobs = [], replace = false) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["state", "blobs"], "readwrite");
    tx.objectStore("state").put(nextState, "workspace");
    if (replace) tx.objectStore("blobs").clear();
    for (const item of blobs) tx.objectStore("blobs").put(item.blob, item.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Storage write interrupted"));
  });
}
function removeBlob(id) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve();
      return;
    }
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Storage deletion interrupted"));
  });
}
function persist() {
  const snapshot = structuredClone(state);
  $("#save-status").textContent = "Saving…";
  saving = saving
    .catch(() => {})
    .then(async () => {
      if (!db) throw new Error("Browser storage unavailable");
      await writeStores(snapshot);
      $("#save-status").textContent = "Saved in this browser";
    })
    .catch((error) => {
      $("#save-status").textContent = "Not saved";
      warn(
        "Your browser could not save this change. Keep this tab open and export a backup. " +
          error.message,
      );
    });
  return saving;
}
function checkpoint() {
  history.push(
    JSON.stringify({
      nodes: state.nodes,
      edges: state.edges,
      strokes: state.strokes,
    }),
  );
  if (history.length > 35) history.shift();
}
function undo() {
  if (!history.length) return;
  const previous = JSON.parse(history.pop());
  Object.assign(state, previous);
  selected = null;
  connectFrom = null;
  persist();
  render();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function getBlob(id) {
  return urls.has("blob-" + id)
    ? urls.get("blob-" + id)
    : db
      ? await record("blobs", id)
      : null;
}
async function getDriveBlob(file) {
  if (!file?.driveId || !googleAccessToken) return null;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.driveId)}?alt=media`,
    { headers: { Authorization: `Bearer ${googleAccessToken}` } },
  );
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(
      details.error?.message || `Google Drive download failed (HTTP ${response.status})`,
    );
  }
  return response.blob();
}
async function fileURL(id) {
  if (urls.has(id)) return urls.get(id);
  const file = state.files.find((item) => item.id === id);
  if (file?.thumbnailUrl) return file.thumbnailUrl;
  const blob = await getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}
async function downloadFile(id) {
  const f = state.files.find((x) => x.id === id);
  if (f?.driveUrl) {
    window.open(f.driveUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const blob = await getBlob(id);
  if (!blob) {
    notify("This file is available in Google Drive, but its link is missing.");
    return;
  }
  download(blob, f?.name || "file");
}
async function removeLocalFile(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  if (!window.confirm(`Remove "${file.name}" from this browser? This will not delete it from Google Drive.`)) {
    return;
  }
  state.files = state.files.filter((item) => item.id !== id);
  for (const node of state.nodes) {
    node.files = (node.files || []).filter((fileId) => fileId !== id);
  }
  for (const project of state.projects) {
    if (state.bom[project.id] === id) delete state.bom[project.id];
  }
  const url = urls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urls.delete(id);
  }
  try {
    await removeBlob(id);
    await persist();
    render();
    notify(`Removed ${file.name} from this browser.`);
  } catch (error) {
    notify("Could not remove the local file: " + error.message);
  }
}
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#dialog").classList.remove("lightbox");
  $("#dialog").showModal();
}
const actions = (label) =>
  `<div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit" class="primary">${label}</button></div>`;

function projectForm() {
  openModal(
    "Start a new project",
    `<form id="project-form"><label class="field">Project name<input name="name" maxlength="80" placeholder="Name your project" required autofocus></label><label class="field">Description<textarea name="description" maxlength="500" placeholder="What are you building?"></textarea></label>${actions("Create project")}</form>`,
  );
  $("#project-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target),
      name = String(form.get("name")).trim();
    if (!name) return;
    if (
      state.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())
    ) {
      notify("A project with that name already exists.");
      return;
    }
    const p = { id: uid(), name, description: String(form.get("description")) };
    state.projects.push(p);
    scope = p.id;
    await persist();
    $("#dialog").close();
    render();
  };
}

// Save locally in IndexedDB and upload to the selected Google Drive folder.
function showUpload(photos = false) {
  const initialProject = currentProject();
  const initialTeam =
    folderIds.find(([project]) => project === initialProject)?.[1] || "";
  const initialFolder = driveFoldersFor(initialProject, initialTeam)[0]?.id ||
    driveFolderFor(initialProject, initialTeam);
  const accept = photos
    ? 'accept="image/png,image/jpeg,image/webp,image/gif,image/avif"'
    : "";
  openModal(
    photos ? "Add project photos" : "Add project files",
    `<form id="upload-form"><p class="hint" style="margin-bottom:14px">Google Drive provides the folder structure below. Choose a destination, or upload a folder to recreate its subfolders there.</p>${photos ? "" : '<label class="field">Upload type<select name="upload-mode"><option value="files">Individual files</option><option value="folder">A folder and its contents</option></select></label>'}<label class="field">${photos ? "Photos" : "Files"}<input id="upload-input" type="file" name="files" ${accept} multiple required><small class="upload-help">Large files upload directly to Drive.</small></label>${scope === "all" ? `<label class="field">Project<select name="project">${projectOptions(initialProject)}</select><small>Choose a project before uploading from All projects.</small></label>` : `<label class="field">Project<input value="${esc(nameOf(initialProject))}" readonly><input type="hidden" name="project" value="${esc(initialProject)}"></label>`}<label class="field">Destination team<select name="team">${teamOptions(initialTeam, initialProject)}</select></label><label class="field">Destination folder<select name="folder">${driveFolderOptions(initialProject, initialTeam, initialFolder)}</select></label><label class="field">Note or photo caption<textarea name="note" maxlength="1000" placeholder="Context, version, or what the photo shows"></textarea></label>${actions(photos ? "Add photos" : "Add files")}</form>`,
  );
  const formElement = $("#upload-form");
  const refreshFolders = () => {
    const project = String(formElement.elements.project.value);
    const team = String(formElement.elements.team.value);
    const folders = driveFoldersFor(project, team);
    formElement.elements.folder.innerHTML = driveFolderOptions(
      project,
      team,
      folders[0]?.id || driveFolderFor(project, team),
    );
  };
  formElement.elements.team.onchange = refreshFolders;
  if (scope === "all") formElement.elements.project.onchange = (event) => {
    const project = String(event.target.value);
    const availableTeam = folderIds.find(
      ([folderProject]) => folderProject === project,
    )?.[1] || "";
    formElement.elements.team.innerHTML = teamOptions(availableTeam, project);
    refreshFolders();
  };
  formElement.elements["upload-mode"]?.addEventListener("change", (event) => {
    const folderMode = event.target.value === "folder";
    const input = formElement.elements.files;
    input.toggleAttribute("webkitdirectory", folderMode);
    input.toggleAttribute("directory", folderMode);
    input.multiple = true;
    formElement.querySelector(".upload-help").textContent = folderMode
      ? "The folder's subfolders will be created in Google Drive."
      : "Large files upload directly to Drive.";
  });
  formElement.onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target),
      files = Array.from(e.target.elements.files.files);
    if (files.some((f) => !f.size)) {
      notify("Choose nonempty files.");
      return;
    }
    if (photos && files.some((f) => !isPhoto(f))) {
      notify("Choose PNG, JPEG, WebP, GIF, or AVIF photos.");
      return;
    }
    const button = $("[type=submit]", e.target);
    button.disabled = true;
    button.textContent = "Uploading to Google Drive…";
    const proj = String(form.get("project")),
      team = String(form.get("team")),
      note = String(form.get("note")),
      folderId = String(form.get("folder") || "");
    if (!folderId) {
      notify("No Google Drive folder is configured for this project and team.");
      button.disabled = false;
      button.textContent = photos ? "Add photos" : "Add files";
      return;
    }
    try {
      const additions = [];
      const createdFolders = new Map();
      for (const file of files) {
        let destination = folderId;
        const relativePath = file.webkitRelativePath || "";
        const pathParts = relativePath.split("/").filter(Boolean).slice(1, -1);
        for (const part of pathParts) {
          const key = `${destination}/${part}`;
          if (!createdFolders.has(key)) {
            const existing = driveFolders.find(
              (folder) => folder.id === destination && folder.path.endsWith(`/${part}`),
            );
            const created = existing || await createDriveFolder(part, destination);
            createdFolders.set(key, created.id);
          }
          destination = createdFolders.get(key);
        }
        const driveFile = await uploadFileToGoogleDrive(file, destination);
        additions.push({
          id: uid(),
          driveId: driveFile.id,
          driveUrl:
            driveFile.webViewLink ||
            `https://drive.google.com/open?id=${encodeURIComponent(driveFile.id)}`,
          thumbnailUrl:
            driveFile.thumbnailLink ||
            `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveFile.id)}&sz=w1200`,
          name: driveFile.name || file.name,
          type: driveFile.mimeType || file.type || "application/octet-stream",
          size: Number(driveFile.size || file.size),
          project: proj,
          team,
          folderId: destination,
          folderPath: relativePath,
          note,
          created: new Date().toISOString(),
        });
      }
      await saving;
      const next = { ...state, files: [...state.files, ...additions] };
      await writeStores(next);
      state = next;
      $("#save-status").textContent = "Saved in this browser";
      $("#dialog").close();
      render();
      notify(
        photos
          ? "Photos uploaded to Google Drive."
          : "Files uploaded to Google Drive.",
      );
    } catch (error) {
      notify("Upload error: " + error.message);
      button.disabled = false;
      button.textContent = "Try again";
    }
  };
}

function addCard(x, y) {
  openModal(
    "Add a card",
    `<form id="card-form"><label class="field">Card title<input name="title" maxlength="120" placeholder="What should this card represent?" required autofocus></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions("Shared")}</select></label></div><label class="field">Owner<input name="owner" maxlength="100" placeholder="Person or team"></label><label class="field">Notes<textarea name="note" maxlength="2000"></textarea></label>${actions("Place card")}</form>`,
  );
  $("#card-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    checkpoint();
    const node = {
      id: uid(),
      title: String(f.get("title")).trim(),
      project: String(f.get("project")),
      team: String(f.get("team")),
      owner: String(f.get("owner")),
      note: String(f.get("note")),
      status: "Not started",
      x: Math.max(10, Math.min(2170, x)),
      y: Math.max(10, Math.min(1460, y)),
      files: [],
    };
    if (!node.title) return;
    state.nodes.push(node);
    selected = { kind: "node", id: node.id };
    persist();
    $("#dialog").close();
    render();
  };
}
function centerCard() {
  const v = $(".canvas-viewport");
  addCard(
    v ? (v.scrollLeft + v.clientWidth / 2) / zoom - 110 : 100,
    v ? (v.scrollTop + v.clientHeight / 2) / zoom - 60 : 100,
  );
}
function showStorage() {
  openModal(
    "Your workspace storage",
    `<p class="hint">This workspace stores drawing state and Drive file metadata locally in your browser. File contents are uploaded to Google Drive.</p><ul class="storage-list"><li><b>Google Drive</b>Large files are uploaded directly to the selected project/team folder using resumable uploads.</li><li><b>Browser storage</b>Projects, drawings, relationships, BOM selections, and Drive file links are stored locally in this browser profile.</li><li><b>Share or back up</b>Export a JSON backup containing workspace data and Drive-backed file metadata. The backup does not duplicate large Drive files.</li></ul><div class="row"><button class="primary" data-action="export">↓ Export workspace backup</button><button class="secondary" data-action="import">↑ Import backup</button></div>`,
  );
}
function toolHint() {
  return tool === "pen"
    ? "Drag on the board to draw."
    : tool === "connect"
      ? connectFrom
        ? "Choose a second card to connect."
        : "Choose the first card, then the second."
      : tool === "hand"
        ? "Drag the board to pan."
        : "Drag cards to arrange them. Select a connection to label it.";
}
function boardHTML() {
  const nodes = state.nodes.filter(inScope),
    nodeIds = new Set(nodes.map((n) => n.id)),
    edges = state.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
    strokes = state.strokes.filter(inScope);
  return `<section class="panel"><div class="canvas-top"><div class="tools" aria-label="Drawing tools">${[
    ["select", "↖ Select"],
    ["pen", "✎ Draw"],
    ["connect", "↗ Connect"],
    ["hand", "✋ Pan"],
  ]
    .map(
      ([id, label]) =>
        `<button class="tool ${tool === id ? "active" : ""}" data-tool="${id}" aria-pressed="${tool === id}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="row"><input id="pen-color" type="color" value="#346d4b" title="Pen color" aria-label="Pen color" style="padding:2px;width:27px;height:27px"><button class="text-button" data-action="undo" ${history.length ? "" : "disabled"}>↶ Undo</button><button class="secondary" data-action="zoom-out" aria-label="Zoom out">−</button><span id="zoom-label" class="small muted">${Math.round(zoom * 100)}%</span><button class="secondary" data-action="zoom-in" aria-label="Zoom in">＋</button></div></div><div class="canvas-layout"><div class="canvas-viewport" tabindex="0" aria-label="Drawing board. Use Add card for cards, Draw for freehand marks, and Connect for relationships."><div class="world-space" style="width:${2400 * zoom}px;height:${1600 * zoom}px"><div class="world ${tool === "pen" ? "draw" : tool}" style="transform:scale(${zoom})"><svg width="2400" height="1600" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="#9caf90"/></marker></defs>${edges.map(edgeSVG).join("")}${strokes.map((s) => `<polyline class="stroke" data-stroke="${s.id}" points="${s.points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${selected?.id === s.id ? 4 : 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</svg>${nodes.map(cardHTML).join("")}</div></div>${!nodes.length && !strokes.length ? `<div class="canvas-note"><strong>A blank board. Yours to shape.</strong><p>Add your own cards or choose Draw and start sketching. Nothing is generated for you.</p></div>` : ""}</div><aside class="inspector" id="inspector"></aside></div><div class="canvas-footer"><span id="tool-hint">${toolHint()}</span><span>${nodes.length} cards · ${edges.length} connections · ${scope === "all" ? "All projects" : esc(nameOf(scope))}</span></div></section>`;
}
function edgeSVG(edge) {
  const a = state.nodes.find((n) => n.id === edge.from),
    b = state.nodes.find((n) => n.id === edge.to);
  if (!a || !b) return "";
  const right = b.x >= a.x,
    x1 = a.x + (right ? 220 : 0),
    y1 = a.y + 56,
    x2 = b.x + (right ? 0 : 220),
    y2 = b.y + 56,
    mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2,
    d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
    sel = selected?.id === edge.id;
  return `<g><path d="${d}" stroke="${sel ? "#477b3a" : "#a7b99b"}" stroke-width="${sel ? 2.5 : 1.4}" fill="none" marker-end="url(#arrow)"/><path class="edge-hit" data-edge="${edge.id}" d="${d}" stroke="transparent" stroke-width="18" fill="none"/>${edge.label ? `<rect x="${mx - 75}" y="${my - 13}" width="150" height="24" rx="5" fill="#fbfdf7" stroke="#e0e8d8"/><text x="${mx}" y="${my + 3}" text-anchor="middle" font-size="10" fill="#718962">${esc(edge.label.slice(0, 25))}</text>` : ""}</g>`;
}
function cardHTML(n) {
  return `<button class="canvas-card ${selected?.id === n.id ? "selected" : ""} ${connectFrom === n.id ? "connect-source" : ""}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px;--card-color:${teamColors[n.team] || teamColors.Shared}" aria-label="${esc(n.title)}"><span class="card-meta"><span>${esc(n.team)}</span><span>${esc(nameOf(n.project))}</span></span><strong class="card-title">${esc(n.title)}</strong><span class="card-foot"><span>${esc(n.owner || "Owner unassigned")}</span><span>${n.files.length ? "▱ " + n.files.length + " · " : ""}${esc(n.status)}</span></span></button>`;
}
function renderInspector() {
  const root = $("#inspector");
  if (!root) return;
  if (!selected) {
    root.innerHTML = `<div class="eyebrow">DETAILS & RELATIONSHIPS</div><h3>Give the work context.</h3><p>Select a card to assign its project and team, add notes, or reference a file.</p><div class="related"><h3>Cross-team references</h3><p>Use Connect to draw an arrow between cards. Select that arrow and describe the relationship in your own words.</p><p style="margin-top:12px">Choose All projects in the sidebar to connect cards belonging to different projects.</p></div>`;
    return;
  }
  if (selected.kind === "node") {
    const n = state.nodes.find((x) => x.id === selected.id);
    if (!n) {
      selected = null;
      renderInspector();
      return;
    }
    const connections = state.edges.filter(
      (e) => e.from === n.id || e.to === n.id,
    );
    root.innerHTML = `<div class="eyebrow">SELECTED CARD</div><form id="node-edit"><label class="field">Title<input name="title" maxlength="120" value="${esc(n.title)}" required></label><label class="field">Project<select name="project">${projectOptions(n.project)}</select></label><label class="field">Team<select name="team">${teamOptions(n.team)}</select></label><label class="field">Owner<input name="owner" maxlength="100" value="${esc(n.owner)}"></label><label class="field">Status<select name="status">${["Not started", "In progress", "Blocked", "Complete"].map((s) => `<option ${n.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="field wide">Notes<textarea name="note" maxlength="2000">${esc(n.note)}</textarea></label><button class="primary" type="submit">Save details</button></form><div class="related"><h3>File references</h3><div class="attachments">${n.files
      .map((id) => {
        const f = state.files.find((f) => f.id === id);
        return f
          ? `<div class="attachment"><a href="#" data-download="${f.id}">${esc(f.name)}</a><button data-unlink="${f.id}" aria-label="Remove file reference">×</button></div>`
          : "";
      })
      .join(
        "",
      )}</div><label class="field">Attach a workspace file<select id="attach-file"><option value="">Choose a file…</option>${state.files
      .filter((f) => !n.files.includes(f.id))
      .map(
        (f) =>
          `<option value="${f.id}">${esc(nameOf(f.project))} /${esc(f.name)}</option>`,
      )
      .join(
        "",
      )}</select></label></div><div class="related"><h3>Relationships · ${connections.length}</h3>${
      connections
        .map((e) => {
          const other = state.nodes.find(
            (x) => x.id === (e.from === n.id ? e.to : e.from),
          );
          return other
            ? `<button class="related-card" data-select-edge="${e.id}">${e.from === n.id ? "↗" : "↙"} ${esc(other.title)}<small>${esc(nameOf(other.project))} · ${esc(other.team)}<br>${esc(e.label || "Unlabeled connection")}</small></button>`
            : "";
        })
        .join("") || "<p>No relationships drawn yet.</p>"
    }</div><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove card</button>`;
    $("#node-edit").onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      checkpoint();
      for (const key of ["title", "project", "team", "owner", "status", "note"])
        n[key] = String(f.get(key)).trim();
      persist();
      renderBoardPreservingScroll();
    };
    $("#attach-file").onchange = (e) => {
      if (!e.target.value) return;
      checkpoint();
      n.files.push(e.target.value);
      persist();
      renderBoardPreservingScroll();
    };
    return;
  }
  if (selected.kind === "edge") {
    const edge = state.edges.find((e) => e.id === selected.id);
    if (!edge) return;
    const a = state.nodes.find((n) => n.id === edge.from),
      b = state.nodes.find((n) => n.id === edge.to);
    root.innerHTML = `<div class="eyebrow">SELECTED RELATIONSHIP</div><h3>${esc(a?.title)} → ${esc(b?.title)}</h3><p>${esc(nameOf(a?.project))} / ${esc(a?.team)}<br>to ${esc(nameOf(b?.project))} / ${esc(b?.team)}</p><form id="edge-edit" style="margin-top:18px"><label class="field">Relationship label<input name="label" maxlength="100" placeholder="e.g. supplies sensor data to" value="${esc(edge.label)}"></label><label class="field">Notes<textarea name="note" maxlength="1500">${esc(edge.note || "")}</textarea></label><button class="primary" type="submit">Save relationship</button></form><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove connection</button>`;
    $("#edge-edit").onsubmit = (e) => {
      e.preventDefault();
      checkpoint();
      const f = new FormData(e.target);
      edge.label = String(f.get("label"));
      edge.note = String(f.get("note"));
      persist();
      renderBoardPreservingScroll();
    };
    return;
  }
  root.innerHTML =
    '<h3>Selected drawing</h3><p>This stroke is part of your freehand drawing.</p><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove stroke</button>';
}
function renderBoardPreservingScroll() {
  const v = $(".canvas-viewport"),
    left = v?.scrollLeft || 0,
    top = v?.scrollTop || 0;
  $("#view").innerHTML = boardHTML();
  const next = $(".canvas-viewport");
  next.scrollLeft = left;
  next.scrollTop = top;
  bindBoard();
  renderInspector();
}
function bindBoard() {
  $("#pen-color").value = penColor;
  const world = $(".world"),
    viewport = $(".canvas-viewport");
  world.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const target = e.target.closest("[data-node],[data-edge],[data-stroke]"),
      rect = world.getBoundingClientRect(),
      point = [(e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom];
    if (tool === "hand") {
      gesture = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
      };
    } else if (tool === "pen") {
      checkpoint();
      const stroke = {
        id: uid(),
        project: currentProject(),
        color: $("#pen-color").value,
        points: [point],
      };
      state.strokes.push(stroke);
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      for (const [k, v] of Object.entries({
        fill: "none",
        stroke: stroke.color,
        "stroke-width": "2.5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }))
        path.setAttribute(k, v);
      $("svg", world).appendChild(path);
      gesture = { kind: "draw", stroke, path };
      $(".canvas-note")?.remove();
    } else if (target?.dataset.node) {
      const n = state.nodes.find((n) => n.id === target.dataset.node);
      if (tool === "connect") {
        if (connectFrom && connectFrom !== n.id) {
          if (
            state.edges.some(
              (edge) => edge.from === connectFrom && edge.to === n.id,
            )
          ) {
            notify("These cards are already connected.");
            connectFrom = null;
            renderBoardPreservingScroll();
            return;
          }
          checkpoint();
          const edge = {
            id: uid(),
            from: connectFrom,
            to: n.id,
            label: "",
            note: "",
          };
          state.edges.push(edge);
          selected = { kind: "edge", id: edge.id };
          connectFrom = null;
          persist();
          renderBoardPreservingScroll();
        } else {
          connectFrom = n.id;
          selected = { kind: "node", id: n.id };
          renderBoardPreservingScroll();
        }
        return;
      }
      selected = { kind: "node", id: n.id };
      checkpoint();
      gesture = {
        kind: "move",
        node: n,
        start: point,
        x: n.x,
        y: n.y,
        el: target,
      };
      $$(".canvas-card").forEach((el) =>
        el.classList.toggle("selected", el.dataset.node === n.id),
      );
      renderInspector();
    } else if (target?.dataset.edge) {
      selected = { kind: "edge", id: target.dataset.edge };
      renderBoardPreservingScroll();
      return;
    } else if (target?.dataset.stroke) {
      selected = { kind: "stroke", id: target.dataset.stroke };
      renderInspector();
      return;
    } else {
      selected = null;
      connectFrom = null;
      renderInspector();
      $$(".canvas-card").forEach((el) =>
        el.classList.remove("selected", "connect-source"),
      );
    }
    if (gesture) {
      world.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };
  world.onpointermove = (e) => {
    if (!gesture) return;
    const rect = world.getBoundingClientRect(),
      p = [(e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom];
    if (gesture.kind === "draw") {
      if (gesture.stroke.points.length < 12000) {
        gesture.stroke.points.push(p);
        gesture.path.setAttribute(
          "points",
          gesture.stroke.points.map((v) => v.join(",")).join(" "),
        );
      }
    } else if (gesture.kind === "move") {
      const g = gesture;
      g.node.x = Math.max(0, Math.min(2175, g.x + p[0] - g.start[0]));
      g.node.y = Math.max(0, Math.min(1465, g.y + p[1] - g.start[1]));
      g.el.style.left = g.node.x + "px";
      g.el.style.top = g.node.y + "px";
      const svg = $("svg", world);
      $$("g", svg).forEach((el) => el.remove());
      svg.insertAdjacentHTML(
        "beforeend",
        state.edges
          .filter(
            (edge) =>
              state.nodes.filter(inScope).some((n) => n.id === edge.from) &&
              state.nodes.filter(inScope).some((n) => n.id === edge.to),
          )
          .map(edgeSVG)
          .join(""),
      );
    } else if (gesture.kind === "pan") {
      viewport.scrollLeft = gesture.left + gesture.x - e.clientX;
      viewport.scrollTop = gesture.top + gesture.y - e.clientY;
    }
  };
  const end = (e) => {
    if (!gesture) return;
    const changed = gesture.kind !== "pan";
    gesture = null;
    if (world.hasPointerCapture(e.pointerId))
      world.releasePointerCapture(e.pointerId);
    if (changed) persist();
    renderBoardPreservingScroll();
  };
  world.onpointerup = end;
  world.onpointercancel = end;
  world.ondblclick = (e) => {
    if (tool === "select" && !e.target.closest("[data-node],[data-edge]")) {
      const r = world.getBoundingClientRect();
      addCard((e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom);
    }
  };
}
function deleteSelection() {
  if (!selected) return;
  checkpoint();
  if (selected.kind === "node") {
    state.nodes = state.nodes.filter((n) => n.id !== selected.id);
    state.edges = state.edges.filter(
      (e) => e.from !== selected.id && e.to !== selected.id,
    );
  }
  if (selected.kind === "edge")
    state.edges = state.edges.filter((e) => e.id !== selected.id);
  if (selected.kind === "stroke")
    state.strokes = state.strokes.filter((s) => s.id !== selected.id);
  selected = null;
  persist();
  renderBoardPreservingScroll();
}
function overviewHTML() {
  const files = state.files.filter(inScope),
    nodes = state.nodes.filter(inScope),
    ids = new Set(nodes.map((n) => n.id));
  return `<div class="stats"><div class="stat"><span>Files</span><b>${files.length}</b><small>${sizeOf(files.reduce((s, f) => s + f.size, 0))} in Google Drive</small></div><div class="stat"><span>Cards on board</span><b>${nodes.length}</b><small>Manually placed by you</small></div><div class="stat"><span>Relationships</span><b>${state.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).length}</b><small>Connections you have drawn</small></div><div class="stat"><span>Gallery photos</span><b>${files.filter(isPhoto).length}</b><small>From Google Drive</small></div></div><div class="overview-actions"><button class="overview-action" data-view="canvas"><b>↗ Draw the relationships</b><p>Arrange your work and link projects, teams, and files.</p></button><button class="overview-action" data-view="bom"><b>☷ Open the BOM</b><p>Search components and compare project parts lists.</p></button><button class="overview-action" data-view="gallery"><b>▧ Tell the story in photos</b><p>Build a gallery of assemblies, prototypes, and progress.</p></button></div><div class="panel"><div class="panel-head"><div><h2>A workspace you can take with you.</h2><p>Open the dashboard, organize Drive files, and connect them to your project work.</p></div><button class="secondary" data-action="storage">How storage works</button></div></div>`;
}
function fileRows(files) {
  return files
    .map(
      (f) =>
        `<tr><td><div class="file-title"><strong>${esc(f.name)}</strong><small>${esc(f.folderPath || f.note || nameOf(f.project))}</small></div></td><td>${esc(nameOf(f.project))}</td><td><span class="tag ${f.team.toLowerCase()}">${esc(teamLabel(f.project, f.team))}</span></td><td>${sizeOf(f.size)}</td><td><button class="text-button" data-download="${f.id}">↗ Open in Drive</button> <button class="text-button danger-text" data-remove-file="${f.id}">Remove from library</button></td></tr>`,
    )
    .join("");
}
function filteredFiles() {
  return state.files
    .filter(inScope)
    .filter(
      (f) =>
        (fileTeam === "all" || f.team === fileTeam) &&
        (f.name + " " + f.note + " " + f.folderPath + " " + f.team + " " + nameOf(f.project))
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
}
const empty = (symbol, title, description, action) =>
  `<div class="empty"><div class="empty-symbol">${symbol}</div><h3>${title}</h3><p>${description}</p>${action || ""}</div>`;
function filesHTML() {
  const files = filteredFiles();
  return `<section class="panel"><div class="panel-head"><div><h2>Your file library</h2><p>Drive-backed project files organized by project and team. The dashboard stores metadata and links, not large file contents.</p><p class="hint">${googleAccessToken ? (driveSyncing ? "Loading files from Google Drive…" : "Files are loaded from the configured Google Drive project folders.") : "Sign in with Google to load files from the project Drive folders."}</p></div><div class="row"><button class="secondary" data-action="refresh-drive" ${driveSyncing || !googleAccessToken ? "disabled" : ""}>↻ Refresh Drive</button><button class="primary" data-action="upload">＋ Add files</button></div></div><div class="section-tools"><input id="file-search" aria-label="Search files" placeholder="Search files, notes, projects…" value="${esc(search)}"><select id="team-filter" aria-label="Filter by team"><option value="all">All teams</option>${teamOptions(fileTeam)}</select></div>${files.length ? `<div class="table-scroll"><table><thead><tr><th>File name</th><th>Project</th><th>Team</th><th>Size</th><th>Access</th></tr></thead><tbody>${fileRows(files)}</tbody></table></div>` : empty("▱", "Your files go here.", googleAccessToken ? "No files were found in the configured Google Drive project folders." : "Sign in with Google to load your project files.", '<button class="secondary" data-action="upload">＋ Add files</button>')}<div class="table-footer">${files.length} Drive files · Metadata stored locally</div></section>`;
}
function galleryHTML() {
  const photos = state.files.filter(inScope).filter(isPhoto);
  return `<section class="panel"><div class="panel-head"><div><h2>Project photo gallery</h2><p>Photos loaded from the project Google Drive folders.</p></div><span class="pill">${photos.length} photos</span></div>${photos.length ? `<div class="tiles">${photos.map((f) => `<article class="photo"><button class="photo-image" data-photo="${f.id}" aria-label="View ${esc(f.name)}"><img data-local-image="${f.id}" alt="${esc(f.note || f.name)}"></button><div class="photo-info"><b>${esc(f.name)}</b><p>${esc(nameOf(f.project))} · ${esc(teamLabel(f.project, f.team))}</p><p>${esc(f.note)}</p><button class="text-button" data-download="${f.id}">↗ Open in Drive</button> <button class="text-button danger-text" data-remove-file="${f.id}">Remove from library</button></div></article>`).join("")}</div>` : empty("▧", "Show what you are building.", "Add photos of prototypes, assemblies, and team progress.", '<button class="secondary" data-action="photos">＋ Add photos</button>')}</section>`;
}
async function loadImages() {
  for (const img of $$("[data-local-image]")) {
    const url = await fileURL(img.dataset.localImage);
    if (url) img.src = url;
  }
}
function bomHTML() {
  const projects = scope === "all" ? state.projects : state.projects.filter((p) => p.id === scope);
  const files = projects.map((p) => state.files.find((f) => f.id === state.bom[p.id])).filter(Boolean);
  const hasSharedRows = sharedBOMRows.some((row) => scope === "all" || row.project_id === scope);
  return `<section class="panel"><div class="panel-head"><div><h2>Bill of materials</h2><p>${scope === "all" ? "Showing BOM rows across every project. Use the project selector above to narrow the workspace." : "Showing the selected project's components and source file."}</p></div><button class="secondary" data-action="add-bom-row">＋ Add component</button></div><div class="bom-bar"><div><strong>${hasSharedRows ? "Shared Supabase BOM connected" : files.length ? `${files.length} source file${files.length === 1 ? "" : "s"} connected` : "No BOM source selected"}</strong><small>${hasSharedRows ? "Approved rows are shared with authenticated workspace users." : files.length ? files.map((f) => `${esc(nameOf(f.project))} · ${esc(f.name)}`).join("  /  ") : "Choose a CSV source in Files to preview its rows here."}</small></div><div class="row">${files.map((f) => `<button class="text-button" data-download="${f.id}">↓ ${esc(nameOf(f.project))}</button>`).join("")}<button class="secondary" data-action="choose-bom">${files.length ? "Manage sources" : "Choose BOM file"}</button></div></div><div id="bom-preview">${files.length || hasSharedRows ? '<div class="empty"><p>Opening BOM…</p></div>' : empty("☷", "Keep the source easy to find.", "Add a BOM in Files, then choose it here. CSV files display as a searchable table.")}</div></section>`;
}
function addBOMRow() {
  openModal(
    "Add component",
    `<form id="bom-entry-form"><p class="hint" style="margin-bottom:18px">Add a planning row without changing the original CSV source. It will be saved in this browser and included in the BOM view.</p><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">ID<input name="id" placeholder="e.g. D01" required maxlength="40"></label></div><div class="form-grid"><label class="field">Subsystem<input name="subsystem" placeholder="Controls"></label><label class="field">Component<input name="component" placeholder="Component or integration purpose" required></label></div><div class="form-grid"><label class="field">Quantity<input name="qty" type="number" min="0" step="any" value="1"></label><label class="field">Unit cost ($)<input name="unit" type="number" min="0" step="0.01" placeholder="0.00"></label></div><div class="form-grid"><label class="field">Link<input name="link" type="url" placeholder="https://…"></label><label class="field">Cost basis<select name="basis"><option>Baseline</option><option>Quote</option><option>Estimate</option><option>Pending</option></select></label></div>${actions("Add component")}</form>`,
  );
  $("#bom-entry-form").onsubmit = (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    state.bomEntries = state.bomEntries || [];
    state.bomEntries.push({
      project: String(form.get("project")),
      team: "Shared",
      id: String(form.get("id")).trim(),
      subsystem: String(form.get("subsystem") || ""),
      component: String(form.get("component")).trim(),
      qty: String(form.get("qty") || "1"),
      unit: String(form.get("unit") || ""),
      ext: "",
      link: String(form.get("link") || ""),
      basis: String(form.get("basis") || "Baseline"),
    });
    persist();
    $("#dialog").close();
    render();
  };
}
function parseCSV(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
      if (rows.length > 10000)
        throw new Error("Preview supports up to 10,000 rows.");
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  return rows;
}
async function previewBOM() {
  const target = $("#bom-preview");
  if (!target) return;
  try {
    const projects = scope === "all" ? state.projects : state.projects.filter((p) => p.id === scope);
    const records = sharedBOMRows
      .filter((row) => scope === "all" || row.project_id === scope)
      .map((row) => ({
        project: row.project_id,
        team: "Shared",
        id: row.item_id,
        subsystem: row.subsystem,
        component: row.component,
        purpose: row.purpose || "",
        qty: String(row.quantity),
        unit: row.unit_cost == null ? "" : String(row.unit_cost),
        ext: row.extended_cost == null ? "" : String(row.extended_cost),
        link: row.supplier,
        basis: row.stage || row.cost_basis,
        source: row.source || "Supabase shared BOM",
      }));
    for (const project of projects) {
      const file = state.files.find((f) => f.id === state.bom[project.id]);
      if (!file || !/\.csv$/i.test(file.name) || file.size > 5 * 1024 * 1024) continue;
      const blob = (await getBlob(file.id)) || (await getDriveBlob(file));
      if (!blob) throw new Error("The source file is missing from this browser.");
      const rows = parseCSV((await blob.text()).replace(/^\uFEFF/, ""));
      const [head, ...body] = rows;
      if (!head) continue;
      const key = (name) => head.findIndex((h) => h.toLowerCase().replace(/[^a-z]/g, "").includes(name));
      body.forEach((row) => records.push({
        project: project.id,
        team: file.team,
        id: row[key("id")] || row[0] || "",
        subsystem: row[key("subsystem")] || "",
        component: row[key("component")] || row[key("description")] || row[1] || "",
        purpose: row[key("purpose")] || "",
        qty: row[key("qty")] || row[key("quantity")] || "1",
        unit: row[key("unitcost")] || row[key("unitprice")] || row[key("price")] || "",
        ext: row[key("ext")] || row[key("total")] || "",
        link:
          row[key("link")] ||
          row[key("url")] ||
          row[key("website")] ||
          row[key("supplier")] ||
          row[key("vendor")] ||
          "",
        basis: row[key("basis")] || row[key("stage")] || "",
        source: file.name,
      }));
    }
    records.push(...(state.bomEntries || []).filter((entry) => scope === "all" || entry.project === scope).map((entry) => ({ ...entry, link: entry.link || entry.supplier || "", purpose: entry.purpose || "", source: "Added in workspace" })));
    if (!records.length) {
      target.innerHTML = empty("☷", "No previewable BOM rows.", "CSV files up to 5 MB can be searched here. Other source types remain available to download.");
      return;
    }
    const values = (field) => [...new Set(records.map((r) => r[field]).filter(Boolean))].sort();
    const money = (value) => Number(String(value).replace(/[^0-9.-]/g, "")) || 0;
    target.innerHTML = `<div class="section-tools bom-tools"><input id="bom-search" placeholder="Search ID, component, link…" aria-label="Search BOM" value="${esc(bomSearch)}"><select id="bom-team" aria-label="Filter by team"><option value="all">All teams</option>${values("team").map((v) => `<option ${bomTeam === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><select id="bom-stage" aria-label="Filter by stage"><option value="all">All stages</option>${values("basis").map((v) => `<option ${bomStage === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><select id="bom-price" aria-label="Filter by price"><option value="all">All pricing</option><option value="priced" ${bomPrice === "priced" ? "selected" : ""}>Priced only</option><option value="unpriced" ${bomPrice === "unpriced" ? "selected" : ""}>Needs pricing</option></select></div><div class="bom-stats" id="bom-stats"></div><div class="table-scroll"><table><thead><tr><th>ID</th><th>Project</th><th>Subsystem</th><th>Component / integration purpose</th><th>Qty</th><th>Unit $</th><th>Ext $</th><th>Link</th><th>Cost basis</th></tr></thead><tbody id="bom-rows"></tbody></table></div><div class="table-footer" id="bom-count"></div>`;
    const draw = () => {
      const query = bomSearch.toLowerCase();
      const list = records.filter((r) => {
        const searchable = Object.values(r).join(" ").toLowerCase();
        return searchable.includes(query) && (bomTeam === "all" || r.team === bomTeam) && (bomStage === "all" || r.basis === bomStage) && (bomPrice === "all" || (bomPrice === "priced" ? money(r.unit) > 0 : money(r.unit) === 0));
      });
      const total = list.reduce((sum, r) => sum + money(r.ext || money(r.unit) * (Number(r.qty) || 1)), 0);
      $("#bom-stats").innerHTML = `<div class="stat"><span>Visible lines</span><b>${list.length}</b><small>of ${records.length} total rows</small></div><div class="stat"><span>Visible priced sum</span><b>$${total.toFixed(2)}</b><small>Extended cost where available</small></div><div class="stat"><span>Needs pricing</span><b>${list.filter((r) => !money(r.unit)).length}</b><small>Rows without a unit price</small></div>`;
      $("#bom-rows").innerHTML = list.map((r) => `<tr><td><strong>${esc(r.id)}</strong></td><td>${esc(nameOf(r.project))}<small>${esc(r.source)}</small></td><td>${esc(r.subsystem)}</td><td><strong>${esc(r.component)}</strong>${r.purpose ? `<small>${esc(r.purpose)}</small>` : ""}</td><td>${esc(r.qty)}</td><td>${r.unit ? "$" + money(r.unit).toFixed(2) : "—"}</td><td>${r.ext ? "$" + money(r.ext).toFixed(2) : "—"}</td><td>${bomLinkHTML(r.link)}</td><td>${esc(r.basis || "—")}</td></tr>`).join("");
      $("#bom-count").textContent = `${list.length} visible line items · ${records.length} total rows`;
    };
    draw();
    $("#bom-search").oninput = (e) => { bomSearch = e.target.value; draw(); };
    $("#bom-team").onchange = (e) => { bomTeam = e.target.value; draw(); };
    $("#bom-stage").onchange = (e) => { bomStage = e.target.value; draw(); };
    $("#bom-price").onchange = (e) => { bomPrice = e.target.value; draw(); };
  } catch (error) {
    target.innerHTML = empty(
      "☷",
      "Could not preview this BOM.",
      esc(error.message),
    );
  }
}
function chooseBOM() {
  const project = currentProject();
  const files = state.files.filter((f) => f.project === project);
  if (!files.length) {
    notify("Add a BOM file to this project first.");
    showUpload();
    return;
  }
  openModal(
    "Choose the BOM source",
    `<form id="bom-form"><p class="hint" style="margin-bottom:18px">Select the source file for ${esc(nameOf(project))}. No BOM data is invented or imported automatically.</p><label class="field">Source file<select name="file" required><option value="">Choose a file…</option>${files.map((f) => `<option value="${f.id}" ${state.bom[project] === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>${actions("Set BOM source")}</form>`,
  );
  $("#bom-form").onsubmit = (e) => {
    e.preventDefault();
    state.bom[project] = String(new FormData(e.target).get("file"));
    persist();
    $("#dialog").close();
    render();
  };
}
function resourcesHTML() {
  const links = [...knownResources, ...state.resources].filter(inScope);
  return `<section class="panel"><div class="panel-head"><div><h2>Repositories & links</h2><p>Open project Google Drive folders and GitHub repositories as needed. Upload shared files to Drive; move them to GitHub separately when needed.</p></div></div><div class="resource-grid">${links.map((r) => `<a class="resource" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"><div><b>${esc(r.title)}</b><small>${esc(nameOf(r.project))} ·${esc(r.team)}</small></div><span>↗</span></a>`).join("")}</div>${!links.length ? empty("↗", "Connect your project.", "Add a repository, folder, or reference link.") : ""}</section>`;
}
function resourceForm() {
  openModal(
    "Add a resource",
    `<form id="resource-form"><p class="hint" style="margin-bottom:14px">Add a Google Drive folder, GitHub repository, or other project reference.</p><label class="field">Title<input name="title" required maxlength="100"></label><label class="field">HTTPS address<input name="url" type="url" required placeholder="https://…" maxlength="2000"></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions("Shared")}</select></label></div>${actions("Add resource")}</form>`,
  );
  $("#resource-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      url = String(f.get("url"));
    try {
      if (new URL(url).protocol !== "https:") throw new Error();
    } catch {
      notify("Use a full https:// address.");
      return;
    }
    state.resources.push({
      id: uid(),
      title: String(f.get("title")),
      url,
      project: String(f.get("project")),
      team: String(f.get("team")),
    });
    persist();
    $("#dialog").close();
    render();
  };
}

// Upload a file through a new branch and pull request.
function githubForm() {
  const repos = [...knownResources, ...state.resources].filter((r) =>
    r.url.startsWith("https://github.com/"),
  );
  openModal(
    "Upload to GitHub",
    `<p class="hint" style="margin-bottom:16px">The dashboard will create a branch and open a pull request, so protected default branches remain protected.</p><form id="github-form"><label class="field">Repository<select name="repo">${repos.map((r, index) => `<option value="${esc(r.url)}" ${index === 0 ? "selected" : ""}>${esc(r.title)} (${esc(r.url.replace("https://github.com/", ""))})</option>`).join("")}</select></label><label class="field">Folder path<input name="folder" value="uploads" placeholder="e.g. uploads or docs/drawings" pattern="[a-zA-Z0-9_./ -]*"><small>Leave empty for the repository root.</small></label><label class="field">Select file to push<input type="file" name="ghfile" required></label>${actions("Open pull request ↗")}</form>`,
  );
  $("#github-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      repoUrl = String(f.get("repo")),
      folder = String(f.get("folder") || "").trim(),
      file = e.target.elements.ghfile.files[0];
    if (!file) return;
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
      notify("Invalid GitHub repository URL.");
      return;
    }
    const [, owner, repo] = match;
    const btn = $("[type=submit]", e.target);
    btn.disabled = true;
    btn.textContent = "Creating pull request…";
    try {
      const pullRequest = await pushFileToGitHub(file, owner, repo, folder);
      $("#dialog").close();
      notify(`Pull request opened for ${file.name}: ${pullRequest.html_url}`);
    } catch (err) {
      notify("GitHub upload failed: " + err.message);
      btn.disabled = false;
      btn.textContent = "Open pull request ↗";
    }
  };
}

async function exportBackup() {
  notify("Preparing a backup with your files…");
  await saving;
  try {
    const blobs = [];
    for (const f of state.files) {
      const blob = await getBlob(f.id);
      if (!blob) continue;
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      blobs.push({ id: f.id, type: f.type, data: base64 });
    }
    download(
      new Blob(
        [
          JSON.stringify({
            format: "exo-html-backup",
            version: 1,
            exported: new Date().toISOString(),
            state,
            blobs,
          }),
        ],
        { type: "application/json" },
      ),
      "exo-workspace-backup-" + new Date().toISOString().slice(0, 10) + ".json",
    );
    notify(
      blobs.length === state.files.length
        ? "Backup exported. It includes your files and drawings."
        : "Backup exported. Drive-backed files are included as metadata and links.",
    );
  } catch (error) {
    notify("Backup could not be completed: " + error.message);
  }
}
function validateBackup(data) {
  if (
    data?.format !== "exo-html-backup" ||
    data.version !== 1 ||
    !data.state ||
    !Array.isArray(data.blobs)
  )
    throw new Error("Not an EXO HTML backup.");
  const s = data.state;
  if (
    !["projects", "files", "nodes", "edges", "strokes", "resources"].every(
      (k) => Array.isArray(s[k]),
    ) ||
    !s.projects.length ||
    !s.bom ||
    typeof s.bom !== "object"
  )
    throw new Error("Backup structure is incomplete.");
  const str = (v, max = 2000) => typeof v === "string" && v.length <= max;
  const validId = (v) => str(v, 100) && /^[a-zA-Z0-9_-]+$/.test(v);
  for (const group of [
    "projects",
    "files",
    "nodes",
    "edges",
    "strokes",
    "resources",
  ])
    if (
      new Set(s[group].map((x) => x.id)).size !== s[group].length ||
      s[group].some((x) => !validId(x.id))
    )
      throw new Error("Invalid or duplicate record identifiers.");
  const projects = new Set(s.projects.map((x) => x.id)),
    files = new Set(s.files.map((x) => x.id)),
    nodes = new Set(s.nodes.map((x) => x.id));
  for (const p of s.projects)
    if (!str(p.name, 80) || !str(p.description, 500))
      throw new Error("Invalid project.");
  for (const f of s.files)
    if (
      !projects.has(f.project) ||
      !str(f.name, 250) ||
      !str(f.type, 100) ||
      !str(f.note, 1000) ||
      !teams.includes(f.team) ||
      !Number.isFinite(f.size) ||
      f.size <= 0 ||
      (f.driveId && !str(f.driveId, 200))
    )
      throw new Error("Invalid file metadata.");
  for (const n of s.nodes)
    if (
      !projects.has(n.project) ||
      !str(n.title, 120) ||
      !str(n.owner, 100) ||
      !str(n.note) ||
      !teams.includes(n.team) ||
      !["Not started", "In progress", "Blocked", "Complete"].includes(
        n.status,
      ) ||
      ![n.x, n.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 2400) ||
      !Array.isArray(n.files) ||
      n.files.some((id) => !files.has(id))
    )
      throw new Error("Invalid drawing card.");
  for (const e of s.edges)
    if (
      !nodes.has(e.from) ||
      !nodes.has(e.to) ||
      !str(e.label, 100) ||
      !str(e.note, 1500)
    )
      throw new Error("Invalid relationship.");
  for (const p of s.strokes)
    if (
      !projects.has(p.project) ||
      !/^#[0-9a-f]{6}$/i.test(p.color) ||
      !Array.isArray(p.points) ||
      p.points.length > 12000 ||
      p.points.some(
        (v) =>
          !Array.isArray(v) ||
          v.length !== 2 ||
          !v.every((x) => Number.isFinite(x) && Math.abs(x) < 10000),
      )
    )
      throw new Error("Invalid pen stroke.");
  for (const r of s.resources)
    if (
      !projects.has(r.project) ||
      !str(r.title, 100) ||
      !teams.includes(r.team) ||
      !str(r.url, 2000) ||
      new URL(r.url).protocol !== "https:"
    )
      throw new Error("Invalid resource link.");
  for (const [project, id] of Object.entries(s.bom))
    if (
      !projects.has(project) ||
      !files.has(id) ||
      s.files.find((f) => f.id === id)?.project !== project
    )
      throw new Error("Invalid BOM reference.");
  if (new Set(data.blobs.map((b) => b.id)).size !== data.blobs.length)
    throw new Error("The backup contains duplicate file data.");
  if (data.blobs.some((b) => !files.has(b.id)))
    throw new Error("The backup contains data for an unknown file.");
  return s;
}
async function importBackup(file) {
  if (!file) return;
  try {
    if (file.size > 200 * 1024 * 1024)
      throw new Error(
        "Backup is larger than the 200 MB prototype import limit.",
      );
    const data = JSON.parse(await file.text()),
      next = validateBackup(data),
      blobs = [];
    for (const b of data.blobs) {
      const meta = next.files.find((f) => f.id === b.id);
      if (!meta || typeof b.data !== "string")
        throw new Error("File data is incomplete.");
      const raw = atob(b.data),
        bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      if (bytes.length !== meta.size)
        throw new Error("File size does not match: " + meta.name);
      blobs.push({ id: b.id, blob: new Blob([bytes], { type: meta.type }) });
    }
    if (
      !confirm(
        "Replace the current local workspace with this backup? Export your current work first if you want to keep it.",
      )
    )
      return;
    if (!db) throw new Error("Local browser storage is unavailable.");
    await saving;
    await writeStores(next, blobs, true);
    for (const [key, url] of urls)
      if (!key.startsWith("blob-")) URL.revokeObjectURL(url);
    urls.clear();
    state = next;
    scope = "all";
    selected = null;
    connectFrom = null;
    history = [];
    render();
    notify("Backup imported, including files and drawings.");
    $("#dialog").close();
  } catch (error) {
    notify("Import failed: " + error.message);
  }
}
function render() {
  const labels = {
    overview: [
      "The whole project, at a glance.",
      "Files, drawings, and references in one local workspace.",
      "＋ Add files",
    ],
    canvas: [
      "Your ideas. Your connections.",
      "Draw freely, place cards, and connect work across teams and projects.",
      "＋ Add card",
    ],
    files: [
      "Project files.",
      "Add files once. Reference them anywhere on the drawing board.",
      "↑ Add files",
    ],
    bom: [
      "One place for the parts list.",
      "Search, filter, and compare components across every project.",
      "↑ Add BOM file",
    ],
    gallery: [
      "A closer look at the work.",
      "Keep your actual project photos together, with notes and context.",
      "＋ Add photos",
    ],
    resources: [
      "Your project, connected.",
      "Open the tools, repositories, and folders your team uses.",
      "＋ Add resource",
    ],
  };
  $("#page-title").textContent = labels[view][0];
  $("#page-description").textContent = labels[view][1];
  $("#page-action").textContent = labels[view][2];
  $("#eyebrow").textContent =
    (scope === "all" ? "ALL PROJECTS" : nameOf(scope).toUpperCase()) +
    " / " +
    (view === "canvas"
      ? "DRAWING BOARD"
      : view === "resources"
        ? "REPOSITORIES & LINKS"
        : view.toUpperCase());
  $("#crumb").textContent =
    scope === "all" ? "All projects" : `${nameOf(scope)} / ${view}`;
  $("#project-context").innerHTML =
    `<option value="all" ${scope === "all" ? "selected" : ""}>All projects</option>` +
    state.projects
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${scope === p.id ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join("") +
    `<option value="__new-project__">＋ Add new project</option>`;
  $("#project-context").onchange = (e) => {
    if (e.target.value === "__new-project__") {
      e.target.value = scope;
      projectForm();
      return;
    }
    scope = e.target.value;
    selected = null;
    connectFrom = null;
    search = "";
    fileTeam = "all";
    bomSearch = "";
    bomTeam = "all";
    bomStage = "all";
    bomPrice = "all";
    render();
  };
  $$("#nav .nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view),
  );
  $("#view").innerHTML =
    view === "canvas"
      ? boardHTML()
      : view === "overview"
        ? overviewHTML()
        : view === "files"
          ? filesHTML()
          : view === "gallery"
            ? galleryHTML()
            : view === "bom"
              ? bomHTML()
              : resourcesHTML();
  if (view === "canvas") {
    bindBoard();
    renderInspector();
  }
  if (view === "gallery") loadImages();
  if (view === "bom") previewBOM();
  if (view === "files") {
    $("#file-search").oninput = (e) => {
      search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      $("#file-search").focus();
      $("#file-search").setSelectionRange(pos, pos);
    };
    $("#team-filter").onchange = (e) => {
      fileTeam = e.target.value;
      render();
    };
  }
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button,a");
  if (!el) return;
  if (el.dataset.view) {
    view = el.dataset.view;
    selected = null;
    render();
    if (view === "files") {
      syncDriveFiles().catch((error) => {
        driveSyncing = false;
        notify("Google Drive files could not be synchronized: " + error.message);
        render();
      });
    }
  }
  if (el.dataset.project) {
    scope = el.dataset.project;
    selected = null;
    connectFrom = null;
    search = "";
    fileTeam = "all";
    bomSearch = "";
    bomTeam = "all";
    bomStage = "all";
    bomPrice = "all";
    render();
  }
  if (el.dataset.tool) {
    tool = el.dataset.tool;
    connectFrom = null;
    renderBoardPreservingScroll();
  }
  if (el.dataset.download) {
    e.preventDefault();
    downloadFile(el.dataset.download);
  }
  if (el.dataset.removeFile) {
    e.preventDefault();
    await removeLocalFile(el.dataset.removeFile);
    return;
  }
  if (el.dataset.selectEdge) {
    selected = { kind: "edge", id: el.dataset.selectEdge };
    renderBoardPreservingScroll();
  }
  if (el.dataset.unlink && selected?.kind === "node") {
    checkpoint();
    const n = state.nodes.find((n) => n.id === selected.id);
    n.files = n.files.filter((id) => id !== el.dataset.unlink);
    persist();
    renderBoardPreservingScroll();
  }
  if (el.dataset.photo) {
    const f = state.files.find((f) => f.id === el.dataset.photo),
      url = await fileURL(f.id);
    openModal(
      f.name,
      `<img src="${esc(url)}" alt="${esc(f.note || f.name)}" style="width:100%;max-height:68vh;object-fit:contain"><p class="hint" style="margin-top:15px">${esc(nameOf(f.project))} · ${esc(f.team)} · ${esc(f.note)}</p>`,
    );
    $("#dialog").classList.add("lightbox");
  }
  if (el.hasAttribute("data-close")) $("#dialog").close();
  const action = el.dataset.action;
  if (action === "login") signInWithGoogle();
  if (action === "refresh-drive") {
    syncDriveFiles().catch((error) => {
      driveSyncing = false;
      notify("Google Drive files could not be synchronized: " + error.message);
      render();
    });
  }
  if (action === "upload") showDriveTestUpload();
  if (action === "photos") showUpload(true);
  if (action === "storage") showStorage();
  if (action === "export") exportBackup();
  if (action === "import") $("#backup-input").click();
  if (action === "undo") undo();
  if (action === "delete-selection") deleteSelection();
  if (action === "choose-bom") chooseBOM();
  if (action === "add-bom-row") addBOMRow();
  if (action === "zoom-in" || action === "zoom-out") {
    zoom = Math.max(
      0.4,
      Math.min(
        1.6,
        Math.round((zoom + (action === "zoom-in" ? 0.1 : -0.1)) * 10) / 10,
      ),
    );
    renderBoardPreservingScroll();
  }
});
$("#page-action").onclick = () =>
  view === "canvas"
    ? centerCard()
    : view === "gallery"
      ? showUpload(true)
      : view === "resources"
        ? resourceForm()
        : view === "bom"
          ? showUpload()
          : showDriveTestUpload();
$("#close-dialog").onclick = () => $("#dialog").close();
$("#dialog").onclick = (e) => {
  if (e.target === $("#dialog")) $("#dialog").close();
};
$("#backup-input").onchange = (e) => {
  importBackup(e.target.files[0]);
  e.target.value = "";
};
document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $("#dialog").open)
    return;
  if (view !== "canvas") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === "Escape") {
    selected = null;
    connectFrom = null;
    renderBoardPreservingScroll();
  } else {
    const map = { v: "select", p: "pen", c: "connect", h: "hand" };
    if (map[e.key.toLowerCase()]) {
      tool = map[e.key.toLowerCase()];
      connectFrom = null;
      renderBoardPreservingScroll();
    }
  }
});
window.addEventListener("beforeunload", (e) => {
  if (gesture) {
    e.preventDefault();
    e.returnValue = "";
  }
});
(async () => {
  try {
    db = await openDB();
    state = (await record("state", "workspace")) || initial();
    storageAvailable = true;
    $("#save-status").textContent = "Saved in this browser";
  } catch (error) {
    $("#save-status").textContent = "Storage unavailable";
    warn(
      "This browser has blocked local storage. Drawing can be explored, but files cannot be saved. Use a regular browser window with local storage enabled.",
    );
  }
  await checkUserSession();
  render();
})();
