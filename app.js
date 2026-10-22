"use strict";

// ==========================================
// 1. GOOGLE & SUPABASE CONFIGURATION
// ==========================================
const SUPABASE_URL = "https://tnupwlucufewosslvcaz.supabase.co";
const BUILD_VERSION = "1.0.5";
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

const ROOT_DRIVE_FOLDER_ID = "1kldWFbtd0S_Mr8zsrYBCrYiGJsc1zhl_";
const ROOT_DRIVE_FOLDER_NAME = "Projects-Testing-Folder";
const DRAWING_BACKUPS_FOLDER_NAME = "drawing-backups";
const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
let googleAccessToken = sessionStorage.getItem("google_provider_token");
let sharedBOMRows = [];
let driveFolders = [];
let driveTokenExpired = false;
let tldrawRoot = null;
let tldrawImportPromise = null;
let tldrawRenderToken = 0;
let tldrawEditor = null;
let tldrawEditorProjectId = null;
const migratedPageIds = new Map();
let tldrawUnlisten = null;
let workspaceChannel = null;
let tldrawChannel = null;
let applyingTldrawSnapshot = false;
let tldrawPersistTimer = null;
let tldrawViewPersistTimer = null;
let currentUserId = null;
const registeredProjectIds = new Set();
let tldrawLastCameraPageId = null;
let tldrawLastCamera = null;
let workspaceLoaded = false;
let remoteTldrawPointers = new Map();
let pointerBroadcastFrame = null;
let localPointer = null;
let tldrawPointerName = "Collaborator";
const tldrawClientId =
  globalThis.crypto?.randomUUID?.() ||
  `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const tldrawPointerColors = [
  "#e45756",
  "#3a86ff",
  "#8338ec",
  "#fb8500",
  "#2a9d8f",
  "#d63384",
  "#6f42c1",
  "#198754",
];
const tldrawPointerColor =
  tldrawPointerColors[
    Math.floor(Math.random() * tldrawPointerColors.length)
  ];
const tldrawPointerHue = Math.floor(Math.random() * 360);
const tldrawInstanceRecordTypes = new Set([
  "camera",
  "instance",
  "instance_page_state",
  "pointer",
]);

function setBuildVersion(version) {
  const element = document.querySelector("#build-version");
  if (element) element.textContent = `v${version}`;
}

async function checkForAppUpdate() {
  setBuildVersion(BUILD_VERSION);
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Version check failed (HTTP ${response.status})`);
    }
    const payload = await response.json();
    const serverVersion = String(payload?.version || "").trim();
    if (!serverVersion) throw new Error("Version check returned no version.");
    setBuildVersion(serverVersion);

    const loadedVersion = localStorage.getItem("app_version");
    if (!loadedVersion) {
      localStorage.setItem("app_version", serverVersion);
      return true;
    }
    if (loadedVersion === serverVersion) return true;

    localStorage.setItem("app_version", serverVersion);
    const url = new URL(window.location.href);
    url.searchParams.set("v", serverVersion);
    window.location.replace(url.toString());
    return false;
  } catch (error) {
    warn("Could not check for a newer app version. " + error.message);
    return true;
  }
}

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
        scopes: "https://www.googleapis.com/auth/drive",
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
  sharedBOMRows = (data || []).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "string" ? cleanImportedText(value) : value,
      ]),
    ),
  );
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
    currentUserId = session.user.id;
    const metadata = session.user?.user_metadata || {};
    tldrawPointerName = firstName(
      metadata.full_name ||
        metadata.name ||
        metadata.user_name ||
        session.user?.email,
    );
    googleAccessToken = session.provider_token || sessionStorage.getItem("google_provider_token");
    if (session.provider_token) {
      sessionStorage.setItem("google_provider_token", session.provider_token);
      driveTokenExpired = false;
    }
    if (loginBtn) loginBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-flex";
    await ensureMemberProfile(session.user);
    await loadSharedBOM();
    try {
      if (googleAccessToken && workspaceLoaded) await syncDriveFiles();
    } catch (error) {
      driveSyncing = false;
      if (!isDriveAuthorizationError(error)) {
        notify("Google Drive files could not be synchronized: " + error.message);
      }
    }
  } else {
    currentUserId = null;
    tldrawPointerName = "Collaborator";
    googleAccessToken = null;
    sessionStorage.removeItem("google_provider_token");
    driveTokenExpired = false;
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
  if (event === "SIGNED_OUT") {
    googleAccessToken = null;
    sessionStorage.removeItem("google_provider_token");
    driveTokenExpired = false;
  } else if (session?.provider_token) {
    googleAccessToken = session.provider_token;
    sessionStorage.setItem("google_provider_token", session.provider_token);
    driveTokenExpired = false;
  }
  checkUserSession().catch((error) => notify("Could not update your session: " + error.message));
});

class DriveAuthorizationError extends Error {
  constructor(message = "Your Google Drive connection expired. Reconnect Google Drive.") {
    super(message);
    this.name = "DriveAuthorizationError";
  }
}

function isDriveAuthorizationError(error) {
  return error instanceof DriveAuthorizationError;
}

function setSidebarCollapsed(collapsed) {
  const app = $(".app");
  const toggle = $("#sidebar-toggle");
  if (!app || !toggle) return;
  app.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute(
    "aria-label",
    collapsed ? "Show navigation" : "Hide navigation",
  );
  toggle.title = "Click to toggle navigation";
}

async function fetchDriveAPI(url, options = {}) {
  googleAccessToken = sessionStorage.getItem("google_provider_token");
  if (!googleAccessToken) throw new DriveAuthorizationError("Reconnect Google Drive to continue.");
  options.headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${googleAccessToken}`,
  };
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${googleAccessToken}`, ...(options.headers || {}) },
  });
  if (response.status === 401) {
    googleAccessToken = null;
    sessionStorage.removeItem("google_provider_token");
    driveTokenExpired = true;
    driveExplorerError = "Your Google Drive connection expired.";
    if (view === "files") render();
    throw new DriveAuthorizationError();
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error?.message || `Google Drive request failed (HTTP ${response.status})`);
  }
  return response;
}

async function listDriveFiles(folderId = ROOT_DRIVE_FOLDER_ID, signal) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false`,
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "files(id,name,mimeType,webViewLink,webContentLink,iconLink,thumbnailLink,modifiedTime,size)",
  });
  return (
    await (
      await fetchDriveAPI(`https://www.googleapis.com/drive/v3/files?${params}`, {
        signal,
      })
    ).json()
  ).files || [];
}

async function uploadFileToDrive(file, folderId) {
  const metadata = { name: file.name, mimeType: file.type || "application/octet-stream", parents: [folderId] };
  const body = new FormData();
  body.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.append("file", file);
  return (await (await fetchDriveAPI("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,webContentLink,modifiedTime,size", { method: "POST", body })).json());
}

async function createSubfolder(folderName, parentFolderId) {
  return (await (await fetchDriveAPI("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: folderName, mimeType: GOOGLE_DRIVE_FOLDER_MIME, parents: [parentFolderId] }) })).json());
}

async function uploadFileToGoogleDrive(file, folderId) {
  return uploadFileToDrive(file, folderId || ROOT_DRIVE_FOLDER_ID);
}

async function projectDriveFolder(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project?.driveFolderId) {
    throw new Error(
      `Project "${project?.name || projectId}" is not linked to a Drive folder.`,
    );
  }
  return project.driveFolderId;
}

async function boardBackupsFolder(projectId) {
  const projectFolderId = await projectDriveFolder(projectId);
  let folders;
  try {
    folders = await listDriveFiles(projectFolderId);
  } catch (error) {
    throw new Error(
      "Google Drive cannot access the project's drawing backup folder. " +
        "Confirm the signed-in account has access, then reconnect Google Drive. " +
        `(${error.message})`,
    );
  }
  const existing = folders.find(
    (file) =>
      file.mimeType === GOOGLE_DRIVE_FOLDER_MIME &&
      file.name === DRAWING_BACKUPS_FOLDER_NAME,
  );
  if (existing) return existing.id;
  return (
    await createSubfolder(DRAWING_BACKUPS_FOLDER_NAME, projectFolderId)
  ).id;
}

function boardBackupSnapshot(projectId) {
  const snapshot =
    state.projectDrawings?.[projectId]?.document ??
    state.projectDrawings?.[projectId];
  if (!snapshot || typeof snapshot.store !== "object") return null;
  return snapshot;
}

function driveFolderName(value, fallback) {
  const name = String(value || fallback)
    .replace(/[\\/:*?"<>|#%{}[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return name || fallback;
}

async function findOrCreateDriveFolder(name, parentId) {
  const folders = await listDriveFiles(parentId);
  const existing = folders.find(
    (file) =>
      file.mimeType === GOOGLE_DRIVE_FOLDER_MIME &&
      file.name === name,
  );
  if (existing) return existing.id;
  return (await createSubfolder(name, parentId)).id;
}

function boardPages(snapshot) {
  return Object.values(snapshot.store || {}).filter(
    (record) => record.typeName === "page",
  );
}

function pageBackupFolderName(page) {
  return driveFolderName(`${page.name} [${page.id}]`, page.id);
}

function pageSnapshot(snapshot, page) {
  const records = Object.values(snapshot.store || {}).filter(
    (record) => !tldrawInstanceRecordTypes.has(record.typeName),
  );
  const included = new Set([page.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (included.has(record.parentId) && !included.has(record.id)) {
        included.add(record.id);
        changed = true;
      }
    }
  }
  const pageRecords = records.filter((record) => included.has(record.id));
  const assetIds = new Set();
  for (const record of pageRecords) {
    const assetId = record.typeName === "shape" ? record.props?.assetId : null;
    if (assetId) assetIds.add(assetId);
  }
  pageRecords.push(
    ...records.filter(
      (record) => record.typeName === "asset" && assetIds.has(record.id),
    ),
  );
  return { store: Object.fromEntries(pageRecords.map((record) => [record.id, record])) };
}

function replacePageInSnapshot(currentSnapshot, incomingSnapshot, pageId) {
  const currentRecords = Object.values(currentSnapshot?.store || {});
  const incomingRecords = Object.values(incomingSnapshot?.store || {});
  const incomingPage = incomingRecords.find(
    (record) => record.typeName === "page" && record.id === pageId,
  );
  if (!incomingPage) {
    throw new Error("The backup does not contain the requested page.");
  }
  const removedIds = new Set([pageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of currentRecords) {
      if (removedIds.has(record.parentId) && !removedIds.has(record.id)) {
        removedIds.add(record.id);
        changed = true;
      }
    }
  }
  const removedAssetIds = new Set(
    currentRecords
      .filter(
        (record) =>
          removedIds.has(record.id) &&
          record.typeName === "shape" &&
          record.props?.assetId,
      )
      .map((record) => record.props.assetId),
  );
  for (const record of currentRecords) {
    if (record.typeName === "asset" && removedAssetIds.has(record.id)) {
      removedIds.add(record.id);
    }
  }
  return {
    store: Object.fromEntries([
      ...currentRecords
        .filter((record) => !removedIds.has(record.id))
        .map((record) => [record.id, record]),
      ...incomingRecords.map((record) => [record.id, record]),
    ]),
  };
}

function dataUrlFile(dataUrl, name, fallbackType) {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mimeType = match[1] || fallbackType || "application/octet-stream";
  const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = match[2]
    ? Uint8Array.from(raw, (character) => character.charCodeAt(0))
    : new TextEncoder().encode(raw);
  return new File([bytes], name, { type: mimeType });
}

function boardBackupHasShapes(snapshot) {
  return Object.values(snapshot.store || {}).some(
    (record) => record.typeName === "shape",
  );
}

async function backupBoardToDrive(projectId) {
  if (!googleAccessToken) return "skipped: no Google Drive token";
  const snapshot = boardBackupSnapshot(projectId);
  if (!snapshot || !boardBackupHasShapes(snapshot)) {
    return "skipped: board has no shapes";
  }
  const backupRootId = await boardBackupsFolder(projectId);
  const project = state.projects.find((item) => item.id === projectId);
  const pages = boardPages(snapshot);
  if (!pages.length) return "skipped: board has no pages";
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const manifest = {
    type: "exo-tldraw-project-backup",
    version: 2,
    projectId,
    projectName: project?.name || projectId,
    savedAt: new Date().toISOString(),
    tldraw: "3.15.6",
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      folderName: pageBackupFolderName(page),
    })),
  };
  const manifestFile = new File(
    [JSON.stringify(manifest, null, 2)],
    `project-backup_${projectId}_${timestamp}.json`,
    { type: "application/json" },
  );
  await uploadFileToDrive(manifestFile, backupRootId);
  for (const page of pages) {
    const pageFolderId = await findOrCreateDriveFolder(
      pageBackupFolderName(page),
      backupRootId,
    );
    const payload = {
      type: "exo-tldraw-page-backup",
      version: 2,
      projectId,
      projectName: project?.name || projectId,
      pageId: page.id,
      pageName: page.name,
      savedAt: new Date().toISOString(),
      tldraw: "3.15.6",
      snapshot: pageSnapshot(snapshot, page),
    };
    const assetRecords = Object.values(payload.snapshot.store).filter(
      (record) => record.typeName === "asset" && record.props?.src,
    );
    const assetFolderId = assetRecords.length
      ? await findOrCreateDriveFolder("assets", pageFolderId)
      : null;
    const archivedAssets = [];
    if (assetFolderId) {
      for (const asset of assetRecords) {
        const file = dataUrlFile(
          asset.props.src,
          `${asset.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${driveFolderName(asset.props.name, "asset")}`,
          asset.props.mimeType,
        );
        if (!file) continue;
        const uploaded = await uploadFileToDrive(file, assetFolderId);
        archivedAssets.push({
          assetId: asset.id,
          fileId: uploaded.id,
          name: file.name,
          mimeType: file.type,
        });
      }
    }
    payload.archivedAssets = archivedAssets;
    const file = new File(
      [JSON.stringify(payload, null, 2)],
      `page-backup_${projectId}_${page.id}_${timestamp}.json`,
      { type: "application/json" },
    );
    await uploadFileToDrive(file, pageFolderId);
  }
  return "saved";
}

async function backupAllBoardsToDrive() {
  const results = [];
  for (const project of state.projects) {
    try {
      results.push({
        project: project.name,
        result: await backupBoardToDrive(project.id),
      });
    } catch (error) {
      results.push({ project: project.name, result: `failed: ${error.message}` });
    }
  }
  return results;
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
  const response = await fetchDriveAPI(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,parents",
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
      orderBy: "folder,name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      fields:
        "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,parents)",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchDriveAPI(
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

function driveProjectId(folder, existingProjects) {
  const normalizedName = folder.name.trim().toLowerCase();
  const existing = existingProjects.find(
    (project) =>
      project.driveFolderId === folder.id ||
      project.name.trim().toLowerCase() === normalizedName,
  );
  return existing?.id || uid();
}

function driveTeamFromPath(path) {
  const firstFolder = String(path).split("/").filter(Boolean)[0]?.toLowerCase();
  if (firstFolder === "controls") return "Controls";
  if (firstFolder === "electrical") return "Electrical";
  if (firstFolder === "mechanical" || firstFolder === "cad") return "Mechanical";
  return "Shared";
}

function isDriveProjectFolder(folder) {
  return (
    folder.mimeType === GOOGLE_DRIVE_FOLDER_MIME &&
    !["board-backups", "drawing-backups"].includes(
      folder.name.trim().toLowerCase(),
    )
  );
}

async function syncDriveFiles() {
  if (!googleAccessToken || !workspaceLoaded) return;
  if (driveSyncing) return;
  driveSyncing = true;
  try {
    const driveFiles = [];
    const folders = [];
    const rootChildren = await listDriveChildren(ROOT_DRIVE_FOLDER_ID);
    const projectFolders = rootChildren.filter(isDriveProjectFolder);
    const previousProjects = state.projects;
    const projects = projectFolders.map((folder) => ({
      id: driveProjectId(folder, previousProjects),
      name: folder.name,
      description:
        previousProjects.find((project) => project.driveFolderId === folder.id)
          ?.description || "",
      driveFolderId: folder.id,
    }));
    const projectByFolderId = new Map(
      projects.map((project, index) => [projectFolders[index].id, project]),
    );
    for (const folder of projectFolders) {
      const project = projectByFolderId.get(folder.id);
      const walk = async (parentId, path) => {
        folders.push({
          id: parentId,
          project: project.id,
          team: driveTeamFromPath(path),
          path,
        });
        for (const file of await listDriveChildren(parentId)) {
          if (file.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
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
            project: project.id,
            team: driveTeamFromPath(path),
            folderId: parentId,
            folderPath: path,
            note: "",
            created: file.modifiedTime || new Date().toISOString(),
          });
        }
      };
      await walk(folder.id, "");
    }
    driveFolders = folders;
    const projectIds = new Set(projects.map((project) => project.id));
    const projectDrawings = Object.fromEntries(
      Object.entries(state.projectDrawings).filter(([id]) => projectIds.has(id)),
    );
    const projectUpdates = Object.fromEntries(
      Object.entries(state.projectUpdates).filter(([id]) => projectIds.has(id)),
    );
    state = normalizeWorkspaceState({
      ...state,
      projects,
      files: driveFiles,
      resources: state.resources.filter((resource) => projectIds.has(resource.project)),
      projectDrawings,
      projectUpdates,
      bom: Object.fromEntries(
        Object.entries(state.bom).filter(([id]) => projectIds.has(id)),
      ),
    });
    const nextScope = projectIds.has(scope) ? scope : projects[0]?.id || "";
    if (nextScope !== scope && view === "canvas") {
      disposeTldrawBoard();
    }
    scope = nextScope;
    for (const project of projects) await ensureProjectRecord(project);
    await persist();
    render();
  } finally {
    driveSyncing = false;
  }
}

// ==========================================
// 2. ORIGINAL EXO-DASHBOARD APPLICATION LOGIC
// ==========================================
const $ = (s, root = document) => root.querySelector(s),
  $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const startupOverlayClose = $("#close-startup-overlay");
if (startupOverlayClose) {
  startupOverlayClose.onclick = () => {
    $("#startup-overlay").hidden = true;
  };
}
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
  projects: [],
  files: [],
  projectDrawings: {},
  groupUpdates: [],
  projectUpdates: {},
  resources: [],
  bom: {},
  bomEntries: [],
});
function projectPageId(projectId, name, stable = false) {
  const slug = String(name || "page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "page";
  return `page:${projectId}_${stable ? slug : uid().replace(/[^a-zA-Z0-9]/g, "")}`;
}

function migrateProjectDrawings(projectDrawings) {
  const migrated = {};
  for (const [projectId, snapshot] of Object.entries(projectDrawings || {})) {
    const container = snapshot?.document ? snapshot.document : snapshot;
    const source = container?.store;
    if (!source || typeof source !== "object") {
      migrated[projectId] = snapshot;
      continue;
    }
    const records = Object.values(source).filter(
      (record) => !tldrawInstanceRecordTypes.has(record.typeName),
    );
    const pages = records.filter((record) => record.typeName === "page");
    const names = pages.map((page) => page.name);
    const uniqueNames = new Set(names).size === names.length;
    const pageIds = new Map(
      pages.map((page) => [
        page.id,
        projectPageId(projectId, page.name, uniqueNames),
      ]),
    );
    for (const [oldId, newId] of pageIds) {
      migratedPageIds.set(`${projectId}:${oldId}`, newId);
    }
    const remap = (value) =>
      typeof value === "string" && pageIds.has(value) ? pageIds.get(value) : value;
    const remapReferences = (value) => {
      if (Array.isArray(value)) return value.map(remapReferences);
      if (!value || typeof value !== "object") return remap(value);
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "id" ? item : remapReferences(item),
        ]),
      );
    };
    const migratedRecords = records.map((record) => {
      const next = remapReferences(record);
      next.meta = { ...(record.meta || {}) };
      if (record.typeName === "page") {
        next.id = remap(record.id);
        next.meta.projectId = projectId;
        if (
          next.name === "Main Architecture" ||
          next.name === "Controls Breakout Room"
        )
          next.name = next.name === "Main Architecture" ? "Controls" : "Electrical";
        if (next.name === "Electrical Breakout Room") next.name = "Mechanical";
      } else {
        if (next.parentId) next.parentId = remap(next.parentId);
        if (record.typeName === "shape") next.meta.projectId = projectId;
      }
      return next;
    });
    const byId = new Map(migratedRecords.map((record) => [record.id, record]));
    const pageFor = (record, visited = new Set()) => {
      if (!record || visited.has(record.id)) return null;
      visited.add(record.id);
      if (record.typeName === "page") return record.id;
      return record.parentId ? pageFor(byId.get(record.parentId), visited) : null;
    };
    const validShapes = migratedRecords.filter(
      (record) => record.typeName === "shape" && pageFor(record),
    );
    const validIds = new Set([
      ...migratedRecords
        .filter((record) => record.typeName === "page" || pageFor(record))
        .map((record) => record.id),
      ...validShapes.flatMap((shape) =>
        shape.props?.assetId ? [shape.props.assetId] : [],
      ),
    ]);
    const output = migratedRecords.filter(
      (record) => validIds.has(record.id) || record.typeName === "page",
    );
    const orphanCount = records.filter(
      (record) => record.typeName === "shape" && !pageFor(record),
    ).length;
    console.info(
      `[drawing migration] ${projectId}: pages ${pages.length}->${pages.length}, ` +
        `shapes ${records.filter((record) => record.typeName === "shape").length}->` +
        `${validShapes.length}, orphans dropped ${orphanCount}`,
    );
    const store = Object.fromEntries(output.map((record) => [record.id, record]));
    migrated[projectId] = snapshot?.document
      ? { ...snapshot, document: { ...snapshot.document, store } }
      : { ...snapshot, store };
  }
  if (Object.keys(projectDrawings || {}).length) {
    download(
      new Blob([JSON.stringify(projectDrawings, null, 2)], {
        type: "application/json",
      }),
      `exo-drawing-migration-backup_${new Date().toISOString().replace(/[.:]/g, "-")}.json`,
    );
  }
  return migrated;
}

async function remapSavedTldrawViews() {
  for (const [key, pageId] of migratedPageIds) {
    const separator = key.indexOf(":");
    const projectId = key.slice(0, separator);
    const oldPageId = key.slice(separator + 1);
    const { error } = await supabaseClient
      .from("board_view_state")
      .update({ page_id: pageId })
      .eq("project_id", projectId)
      .eq("page_id", oldPageId);
    if (error && error.code !== "42P01") {
      console.warn(`Could not migrate saved view for ${projectId}/${oldPageId}:`, error);
    }
  }
}
function normalizeWorkspaceState(data) {
  const next = { ...initial(), ...(data || {}) };
  delete next.nodes;
  delete next.edges;
  delete next.strokes;
  if (
    !next.projectDrawings ||
    typeof next.projectDrawings !== "object" ||
    Array.isArray(next.projectDrawings)
  ) {
    next.projectDrawings = {};
  }
  if (
    !next.projectUpdates ||
    typeof next.projectUpdates !== "object" ||
    Array.isArray(next.projectUpdates)
  ) {
    next.projectUpdates = {};
  }
  if (!Array.isArray(next.groupUpdates)) {
    next.groupUpdates = [];
  }
  if (next.tldrawSnapshot && !next.projectDrawings.exo) {
    next.projectDrawings.exo = next.tldrawSnapshot;
  }
  delete next.tldrawSnapshot;
  if (Number(next.drawingSchemaVersion || 0) < 2) {
    next.projectDrawings = migrateProjectDrawings(next.projectDrawings);
    next.drawingSchemaVersion = 2;
  }
  return next;
}
document.addEventListener("input", (event) => {
  if (event.target.id === "drive-search") {
    driveExplorerSearch = event.target.value;
    render();
    const input = $("#drive-search");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "drive-sort") {
    driveExplorerSort = event.target.value;
    render();
  }
});
const workspaceViews = new Set([
  "overview",
  "canvas",
  "files",
  "bom",
  "gallery",
  "resources",
]);
const viewHashNames = {
  overview: "overview",
  canvas: "drawing-board",
  files: "files",
  bom: "bom",
  gallery: "gallery",
  resources: "repos",
};
const hashViewNames = Object.fromEntries(
  Object.entries(viewHashNames).map(([viewName, hashName]) => [
    hashName,
    viewName,
  ]),
);
function viewFromLocation() {
  const hashView = hashViewNames[window.location.hash.slice(1).toLowerCase()];
  if (hashView) return hashView;
  const savedView = localStorage.getItem("exo_workspace_view");
  return workspaceViews.has(savedView) ? savedView : "overview";
}
function setView(viewName, updateHash = true) {
  if (!workspaceViews.has(viewName)) return;
  view = viewName;
  localStorage.setItem("exo_workspace_view", viewName);
  if (updateHash) {
    const hash = `#${viewHashNames[viewName]}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  }
}
let state = initial(),
  view = viewFromLocation(),
  scope = "",
  search = "",
  fileTeam = "all",
  bomSearch = "",
  bomTeam = "all",
  bomStage = "all",
  bomPrice = "all",
  storageAvailable = false,
  saving = Promise.resolve(),
  urls = new Map(),
  toastTimer,
  driveSyncing = false,
  driveExplorerFolder = ROOT_DRIVE_FOLDER_ID,
  driveExplorerBreadcrumbs = [
    { id: ROOT_DRIVE_FOLDER_ID, name: ROOT_DRIVE_FOLDER_NAME },
  ],
  driveExplorerFiles = [],
  driveExplorerLoaded = false,
  driveExplorerSelected = null,
  driveExplorerLoading = false,
  driveExplorerError = "",
  driveExplorerSearch = "",
  driveExplorerSort = "name",
  driveExplorerView = "list",
  driveExplorerRequestId = 0,
  driveExplorerAbortController = null;
function firstName(value) {
  return String(value || "Collaborator").trim().split(/\s+/)[0] || "Collaborator";
}

function scheduleTldrawPersist() {
  clearTimeout(tldrawPersistTimer);
  tldrawPersistTimer = setTimeout(() => {
    tldrawPersistTimer = null;
    persist();
  }, 1000);
}

function cameraForStorage(camera) {
  if (
    !camera ||
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.z) ||
    camera.z <= 0
  ) {
    return null;
  }
  return { x: camera.x, y: camera.y, z: camera.z };
}

async function saveTldrawView(projectId, pageId, camera) {
  if (
    !currentUserId ||
    !projectId ||
    !pageId ||
    !registeredProjectIds.has(projectId)
  )
    return;
  const normalizedCamera = cameraForStorage(camera);
  if (!normalizedCamera) return;
  const { error } = await supabaseClient.from("board_view_state").upsert(
    {
      user_id: currentUserId,
      project_id: projectId,
      board_id: "drawing-board",
      page_id: pageId,
      camera_x: normalizedCamera.x,
      camera_y: normalizedCamera.y,
      camera_z: normalizedCamera.z,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,project_id,board_id,page_id" },
  );
  if (error) {
    notify("Board view size could not be saved: " + error.message);
  }
}

async function ensureProjectRecord(project) {
  if (!project?.id || !project.name) return;
  const { error } = await supabaseClient.from("projects").insert(
    {
      id: project.id,
      name: project.name,
      description: project.description || "",
    },
  );
  if (
    error &&
    error.code !== "42P01" &&
    error.code !== "23505" &&
    error.status !== 409
  ) {
    throw error;
  }
  registeredProjectIds.add(project.id);
}

async function restoreTldrawView(editor, projectId, pageId) {
  if (!currentUserId || !projectId || !pageId) return;
  const { data, error } = await supabaseClient
    .from("board_view_state")
    .select("camera_x, camera_y, camera_z")
    .eq("user_id", currentUserId)
    .eq("project_id", projectId)
    .eq("board_id", "drawing-board")
    .eq("page_id", pageId)
    .maybeSingle();
  if (error) {
    notify("Saved board view size could not be loaded: " + error.message);
    return;
  }
  const camera = cameraForStorage({
    x: Number(data?.camera_x),
    y: Number(data?.camera_y),
    z: Number(data?.camera_z),
  });
  if (camera) editor.setCamera(camera);
}

function scheduleTldrawViewPersist(editor, projectId) {
  clearTimeout(tldrawViewPersistTimer);
  tldrawViewPersistTimer = setTimeout(() => {
    tldrawViewPersistTimer = null;
    saveTldrawView(projectId, editor.getCurrentPageId(), editor.getCamera());
  }, 500);
}

function documentRecords(records) {
  return Object.fromEntries(
    Object.entries(records || {}).filter(
      ([, record]) => !tldrawInstanceRecordTypes.has(record.typeName),
    ),
  );
}

function documentUpdates(updates) {
  return Object.fromEntries(
    Object.entries(updates || {}).filter(
      ([, change]) =>
        !tldrawInstanceRecordTypes.has(change[1]?.typeName),
    ),
  );
}

function changedRecords(changes) {
  return Object.values(changes || {}).map((change) =>
    Array.isArray(change) ? change[1] : change,
  );
}

function isPageRecord(record) {
  return record?.typeName === "page";
}

function recordPageId(record, recordsById, visited = new Set()) {
  if (!record || visited.has(record.id)) return null;
  visited.add(record.id);
  if (record.typeName === "page") return record.id;
  if (!record.parentId) return null;
  return recordPageId(recordsById.get(record.parentId), recordsById, visited);
}

function recordsForPage(records, pageId, currentRecords = []) {
  const allRecords = new Map(
    [...currentRecords, ...records].map((record) => [record.id, record]),
  );
  const pageRecords = records.filter(
    (record) =>
      recordPageId(record, allRecords) === pageId ||
      (record.typeName === "asset" &&
        [...allRecords.values()].some(
          (candidate) =>
            candidate.typeName === "shape" &&
            candidate.props?.assetId === record.id &&
            recordPageId(candidate, allRecords) === pageId,
        )),
  );
  return Object.fromEntries(pageRecords.map((record) => [record.id, record]));
}

function recordBelongsToProject(record, projectId) {
  if (
    (record?.typeName === "page" || record?.typeName === "shape") &&
    !record?.meta?.projectId
  )
    return false;
  return !record?.meta?.projectId || record.meta.projectId === projectId;
}

function removedRecordsForPage(records, pageId, currentRecords) {
  return recordsForPage(records, pageId, currentRecords);
}

function snapshotTldrawStore(store) {
  const snapshot = store.getStoreSnapshot();
  const records = Object.values(snapshot.store || {});
  const defaultPageIds = new Set(
    records
      .filter((record) => record.typeName === "page" && record.id === "page:page")
      .map((record) => record.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.parentId && defaultPageIds.has(record.parentId) && !defaultPageIds.has(record.id)) {
        defaultPageIds.add(record.id);
        changed = true;
      }
    }
  }
  return {
    ...snapshot,
    store: Object.fromEntries(
      records
        .filter((record) => !defaultPageIds.has(record.id))
        .map((record) => [record.id, record]),
    ),
  };
}

function broadcastTldrawPointer(point, active) {
  if (!tldrawChannel || !tldrawEditorProjectId) return;
  const message = tldrawChannel.send({
    type: "broadcast",
    event: "tldraw-pointer",
    payload: {
      projectId: tldrawEditorProjectId,
      pageId: tldrawEditor?.getCurrentPageId() ?? null,
      clientId: tldrawClientId,
      point,
      active,
      color: tldrawPointerColor,
      hue: tldrawPointerHue,
      name: tldrawPointerName,
    },
  });
  message?.catch((error) =>
    notify("Live pointer update failed: " + error.message),
  );
}

function renderRemoteTldrawPointers() {
  const overlay = $("#tldraw-pointer-overlay");
  if (!overlay || !tldrawEditor) return;
  overlay.innerHTML = "";
  for (const pointer of remoteTldrawPointers.values()) {
    if (
      !pointer.point ||
      pointer.projectId !== scope ||
      pointer.pageId !== tldrawEditor.getCurrentPageId()
    )
      continue;
    const screenPoint = tldrawEditor.pageToScreen(pointer.point);
    const dot = document.createElement("div");
    dot.className = "tldraw-remote-pointer";
    dot.style.left = `${screenPoint.x}px`;
    dot.style.top = `${screenPoint.y}px`;
    dot.style.setProperty("--pointer-color", pointer.color);
    dot.title = pointer.name || "Collaborator";
    const icon = document.createElement("img");
    icon.className = "tldraw-remote-pointer-icon";
    icon.src = "content/collab-cursor.png";
    icon.alt = "";
    icon.draggable = false;
    icon.style.filter = `hue-rotate(${Number(pointer.hue) || 0}deg) drop-shadow(1px 1px 0 #fff) drop-shadow(0 1px 2px #0008)`;
    dot.append(icon);
    const label = document.createElement("span");
    label.className = "tldraw-remote-pointer-name";
    label.textContent = pointer.name || "Collaborator";
    dot.append(label);
    overlay.append(dot);
  }
}

function scheduleRemotePointerRender() {
  if (pointerBroadcastFrame !== null) return;
  pointerBroadcastFrame = requestAnimationFrame(() => {
    pointerBroadcastFrame = null;
    renderRemoteTldrawPointers();
  });
}

function handleTldrawPointer(payload) {
  if (
    !payload ||
    payload.clientId === tldrawClientId ||
    payload.projectId !== scope
  )
    return;
  if (payload.active === false || !payload.point) {
    remoteTldrawPointers.delete(payload.clientId);
  } else {
    remoteTldrawPointers.set(payload.clientId, payload);
  }
  scheduleRemotePointerRender();
}

function bindTldrawPointerPresence(container, editor, projectId) {
  let lastPageId = editor.getCurrentPageId();
  const unlistenPage = editor.store.listen(
    () => {
      const pageId = editor.getCurrentPageId();
      if (pageId === lastPageId) return;
      lastPageId = pageId;
      if (localPointer) broadcastTldrawPointer(null, false);
      renderRemoteTldrawPointers();
    },
    { scope: "session" },
  );
  const sendPointer = (event, active = true) => {
    if (scope !== projectId || tldrawEditor !== editor) return;
    const bounds = container.getBoundingClientRect();
    const point = editor.screenToPage({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    localPointer = point;
    if (active) broadcastTldrawPointer(point, true);
  };
  container.addEventListener("pointermove", sendPointer);
  container.addEventListener("pointerenter", sendPointer);
  container.addEventListener("pointerleave", () => {
    if (scope !== projectId || tldrawEditor !== editor || !localPointer) return;
    broadcastTldrawPointer(null, false);
    localPointer = null;
  });
  return () => {
    unlistenPage();
    container.removeEventListener("pointermove", sendPointer);
    container.removeEventListener("pointerenter", sendPointer);
    if (localPointer) broadcastTldrawPointer(null, false);
    localPointer = null;
  };
}

function applyTldrawChanges(payload) {
  if (
    !tldrawEditor ||
    !tldrawEditorProjectId ||
    !payload ||
    payload.projectId !== tldrawEditorProjectId
  )
    return;
  const currentRecords = Object.values(
    tldrawEditor.store.getStoreSnapshot().store || {},
  ).filter((record) => !tldrawInstanceRecordTypes.has(record.typeName));
  const addedRecords = changedRecords(payload.added);
  const updatedRecords = changedRecords(payload.updated);
  const removedRecords = changedRecords(payload.removed);
  const currentPageId = tldrawEditor.getCurrentPageId();
  const pageChanges = [
    ...addedRecords,
    ...updatedRecords,
    ...removedRecords,
  ].filter(
    (record) =>
      isPageRecord(record) &&
      recordBelongsToProject(record, tldrawEditorProjectId),
  );
  const drawingAdded = addedRecords.filter(
    (record) =>
      !isPageRecord(record) &&
      recordBelongsToProject(record, tldrawEditorProjectId),
  );
  const drawingUpdated = updatedRecords.filter(
    (record) =>
      !isPageRecord(record) &&
      recordBelongsToProject(record, tldrawEditorProjectId),
  );
  const drawingRemoved = removedRecords.filter(
    (record) =>
      !isPageRecord(record) &&
      recordBelongsToProject(record, tldrawEditorProjectId),
  );
  const activePageChanges =
    payload.pageId && payload.pageId === currentPageId
      ? {
          added: recordsForPage(drawingAdded, currentPageId, currentRecords),
          updated: recordsForPage(
            drawingUpdated,
            currentPageId,
            currentRecords,
          ),
          removed: removedRecordsForPage(
            drawingRemoved,
            currentPageId,
            currentRecords,
          ),
        }
      : { added: {}, updated: {}, removed: {} };
  applyingTldrawSnapshot = true;
  try {
    tldrawEditor.store.mergeRemoteChanges(() => {
      tldrawEditor.store.put(pageChanges.filter(Boolean));
      tldrawEditor.store.put(Object.values(activePageChanges.added));
      tldrawEditor.store.put(Object.values(activePageChanges.updated));
      tldrawEditor.store.remove([
        ...removedRecords
          .filter(isPageRecord)
          .map((record) => record.id),
        ...Object.keys(activePageChanges.removed),
      ]);
    });
    state = {
      ...state,
      projectDrawings: {
        ...state.projectDrawings,
        [tldrawEditorProjectId]: snapshotTldrawStore(tldrawEditor.store),
      },
    };
  } finally {
    applyingTldrawSnapshot = false;
  }
}

function saveActiveTldrawSnapshot() {
  if (!tldrawEditor || !tldrawEditorProjectId) return;
  if (tldrawEditorProjectId !== scope) {
    console.warn("Skipped drawing save for a project that is no longer active.");
    return;
  }
  state = {
    ...state,
    projectDrawings: {
      ...state.projectDrawings,
      [tldrawEditorProjectId]: snapshotTldrawStore(tldrawEditor.store),
    },
  };
}

function loadProjectTldrawSnapshot(snapshot) {
  if (!tldrawEditor || !tldrawEditorProjectId) return;
  const projectId = tldrawEditorProjectId;
  const doc = snapshot?.document ?? snapshot;
  const records = Object.values(doc?.store || {}).filter(
    (record) =>
      !tldrawInstanceRecordTypes.has(record.typeName) &&
      recordBelongsToProject(record, projectId),
  ).map((record) => {
    if (record.typeName !== "page" && record.typeName !== "shape") return record;
    const pageNameMigration = {
      "Main Architecture": "Controls",
      "Controls Breakout Room": "Electrical",
      "Electrical Breakout Room": "Mechanical",
    };
    const nextName = pageNameMigration[record.name];
    return {
      ...(nextName ? { ...record, name: nextName } : record),
      ...(record.typeName === "page" || record.typeName === "shape"
        ? { meta: { ...(record.meta || {}), projectId } }
        : {}),
    };
  });
  applyingTldrawSnapshot = true;
  try {
    tldrawEditor.store.mergeRemoteChanges(() => {
      const currentRecords = Object.values(
        tldrawEditor.store.getStoreSnapshot().store || {},
      );
      const staleRecords = currentRecords.filter(
        (record) => !tldrawInstanceRecordTypes.has(record.typeName),
      );
      if (staleRecords.length) {
        tldrawEditor.store.remove(staleRecords.map((record) => record.id));
      }
      tldrawEditor.store.put(records);
      });
      const pages = tldrawEditor.getPages();
      if (!records.length) {
        if (pages.length) tldrawEditor.store.remove(pages.map((page) => page.id));
        const defaults = ["Controls", "Electrical", "Mechanical"].map((name) =>
          tldrawEditor.createPage({
            id: projectPageId(projectId, name, true),
            name,
            meta: { projectId },
          }),
        );
        const recreatedDefault = tldrawEditor
          .getPages()
          .find((page) => page.id === "page:page");
        if (recreatedDefault) tldrawEditor.store.remove([recreatedDefault.id]);
        tldrawEditor.setCurrentPage(defaults[0].id);
    } else if (pages.length) {
      const incomingIds = new Set(records.map((record) => record.id));
      const currentPage = pages.find((page) => incomingIds.has(page.id));
      if (currentPage) {
        tldrawEditor.setCurrentPage(currentPage.id);
        const staleRecords = pages.filter(
          (page) => !incomingIds.has(page.id),
        );
        tldrawEditor.store.remove(staleRecords.map((page) => page.id));
      }
    }
    state = {
      ...state,
      projectDrawings: {
        ...state.projectDrawings,
        [projectId]: snapshotTldrawStore(tldrawEditor.store),
      },
    };
  } finally {
    applyingTldrawSnapshot = false;
  }
}

function disposeTldrawBoard() {
  tldrawRenderToken += 1;
  const projectId = scope;
  saveActiveTldrawSnapshot();
  clearTimeout(tldrawViewPersistTimer);
  tldrawViewPersistTimer = null;
  if (tldrawEditor && tldrawLastCameraPageId && tldrawLastCamera) {
    saveTldrawView(
      projectId,
      tldrawLastCameraPageId,
      tldrawLastCamera,
    );
  }
  tldrawLastCameraPageId = null;
  tldrawLastCamera = null;
  if (typeof tldrawUnlisten === "function") tldrawUnlisten();
  tldrawUnlisten = null;
  if (tldrawChannel) {
    supabaseClient.removeChannel(tldrawChannel);
    tldrawChannel = null;
  }
  remoteTldrawPointers.clear();
  $("#tldraw-pointer-overlay")?.replaceChildren();
  tldrawEditor = null;
  tldrawEditorProjectId = null;
  if (!tldrawRoot) return;
  try {
    if (typeof tldrawRoot.unmount === "function") tldrawRoot.unmount();
  } catch (error) {
    tldrawRoot = null;
    notify("The drawing board could not be closed cleanly: " + error.message);
    return;
  }
  tldrawRoot = null;
}

async function initTldrawBoard() {
  const container = $("#tldraw-container");
  if (!container) return;
  const renderToken = ++tldrawRenderToken;
  const projectId = scope;
  try {
    if (!tldrawImportPromise) {
      tldrawImportPromise = Promise.all([
        import("https://esm.sh/react-dom@18/client"),
        import("https://esm.sh/react@18"),
        import("https://esm.sh/tldraw@3.15.6?external=react,react-dom"),
      ]);
    }
    const [{ createRoot }, { default: React }, { Tldraw }] =
      await tldrawImportPromise;
    if (
      renderToken !== tldrawRenderToken ||
      view !== "canvas" ||
      !container.isConnected
    )
      return;
    tldrawRoot = createRoot(container);
    tldrawRoot.render(
      React.createElement(Tldraw, {
        onMount: (editor) => {
          if (renderToken !== tldrawRenderToken || view !== "canvas") {
            return;
          }
          tldrawEditor = editor;
          tldrawEditorProjectId = projectId;
          editor.sideEffects.registerBeforeCreateHandler("page", (record) => ({
            ...record,
            meta: { ...(record.meta || {}), projectId },
          }));
          editor.sideEffects.registerBeforeChangeHandler(
            "page",
            (_prev, record) => ({
              ...record,
              meta: { ...(record.meta || {}), projectId },
            }),
          );
          editor.sideEffects.registerBeforeCreateHandler("shape", (record) => ({
            ...record,
            meta: { ...(record.meta || {}), projectId },
          }));
          editor.sideEffects.registerBeforeChangeHandler(
            "shape",
            (_prev, record) => ({
              ...record,
              meta: { ...(record.meta || {}), projectId },
            }),
          );
          tldrawChannel = supabaseClient
            .channel(`tldraw:${projectId}`)
            .on("broadcast", { event: "tldraw-changes" }, ({ payload }) => {
              applyTldrawChanges(payload);
            })
            .on("broadcast", { event: "tldraw-pointer" }, ({ payload }) => {
              handleTldrawPointer(payload);
            })
            .subscribe();
          loadProjectTldrawSnapshot(state.projectDrawings[projectId]);
          tldrawLastCameraPageId = editor.getCurrentPageId();
          tldrawLastCamera = editor.getCamera();
          void (async () => {
            try {
              await restoreTldrawView(
                editor,
                projectId,
                tldrawLastCameraPageId,
              );
              if (tldrawEditor !== editor || view !== "canvas") return;
              const unbindPointerPresence = bindTldrawPointerPresence(
            container,
            editor,
            projectId,
          );
          tldrawUnlisten = editor.store.listen(
            (update) => {
              if (
                applyingTldrawSnapshot ||
                tldrawEditor !== editor ||
                tldrawEditorProjectId !== projectId
              )
                return;
              state = {
                ...state,
                projectDrawings: {
                  ...state.projectDrawings,
                  [projectId]: snapshotTldrawStore(editor.store),
                },
              };
              if (update.source !== "user") return;
              const added = documentRecords(update.changes.added);
              const updated = documentUpdates(update.changes.updated);
              const removed = Object.fromEntries(
                Object.entries(update.changes.removed || {}).filter(
                  ([, record]) =>
                    !tldrawInstanceRecordTypes.has(record.typeName),
                ),
              );
              const currentDocumentRecords = Object.values(
                editor.store.getStoreSnapshot().store || {},
              ).filter(
                (record) => !tldrawInstanceRecordTypes.has(record.typeName),
              );
              const currentPageId = editor.getCurrentPageId();
              const addedRecords = Object.values(added);
              const updatedRecords = Object.values(updated).map(
                (change) => change[1],
              );
              const removedRecords = Object.values(removed);
              const broadcast = tldrawChannel?.send({
                type: "broadcast",
                event: "tldraw-changes",
                payload: {
                    projectId,
                    pageId: currentPageId,
                    added: [
                      ...addedRecords.filter(isPageRecord),
                      ...Object.values(
                        recordsForPage(
                          addedRecords.filter(
                            (record) => !isPageRecord(record),
                          ),
                          currentPageId,
                          currentDocumentRecords,
                        ),
                      ),
                    ],
                    updated: [
                      ...updatedRecords.filter(isPageRecord),
                      ...Object.values(
                        recordsForPage(
                          updatedRecords.filter(
                            (record) => !isPageRecord(record),
                          ),
                          currentPageId,
                          currentDocumentRecords,
                        ),
                      ),
                    ],
                    removed: [
                      ...removedRecords.filter(isPageRecord),
                      ...Object.values(
                        removedRecordsForPage(
                          removedRecords.filter(
                            (record) => !isPageRecord(record),
                          ),
                          currentPageId,
                          currentDocumentRecords,
                        ),
                      ),
                    ],
                },
              });
              broadcast?.catch((error) =>
                notify("Live drawing update failed: " + error.message),
              );
              scheduleTldrawPersist();
            },
            { scope: "document" },
          );
          const unlistenCamera = editor.store.listen(
            () => {
              if (tldrawEditor !== editor || tldrawEditorProjectId !== projectId) return;
              const pageId = editor.getCurrentPageId();
              const camera = editor.getCamera();
              if (
                tldrawLastCameraPageId &&
                pageId !== tldrawLastCameraPageId &&
                tldrawLastCamera
              ) {
                saveTldrawView(
                  projectId,
                  tldrawLastCameraPageId,
                  tldrawLastCamera,
                );
                restoreTldrawView(editor, projectId, pageId);
              }
              tldrawLastCameraPageId = pageId;
              tldrawLastCamera = camera;
              scheduleTldrawViewPersist(editor, projectId);
            },
            { scope: "session" },
          );
          const previousUnlisten = tldrawUnlisten;
          tldrawUnlisten = () => {
            if (typeof previousUnlisten === "function") previousUnlisten();
            unlistenCamera();
            unbindPointerPresence();
          };
          renderRemoteTldrawPointers();
            } catch (error) {
              if (tldrawEditor === editor) {
                notify("The drawing board could not be loaded: " + error.message);
              }
            } finally {
              if (tldrawEditor === editor) {
                tldrawLastCamera = editor.getCamera();
                container.parentElement?.setAttribute(
                  "data-camera-ready",
                  "true",
                );
                container.parentElement?.setAttribute("aria-busy", "false");
              }
            }
          })();
        },
      }),
    );
  } catch (error) {
    if (renderToken === tldrawRenderToken) {
      notify("The drawing board could not be loaded: " + error.message);
    }
  }
}

const driveTestFolderId = ROOT_DRIVE_FOLDER_ID;
const teamLabel = (project, team) =>
  project === "pid-spoon" && team === "Mechanical" ? "CAD" : team;
const driveFolderFor = (project, team) =>
  state.projects.find((item) => item.id === project)?.driveFolderId || null;
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
const knownResources = () =>
  state.projects
    .filter((project) => project.driveFolderId)
    .map((project) => ({
      id: project.driveFolderId,
      project: project.id,
      team: "Shared",
      title: "Project Drive folder",
      url: "https://drive.google.com/drive/folders/" + project.driveFolderId,
    }));
const nameOf = (id) =>
  state.projects.find((p) => p.id === id)?.name || "Unknown project";
const inScope = (item) => item.project === scope;
const currentProject = () => scope;
function switchProject(projectId) {
  if (!projectId || projectId === scope) return;
  if (view === "canvas") {
    disposeTldrawBoard();
  } else {
    saveActiveTldrawSnapshot();
  }
  persist();
  scope = projectId;
  search = "";
  fileTeam = "all";
  bomSearch = "";
  bomTeam = "all";
  bomStage = "all";
  bomPrice = "all";
  render();
}
const teamOptions = (value, project = null) =>
  teams
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
function persist() {
  if (!workspaceLoaded) return Promise.resolve();
  $("#save-status").textContent = "Saving to cloud…";
  saving = saving.catch(() => {}).then(async () => {
      const {
        data: savedRows,
        error: sessionError,
      } = await supabaseClient.auth.getSession();
      if (sessionError) throw sessionError;
      if (!savedRows?.session) {
        $("#save-status").textContent = "Sign in to save";
        return;
      }
      const { data, error } = await supabaseClient
        .from("workspace_state")
        .update({ data: state, updated_at: new Date().toISOString() })
        .eq("id", 1)
        .select("id");
      if (error) throw error;
      if (!data?.length) {
        throw new Error("Save was rejected: row id=1 missing or blocked by RLS");
      }
      $("#save-status").textContent = "Saved to cloud";
    })
    .catch((error) => {
      $("#save-status").textContent = "Not saved";
      warn("Cloud save failed: " + error.message);
    });
  return saving;
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
  return urls.get("blob-" + id) || null;
}
async function getDriveBlob(file) {
  if (!file?.driveId || !googleAccessToken) return null;
  const response = await fetchDriveAPI(
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
  for (const project of state.projects) {
    if (state.bom[project.id] === id) delete state.bom[project.id];
  }
  const url = urls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urls.delete(id);
  }
  await persist();
  render();
  notify(`Removed ${file.name} from this workspace.`);
}
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#dialog").classList.remove("lightbox");
  $("#dialog").classList.remove("drive-preview-modal");
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
    try {
      if (!googleAccessToken) {
        throw new Error("Reconnect Google Drive before creating a project.");
      }
      const folder = await createDriveFolder(name, ROOT_DRIVE_FOLDER_ID);
      await syncDriveFiles();
      const project = state.projects.find(
        (item) => item.driveFolderId === folder.id,
      );
      if (!project) {
        throw new Error("The new Drive folder was not found after refreshing projects.");
      }
      const description = String(form.get("description") || "").trim();
      if (description) {
        project.description = description;
      }
      scope = project.id;
      await persist();
      $("#dialog").close();
      render();
    } catch (error) {
      notify("Project could not be created: " + error.message);
    }
  };
}

// Save locally in IndexedDB and upload to the selected Google Drive folder.
function showUpload(photos = false) {
  const initialProject = currentProject();
  const initialTeam = teams[0];
  const initialFolder = driveFoldersFor(initialProject, initialTeam)[0]?.id ||
    driveFolderFor(initialProject, initialTeam);
  const accept = photos
    ? 'accept="image/png,image/jpeg,image/webp,image/gif,image/avif"'
    : "";
  openModal(
    photos ? "Add project photos" : "Add project files",
    `<form id="upload-form"><p class="hint" style="margin-bottom:14px">Google Drive provides the folder structure below. Choose a destination, or upload a folder to recreate its subfolders there.</p>${photos ? "" : '<label class="field">Upload type<select name="upload-mode"><option value="files">Individual files</option><option value="folder">A folder and its contents</option></select></label>'}<label class="field">${photos ? "Photos" : "Files"}<input id="upload-input" type="file" name="files" ${accept} multiple required><small class="upload-help">Large files upload directly to Drive.</small></label><label class="field">Project<input value="${esc(nameOf(initialProject))}" readonly><input type="hidden" name="project" value="${esc(initialProject)}"></label><label class="field">Destination team<select name="team">${teamOptions(initialTeam, initialProject)}</select></label><label class="field">Destination folder<select name="folder">${driveFolderOptions(initialProject, initialTeam, initialFolder)}</select></label><label class="field">Note or photo caption<textarea name="note" maxlength="1000" placeholder="Context, version, or what the photo shows"></textarea></label>${actions(photos ? "Add photos" : "Add files")}</form>`,
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
      state = normalizeWorkspaceState(next);
      await persist();
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
    `<p class="hint">This workspace stores drawing state and Drive file metadata in the cloud. File contents are uploaded to Google Drive.</p><ul class="storage-list"><li><b>Google Drive</b>Large files are uploaded directly to the selected project/team folder using resumable uploads.</li><li><b>Cloud workspace</b>Projects, drawings, relationships, BOM selections, and Drive file links are stored in Supabase.</li><li><b>Share or back up</b>Import a JSON backup containing workspace data and Drive-backed file metadata. The backup does not duplicate large Drive files.</li></ul><div class="row"><button class="secondary" data-action="import">↑ Import backup</button><button class="secondary" data-action="backup-boards">Back up boards to Drive now</button><button class="secondary" data-action="restore-board">Restore current board from backup file…</button></div>`,
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
  return '<div id="tldraw-stage" class="tldraw-stage" data-camera-ready="false" aria-busy="true"><div id="tldraw-container"></div><div id="tldraw-pointer-overlay"></div></div>';
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
    root.innerHTML = `<div class="eyebrow">DETAILS & RELATIONSHIPS</div><h3>Give the work context.</h3><p>Select a card to assign its project and team, add notes, or reference a file.</p><div class="related"><h3>Cross-team references</h3><p>Use Connect to draw an arrow between cards. Select that arrow and describe the relationship in your own words.</p><p style="margin-top:12px">Switch projects above to review another project's cards and references.</p></div>`;
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
          ? `<div class="attachment"><a href="#files" data-download="${f.id}">${esc(f.name)}</a><button data-unlink="${f.id}" aria-label="Remove file reference">×</button></div>`
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
    canvasViewport = $(".canvas-viewport");
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
        left: canvasViewport.scrollLeft,
        top: canvasViewport.scrollTop,
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
      canvasViewport.scrollLeft = gesture.left + gesture.x - e.clientX;
      canvasViewport.scrollTop = gesture.top + gesture.y - e.clientY;
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
  if (!tldrawEditor) return;
  const shapeIds = tldrawEditor.getSelectedShapeIds();
  if (!shapeIds.length) return;
  tldrawEditor.deleteShapes(shapeIds);
}
function overviewHTML() {
  const groupUpdates = state.groupUpdates || [];
  const updates = state.projectUpdates[scope] || [];
  const updateListMarkup = (items, emptyMessage) => items.length
    ? `
        <div class="updates-list">
          ${items
            .map(
              (update) => `
                <article class="update-item">
                  <div>
                    <strong>${esc(update.message)}</strong>
                    <small>
                      ${esc(update.author || "Team member")} ·
                      ${new Date(update.createdAt).toLocaleString()}
                    </small>
                  </div>
                  <button
                    class="update-remove"
                    type="button"
                    data-update-delete="${esc(update.id)}"
                    aria-label="Remove update"
                    title="Remove update"
                  >
                    ×
                  </button>
                </article>
              `,
            )
            .join("")}
        </div>
      `
    : `
        <div class="updates-empty">
          <p>${emptyMessage}</p>
        </div>
      `;
  const groupUpdatesMarkup = updateListMarkup(
    groupUpdates,
    "No group news yet. Share an update with everyone.",
  );
  const updatesMarkup = updateListMarkup(
    updates,
    "No updates yet. Start writing above to let the team know what is happening.",
  );

  return `
    <section class="overview-updates panel">
      <div class="panel-head">
        <div>
          <h2>Group news</h2>
          <p>Updates shared with everyone across all projects.</p>
        </div>
      </div>

      <form id="group-update-composer" class="update-composer">
        <input
          name="message"
          maxlength="500"
          placeholder="Share news with the whole group…"
          aria-label="Share group news"
          required
        >
        <span>Press Enter to post</span>
      </form>

      ${groupUpdatesMarkup}
    </section>

    <section class="overview-updates panel">
      <div class="panel-head">
        <div>
          <h2>Project updates</h2>
          <p>
            Shared notes for everyone working on ${esc(nameOf(scope))}.
          </p>
        </div>
      </div>

      <form id="update-composer" class="update-composer">
        <input
          name="message"
          maxlength="500"
          placeholder="Write an update and press Enter…"
          aria-label="Write a team update"
          required
        >
        <span>Press Enter to post</span>
      </form>

      ${updatesMarkup}
    </section>

    <div class="overview-actions">
      <button class="overview-action" data-view="bom">
        <b>
          <span class="nav-icon nav-icon-bom" aria-hidden="true"></span>
          Open the BOM
        </b>
        <p>Search components and compare parts for this project.</p>
        <span>Go to BOM &#8599;</span>
      </button>

      <button class="overview-action" data-view="files">
        <b>
          <span class="nav-icon nav-icon-files" aria-hidden="true"></span>
          Open files
        </b>
        <p>Browse project folders and manage files in Google Drive.</p>
        <span>Go to files &#8599;</span>
      </button>

      <button class="overview-action" data-view="canvas">
        <b>
          <span
            class="nav-icon nav-icon-drawing-board"
            aria-hidden="true"
          ></span>
          Open the drawing board
        </b>
        <p>Draw, arrange, and connect ideas with your team.</p>
        <span>Go to drawing board &#8599;</span>
      </button>

      <button class="overview-action" data-view="gallery">
        <b>
          <span class="nav-icon nav-icon-gallery" aria-hidden="true"></span>
          Open the photo gallery
        </b>
        <p>Review project photos and keep track of visual progress.</p>
        <span>Go to gallery &#8599;</span>
      </button>
    </div>
  `;
}
async function saveOverviewUpdate(event) {
  event.preventDefault();
  const input = event.target.elements.message;
  const message = input.value.trim();
  if (!message) return;
  const projectUpdates = { ...state.projectUpdates };
  projectUpdates[scope] = [
    {
      id: uid(),
      message,
      author: tldrawPointerName,
      createdAt: new Date().toISOString(),
    },
    ...(projectUpdates[scope] || []),
  ];
  input.disabled = true;
  state = normalizeWorkspaceState({ ...state, projectUpdates });
  try {
    await persist();
    render();
    $("#update-composer input")?.focus();
  } catch (error) {
    input.disabled = false;
    notify("Update could not be saved: " + error.message);
  }
}
async function saveGroupUpdate(event) {
  event.preventDefault();
  const input = event.target.elements.message;
  const message = input.value.trim();
  if (!message) return;
  const groupUpdates = [
    {
      id: uid(),
      message,
      author: tldrawPointerName,
      createdAt: new Date().toISOString(),
    },
    ...(state.groupUpdates || []),
  ];
  input.disabled = true;
  state = normalizeWorkspaceState({ ...state, groupUpdates });
  try {
    await persist();
    render();
    $("#group-update-composer input")?.focus();
  } catch (error) {
    input.disabled = false;
    notify("Group news could not be saved: " + error.message);
  }
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
async function loadDriveExplorer(
  folderId = ROOT_DRIVE_FOLDER_ID,
  breadcrumb = [{ id: ROOT_DRIVE_FOLDER_ID, name: ROOT_DRIVE_FOLDER_NAME }],
) {
  const requestId = ++driveExplorerRequestId;
  driveExplorerAbortController?.abort();
  const abortController = new AbortController();
  driveExplorerAbortController = abortController;
  driveExplorerFolder = folderId;
  driveExplorerBreadcrumbs = breadcrumb.map((crumb) => ({ ...crumb }));
  driveExplorerLoaded = false;
  driveExplorerSelected = null;
  driveExplorerError = "";
  if (!googleAccessToken) {
    driveExplorerFiles = [];
    driveExplorerLoading = false;
    if (driveExplorerAbortController === abortController) {
      driveExplorerAbortController = null;
    }
    if (view === "files") render();
    return;
  }
  driveExplorerLoading = true;
  if (view === "files") render();
  try {
    const files = await listDriveFiles(
      folderId,
      abortController.signal,
    );
    if (requestId !== driveExplorerRequestId) return;
    driveExplorerFiles = files;
    driveExplorerLoaded = true;
  } catch (error) {
    if (requestId !== driveExplorerRequestId) return;
    if (error?.name === "AbortError") return;
    driveExplorerFiles = [];
    driveExplorerError = error instanceof Error ? error.message : "Google Drive could not be loaded.";
    if (!isDriveAuthorizationError(error)) notify(driveExplorerError);
  } finally {
    if (requestId !== driveExplorerRequestId) return;
    driveExplorerLoading = false;
    if (driveExplorerAbortController === abortController) {
      driveExplorerAbortController = null;
    }
    if (view === "files") render();
  }
}

function navigateToDriveFolder(folderId, folderName) {
  if (driveExplorerLoading || folderId === driveExplorerFolder) return;
  const existingIndex = driveExplorerBreadcrumbs.findIndex(
    (crumb) => crumb.id === folderId,
  );
  const breadcrumbs =
    existingIndex >= 0
      ? driveExplorerBreadcrumbs.slice(0, existingIndex + 1)
      : [
          ...driveExplorerBreadcrumbs,
          { id: folderId, name: folderName },
        ];
  return loadDriveExplorer(folderId, breadcrumbs);
}
function driveFileIcon(file) {
  if (file.mimeType?.includes("pdf")) return "PDF";
  if (file.mimeType?.startsWith("image/")) return "IMG";
  if (file.mimeType?.includes("spreadsheet")) return "XLS";
  if (file.mimeType?.includes("document")) return "DOC";
  return "FILE";
}
function openDrivePreview(file) {
  driveExplorerSelected = file;
  openModal(
    file.name,
    `<div class="drive-modal-actions"><a class="secondary" href="${esc(file.webContentLink || "#")}" ${file.webContentLink ? "download" : "aria-disabled=\"true\" tabindex=\"-1\""}>Download</a><a class="primary" href="${esc(file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`)}" target="_blank" rel="noopener noreferrer">Open in Drive</a></div><iframe class="drive-modal-preview" src="https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview" title="Preview of ${esc(file.name)}" allow="autoplay"></iframe>`,
  );
  $("#dialog").classList.add("drive-preview-modal");
}
function driveExplorerHTML() {
  const reconnect = !googleAccessToken;
  const query = driveExplorerSearch.trim().toLowerCase();
  const visible = driveExplorerFiles.filter((file) => !query || file.name.toLowerCase().includes(query));
  const folders = visible.filter((file) => file.mimeType === GOOGLE_DRIVE_FOLDER_MIME);
  const files = visible.filter((file) => file.mimeType !== GOOGLE_DRIVE_FOLDER_MIME);
  const sortFiles = (items) => [...items].sort((a, b) => {
    if (driveExplorerSort === "modified") return new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0);
    if (driveExplorerSort === "size") return Number(b.size || 0) - Number(a.size || 0);
    return a.name.localeCompare(b.name);
  });
  const sortedFolders = sortFiles(folders);
  const sortedFiles = sortFiles(files);
  const folderContent = sortedFolders.length
    ? sortedFolders.map((folder) => `<button class="drive-folder-card" data-drive-item="${esc(folder.id)}" aria-label="Open folder: ${esc(folder.name)}" ${driveExplorerLoading ? "disabled" : ""}><span class="drive-folder-icon" aria-hidden="true"></span><span><b>${esc(folder.name)}</b></span></button>`).join("")
    : `<p class="drive-section-empty">${query ? "No folders match your search." : "No subfolders in this folder."}</p>`;
  const fileContent = sortedFiles.length
    ? (driveExplorerView === "grid"
      ? `<div class="drive-file-grid">${sortedFiles.map((file) => `<button class="drive-file-card" data-drive-item="${esc(file.id)}"><span class="drive-file-icon">${driveFileIcon(file)}</span><b>${esc(file.name)}</b><small>${file.size ? sizeOf(Number(file.size)) : "Google file"} · ${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "—"}</small></button>`).join("")}</div>`
      : `<div class="drive-table-wrap"><table class="drive-table"><thead><tr><th>Name</th><th>Owner</th><th>Last modified</th><th>File size</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${sortedFiles.map((file) => `<tr class="${driveExplorerSelected?.id === file.id ? "selected" : ""}" data-drive-item="${esc(file.id)}"><td><div class="drive-name"><span class="drive-file-icon">${driveFileIcon(file)}</span><strong>${esc(file.name)}</strong></div></td><td class="drive-muted">—</td><td class="drive-muted">${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "—"}</td><td class="drive-muted">${file.size ? sizeOf(Number(file.size)) : "—"}</td><td class="drive-actions"><button class="icon-button" data-drive-preview="${esc(file.id)}" aria-label="Preview ${esc(file.name)}">⋮</button></td></tr>`).join("")}</tbody></table></div>`)
    : `<div class="drive-empty"><div class="drive-empty-icon">⌁</div><h3>${query ? "No files match your search" : "This folder is empty"}</h3><p>${query ? "Try a different search term." : "Upload a file to start building this folder."}</p></div>`;
  const connectionClass = reconnect ? "is-reconnecting" : "is-connected";
  return `<section class="drive-explorer ${connectionClass}" aria-busy="${driveExplorerLoading}"><div class="drive-toolbar"><div class="drive-toolbar-location"><div class="drive-breadcrumbs" aria-label="Drive folder path"><button class="drive-home" data-drive-folder="${esc(driveExplorerBreadcrumbs[0].id)}" data-drive-breadcrumb-index="0" aria-label="Project files" ${driveExplorerLoading ? "disabled" : ""}>⌂</button>${driveExplorerBreadcrumbs.map((crumb, index) => `<span aria-hidden="true">›</span><button class="text-button" data-drive-folder="${esc(crumb.id)}" data-drive-breadcrumb-index="${index}" ${index === driveExplorerBreadcrumbs.length - 1 ? 'aria-current="page"' : ""} ${driveExplorerLoading ? "disabled" : ""}>${esc(crumb.name)}</button>`).join("")}</div><span class="drive-version">${driveExplorerLoading ? "Loading folder…" : `${driveExplorerFiles.length} items in this folder`}</span></div><div class="drive-toolbar-actions"><label class="drive-search"><span aria-hidden="true">⌕</span><input id="drive-search" type="search" value="${esc(driveExplorerSearch)}" placeholder="Search in EXO" aria-label="Search in EXO"></label><div class="drive-new-menu"><button class="primary" data-action="toggle-drive-new" ${reconnect ? "disabled" : ""}>＋ New</button><div class="drive-new-dropdown" data-drive-new-menu hidden><button type="button" data-action="new-drive-folder">New folder</button><button type="button" data-action="upload-drive-files">File upload</button><button type="button" data-action="upload-drive-folder">Folder upload</button></div></div></div></div>${reconnect ? `<div class="drive-reconnect"><p>${driveTokenExpired ? "Your Google Drive connection expired. Reconnect to continue browsing and uploading files." : "Sign in with Google to browse the shared Drive folder."}</p><button class="primary" data-action="login">Reconnect Google Drive</button></div>` : `<div class="drive-control-row"><span class="drive-location-label">${esc(driveExplorerBreadcrumbs[driveExplorerBreadcrumbs.length - 1].name)}</span><div class="drive-controls"><label>Sort <select id="drive-sort"><option value="name" ${driveExplorerSort === "name" ? "selected" : ""}>Name</option><option value="modified" ${driveExplorerSort === "modified" ? "selected" : ""}>Last modified</option><option value="size" ${driveExplorerSort === "size" ? "selected" : ""}>File size</option></select></label><span class="view-toggle" aria-label="View mode"><button class="${driveExplorerView === "list" ? "active" : ""}" data-drive-view="list" aria-label="List view">☷</button><button class="${driveExplorerView === "grid" ? "active" : ""}" data-drive-view="grid" aria-label="Grid view">⊞</button></span></div></div><section class="drive-section"><div class="drive-section-head"><div><strong>Folders</strong><small>${sortedFolders.length} folder${sortedFolders.length === 1 ? "" : "s"}</small></div></div><div class="drive-folder-grid">${folderContent}</div></section><section class="drive-section drive-files-section"><div class="drive-section-head"><div><strong>Files</strong><small>${sortedFiles.length} file${sortedFiles.length === 1 ? "" : "s"}</small></div></div>${fileContent}</section></section>`}</section>`;
}
function filesHTML() {
  return driveExplorerHTML();
}function galleryHTML() {
  const photos = state.files.filter(inScope).filter(isPhoto);
  return `<section class="panel"><div class="panel-head"><div><h2>Project photo gallery</h2><p>Photos loaded from the project Google Drive folders.</p></div><span class="pill">${photos.length} photos</span></div>${photos.length ? `<div class="tiles">${photos.map((f) => `<article class="photo"><button class="photo-image" data-photo="${f.id}" aria-label="View ${esc(f.name)}"><img data-local-image="${f.id}" alt="${esc(f.note || f.name)}"></button><div class="photo-info"><b>${esc(f.name)}</b><p>${esc(nameOf(f.project))} · ${esc(teamLabel(f.project, f.team))}</p><p>${esc(f.note)}</p><button class="text-button" data-download="${f.id}">↗ Open in Drive</button> <button class="text-button danger-text" data-remove-file="${f.id}">Remove from library</button></div></article>`).join("")}</div>` : empty("&#9639;", "Show what you are building.", "Add photos of prototypes, assemblies, and team progress.", '<button class="secondary" data-action="photos">+ Add photos</button>')}</section>`;
}
async function loadImages() {
  for (const img of $$("[data-local-image]")) {
    const url = await fileURL(img.dataset.localImage);
    if (url) img.src = url;
  }
}
function bomHTML() {
  const projects = state.projects.filter((p) => p.id === scope);
  const files = projects.map((p) => state.files.find((f) => f.id === state.bom[p.id])).filter(Boolean);
  const hasSharedRows = sharedBOMRows.some((row) => row.project_id === scope);
  return `<section class="panel"><div class="panel-head"><div><h2>Bill of materials</h2><p>Showing the selected project's components and source file.</p></div><button class="secondary" data-action="add-bom-row">+ Add component</button></div><div id="bom-preview">${files.length || hasSharedRows ? '<div class="empty"><p>Opening BOM…</p></div>' : empty("◈", "Keep the source easy to find.", "Add a BOM in Files. CSV files display as a searchable table.")}</div></section>`;
}
function driveFolderForm() {
  openModal(
    "Create a new folder",
    `<form id="drive-folder-form"><label class="field">Folder name<input name="name" maxlength="80" placeholder="Name your folder" required autofocus></label><p class="hint">This folder will be created in the current Google Drive location.</p>${actions("Create folder")}</form>`,
  );
  $("#drive-folder-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    const button = $("[type=submit]", event.target);
    button.disabled = true;
    button.textContent = "Creating folder…";
    try {
      await createSubfolder(name, driveExplorerFolder);
      $("#dialog").close();
      await loadDriveExplorer(driveExplorerFolder, driveExplorerBreadcrumbs);
      notify(`Created folder "${name}".`);
    } catch (error) {
      if (!isDriveAuthorizationError(error)) {
        notify(error instanceof Error ? error.message : "The folder could not be created.");
      }
      button.disabled = false;
      button.textContent = "Try again";
    }
  };
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
function cleanImportedText(text) {
  return text
    .replace(/\u00e2\u20ac\u00a6/g, "…")
    .replace(/\u00e2\u20ac\u201d/g, "—")
    .replace(/\u00e2\u20ac\u201c/g, "–")
    .replace(/\u00e2\u20ac\u2122/g, "’")
    .replace(/\u00e2\u20ac\u0153|\u00e2\u20ac\u009d/g, '"')
    .replace(/\u00c2/g, "")
    .replace(/\u00c3(?=[^a-z])/g, "")
    .replace(/~=(?=\s*[\d.])/g, "≈");
}
async function previewBOM() {
  const target = $("#bom-preview");
  if (!target) return;
  try {
    const projects = state.projects.filter((p) => p.id === scope);
    const records = sharedBOMRows
      .filter((row) => row.project_id === scope)
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
      const csvText = new TextDecoder("utf-8", { fatal: true }).decode(
        await blob.arrayBuffer(),
      );
      const rows = parseCSV(cleanImportedText(csvText).replace(/^\uFEFF/, ""));
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
    records.push(...(state.bomEntries || []).filter((entry) => entry.project === scope).map((entry) => ({ ...entry, link: entry.link || entry.supplier || "", purpose: entry.purpose || "", source: "Added in workspace" })));
    if (!records.length) {
      target.innerHTML = empty("◈", "No previewable BOM rows.", "CSV files up to 5 MB can be searched here. Other source types remain available to download.");
      return;
    }
    const values = (field) => [...new Set(records.map((r) => r[field]).filter(Boolean))].sort();
    const money = (value) => Number(String(value).replace(/[^0-9.-]/g, "")) || 0;
    target.innerHTML = `<div class="section-tools bom-tools"><input id="bom-search" placeholder="Search ID, component, link..." aria-label="Search BOM" value="${esc(bomSearch)}"><select id="bom-team" aria-label="Filter by team"><option value="all">All teams</option>${values("team").map((v) => `<option ${bomTeam === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><select id="bom-stage" aria-label="Filter by stage"><option value="all">All stages</option>${values("basis").map((v) => `<option ${bomStage === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><select id="bom-price" aria-label="Filter by price"><option value="all">All pricing</option><option value="priced" ${bomPrice === "priced" ? "selected" : ""}>Priced only</option><option value="unpriced" ${bomPrice === "unpriced" ? "selected" : ""}>Needs pricing</option></select></div><div class="bom-stats" id="bom-stats"></div><div class="table-scroll"><table><thead><tr><th>ID</th><th>Project</th><th>Subsystem</th><th>Component / integration purpose</th><th>Qty</th><th>Unit $</th><th>Ext $</th><th>Link</th><th>Cost basis</th></tr></thead><tbody id="bom-rows"></tbody></table></div><div class="table-footer" id="bom-count"></div>`;
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
      "◈",
      "Could not preview this BOM.",
      esc(error.message),
    );
  }
}
function resourcesHTML() {
  const links = [...knownResources(), ...state.resources].filter(inScope);
  return `<section class="panel"><div class="panel-head"><div><h2>Repositories & links</h2><p>Open project Google Drive folders and other project references.</p></div></div><div class="resource-grid">${links.map((r) => `<a class="resource" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"><div><b>${esc(r.title)}</b><small>${esc(nameOf(r.project))} · ${esc(r.team)}</small></div><span>↗</span></a>`).join("")}</div>${!links.length ? empty("↗", "Connect your project.", "Add a Drive folder or reference link.") : ""}</section>`;
}
function resourceForm() {
  openModal(
    "Add a resource",
    `<form id="resource-form"><p class="hint" style="margin-bottom:14px">Add a Google Drive folder or other project reference.</p><label class="field">Title<input name="title" required maxlength="100"></label><label class="field">HTTPS address<input name="url" type="url" required placeholder="https://…" maxlength="2000"></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions("Shared")}</select></label></div>${actions("Add resource")}</form>`,
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
    !["projects", "files", "resources"].every(
      (k) => Array.isArray(s[k]),
    ) ||
    !s.projects.length ||
    !s.bom ||
    typeof s.bom !== "object" ||
    (!s.projectDrawings ||
      typeof s.projectDrawings !== "object" ||
      Array.isArray(s.projectDrawings) ||
      Object.values(s.projectDrawings).some(
        (snapshot) =>
          snapshot !== null &&
          (typeof snapshot !== "object" || !snapshot.store),
      ))
  )
    throw new Error("Backup structure is incomplete.");
  const str = (v, max = 2000) => typeof v === "string" && v.length <= max;
  const validId = (v) => str(v, 100) && /^[a-zA-Z0-9_-]+$/.test(v);
  for (const group of ["projects", "files", "resources"])
    if (
      new Set(s[group].map((x) => x.id)).size !== s[group].length ||
      s[group].some((x) => !validId(x.id))
    )
      throw new Error("Invalid or duplicate record identifiers.");
  const projects = new Set(s.projects.map((x) => x.id)),
    files = new Set(s.files.map((x) => x.id));
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
        "Replace the current cloud workspace with this backup? Export your current work first if you want to keep it.",
      )
    )
      return;
    await saving;
    for (const [key, url] of urls)
      if (!key.startsWith("blob-")) URL.revokeObjectURL(url);
    urls.clear();
    state = normalizeWorkspaceState(next);
    scope = next.projects[0]?.id;
    await persist();
    render();
    notify("Backup imported into the cloud workspace.");
    $("#dialog").close();
  } catch (error) {
    notify("Import failed: " + error.message);
  }
}
function render() {
  disposeTldrawBoard();
  $(".app").dataset.view = view;
  const labels = {
    overview: [
      "The whole project, at a glance.",
      "Files, drawings, and references in one local workspace.",
      "ï¼‹ Add files",
    ],
    canvas: [
      "Your ideas. Your connections.",
      "Draw freely, place cards, and connect work across teams and projects.",
      "ï¼‹ Add card",
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
      "+ Add photos",
    ],
    resources: [
      "Your project, connected.",
      "Open the tools, repositories, and folders your team uses.",
      "ï¼‹ Add resource",
    ],
  };
  $("#page-title").textContent = labels[view][0];
  $("#page-description").textContent = labels[view][1];
  $("#eyebrow").textContent =
    nameOf(scope).toUpperCase() +
    " / " +
    (view === "canvas"
      ? "DRAWING BOARD"
      : view === "resources"
        ? "REPOSITORIES & LINKS"
        : view.toUpperCase());
  $("#crumb").textContent =
    `${nameOf(scope)} / ${view}`;
  $("#project-context").innerHTML =
    state.projects
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${scope === p.id ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join("") +
    `<option value="__new-project__">+ Add new project</option>`;
  $("#project-context").onchange = (e) => {
    if (e.target.value === "__new-project__") {
      e.target.value = scope;
      projectForm();
      return;
    }
    switchProject(e.target.value);
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
  if (view === "overview") {
    const groupUpdateComposer = $("#group-update-composer");
    if (groupUpdateComposer) groupUpdateComposer.onsubmit = saveGroupUpdate;
    const updateComposer = $("#update-composer");
    if (updateComposer) updateComposer.onsubmit = saveOverviewUpdate;
  }
  if (view === "canvas") {
    initTldrawBoard();
  }
  if (view === "gallery") loadImages();
  if (view === "bom") previewBOM();
  if (view === "files") {
    if (
      googleAccessToken &&
      !driveExplorerLoaded &&
      !driveExplorerLoading &&
      !driveExplorerError
    )
      loadDriveExplorer(driveExplorerFolder, driveExplorerBreadcrumbs);
    const dropZone = $("#drive-drop-zone");
    if (!dropZone) return;
    const uploadFiles = async (files) => {
      try {
        for (const file of files) await uploadFileToDrive(file, driveExplorerFolder);
        await loadDriveExplorer(driveExplorerFolder, driveExplorerBreadcrumbs);
        notify("Files uploaded to Google Drive.");
      } catch (error) {
        notify("Google Drive upload failed: " + error.message);
      }
    };
    dropZone.ondragover = (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    };
    dropZone.ondragleave = () => dropZone.classList.remove("dragging");
    dropZone.ondrop = (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
      uploadFiles(event.dataTransfer.files);
    };
  }
}
window.addEventListener("hashchange", () => {
  const nextView = viewFromLocation();
  if (nextView === view && window.location.hash === `#${viewHashNames[view]}`) {
    return;
  }
  setView(nextView);
  render();
});
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button,a,tr");
  if (!el) return;
  if (el.dataset.view) {
    const previousView = view;
    setView(el.dataset.view);

    render();
    if (view === "canvas" && previousView !== "canvas") {
      requestAnimationFrame(() => {
        $("#tldraw-stage")?.scrollIntoView({
          block: "center",
          behavior: "auto",
        });
      });
    }
    if (view === "files") {
      syncDriveFiles().catch((error) => {
        driveSyncing = false;
        if (!isDriveAuthorizationError(error)) {
          notify("Google Drive files could not be synchronized: " + error.message);
        }
        render();
      });
    }
  }
  if (el.dataset.project) {
    switchProject(el.dataset.project);
  }
  if (el.dataset.download) {
    e.preventDefault();
    downloadFile(el.dataset.download);
  }
  if (el.dataset.driveFolder) {
    e.preventDefault();
    const index = Number(el.dataset.driveBreadcrumbIndex);
    navigateToDriveFolder(
      el.dataset.driveFolder,
      driveExplorerBreadcrumbs[index]?.name || ROOT_DRIVE_FOLDER_NAME,
    );
  }
  if (el.dataset.driveItem) {
    e.preventDefault();
    const item = driveExplorerFiles.find((file) => file.id === el.dataset.driveItem);
    if (!item) return;
    if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
      navigateToDriveFolder(item.id, item.name);
    } else {
      openDrivePreview(item);
    }
  }
  if (el.dataset.drivePreview) {
    e.preventDefault();
    e.stopPropagation();
    const item = driveExplorerFiles.find((file) => file.id === el.dataset.drivePreview);
    if (item) openDrivePreview(item);
  }
  if (el.dataset.driveView) {
    driveExplorerView = el.dataset.driveView;
    render();
  }
  if (el.dataset.removeFile) {
    e.preventDefault();
    await removeLocalFile(el.dataset.removeFile);
    return;
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
  if (el.dataset.updateDelete) {
    const update = (state.groupUpdates || [])
      .concat(state.projectUpdates[scope] || [])
      .find((item) => item.id === el.dataset.updateDelete);
    if (update) {
      const groupUpdates = (state.groupUpdates || []).filter(
        (item) => item.id !== el.dataset.updateDelete,
      );
      const projectUpdates = {
        ...state.projectUpdates,
        [scope]: (state.projectUpdates[scope] || []).filter(
          (item) => item.id !== el.dataset.updateDelete,
        ),
      };
      state = normalizeWorkspaceState({ ...state, groupUpdates, projectUpdates });
      await persist();
      render();
    }
  }
  if (el.hasAttribute("data-close")) $("#dialog").close();
  const action = el.dataset.action;
  if (action === "login") signInWithGoogle();
  if (action === "toggle-sidebar") {
    setSidebarCollapsed(!$(".app").classList.contains("sidebar-collapsed"));
  }
  if (action === "refresh-drive-folder") {
    loadDriveExplorer(driveExplorerFolder, driveExplorerBreadcrumbs);
  }
  if (action === "refresh-drive") {
    syncDriveFiles().catch((error) => {
      driveSyncing = false;
      if (!isDriveAuthorizationError(error)) {
        notify("Google Drive files could not be synchronized: " + error.message);
      }
      render();
    });
  }
  if (action === "toggle-drive-new") {
    const menu = el.parentElement.querySelector("[data-drive-new-menu]");
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  if (action === "new-drive-folder") {
    driveFolderForm();
  }
  if (action === "upload-drive-files" || action === "upload-drive-folder") {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    if (action === "upload-drive-folder") input.setAttribute("webkitdirectory", "");
    document.body.append(input);
    input.onchange = async () => {
      try {
        for (const file of input.files) await uploadFileToDrive(file, driveExplorerFolder);
        await loadDriveExplorer(driveExplorerFolder, driveExplorerBreadcrumbs);
        notify("Files uploaded to Google Drive.");
      } catch (error) {
        if (!isDriveAuthorizationError(error)) {
          notify("Google Drive upload failed: " + error.message);
        }
      } finally {
        input.remove();
      }
    };
    input.click();
  }
  if (action === "upload") showDriveTestUpload();
  if (action === "photos") showUpload(true);
  if (action === "storage") showStorage();
  if (action === "backup-boards") {
    const button = el;
    button.disabled = true;
    button.textContent = "Backing up boards…";
    backupAllBoardsToDrive()
      .then((results) => {
        const saved = results.filter(({ result }) => result === "saved").length;
        const skipped = results
          .filter(({ result }) => result !== "saved")
          .map(({ project, result }) => `${project}: ${result}`)
          .join("; ");
        notify(
          `${saved} board${saved === 1 ? "" : "s"} saved to Drive` +
            (skipped ? `. ${skipped}` : "."),
        );
      })
      .catch((error) => notify("Board backups failed: " + error.message))
      .finally(() => {
        button.disabled = false;
        button.textContent = "Back up boards to Drive now";
      });
  }
  if (action === "restore-board") {
    $("#tldraw-board-restore-input").click();
  }
  if (action === "export") exportBackup();
  if (action === "import") $("#backup-input").click();
  if (action === "delete-selection") deleteSelection();
  if (action === "add-bom-row") addBOMRow();
});
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState !== "hidden" ||
    (tldrawPersistTimer === null && tldrawViewPersistTimer === null)
  ) {
    return;
  }
  clearTimeout(tldrawPersistTimer);
  tldrawPersistTimer = null;
  clearTimeout(tldrawViewPersistTimer);
  tldrawViewPersistTimer = null;
  saveActiveTldrawSnapshot();
  if (tldrawEditor && tldrawEditorProjectId === scope) {
    saveTldrawView(
      tldrawEditorProjectId,
      tldrawEditor.getCurrentPageId(),
      tldrawEditor.getCamera(),
    );
  }
  persist();
});
$("#close-dialog").onclick = () => $("#dialog").close();
$("#dialog").onclick = (e) => {
  if (e.target === $("#dialog")) $("#dialog").close();
};
$("#backup-input").onchange = (e) => {
  importBackup(e.target.files[0]);
  e.target.value = "";
};
$("#tldraw-board-restore-input").onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const snapshot = parsed?.snapshot;
    const records = snapshot?.store;
    if (
      parsed?.type !== "exo-tldraw-page-backup" ||
      !parsed.pageId ||
      !records ||
      typeof records !== "object" ||
      !Object.values(records).some(
        (record) => record.typeName === "page" && record.id === parsed.pageId,
      )
    ) {
      throw new Error("That file is not a valid Tldraw page backup.");
    }
    if (parsed.projectId !== tldrawEditorProjectId || tldrawEditorProjectId !== scope) {
      throw new Error(
        `This backup belongs to ${parsed.projectName || parsed.projectId}, not ${nameOf(scope)}.`,
      );
    }
    const projectName = nameOf(tldrawEditorProjectId);
    if (
      !confirm(
        `Restore the "${parsed.pageName || parsed.pageId}" page in ${projectName}? The current page content will be replaced for everyone.`,
      )
    ) {
      return;
    }
    if (googleAccessToken) {
      try {
        await backupBoardToDrive(tldrawEditorProjectId);
      } catch (error) {
        warn("Safety backup failed: " + error.message);
      }
    }
    if (view === "canvas") disposeTldrawBoard();
    state = {
      ...state,
      projectDrawings: {
        ...state.projectDrawings,
        [tldrawEditorProjectId]: replacePageInSnapshot(
          boardBackupSnapshot(tldrawEditorProjectId) || { store: {} },
          snapshot,
          parsed.pageId,
        ),
      },
    };
    await persist();
    render();
    notify("Board page restored. Other people need to reload to see it.");
  } catch (error) {
    notify("Board restore failed: " + error.message);
  }
};
(async () => {
  if (!(await checkForAppUpdate())) return;
  try {
    const { data, error } = await supabaseClient
      .from("workspace_state")
      .select("data")
      .eq("id", 1)
      .single();

    if (error || !data?.data) throw error || new Error("Workspace row was not found.");
    const needsDrawingMigration =
      Number(data.data.drawingSchemaVersion || 0) < 2;
    state = normalizeWorkspaceState(data?.data);
    if (migratedPageIds.size) await remapSavedTldrawViews();
    workspaceLoaded = true;
    storageAvailable = true;
    if (needsDrawingMigration) await persist();
    for (const project of state.projects) {
      try {
        await ensureProjectRecord(project);
      } catch (error) {
        if (error?.code === "42501" || error?.status === 403) {
          console.warn(
            `Project registration is blocked by RLS for ${project.name}. ` +
              "Apply the projects insert policy from supabase-schema.sql.",
          );
        } else {
          console.warn(`Project registration failed for ${project.name}:`, error);
        }
      }
    }
    // Listen for live updates from other team members
    workspaceChannel = supabaseClient
      .channel("workspace-updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "workspace_state",
          filter: "id=eq.1",
        },
        (payload) => {
          if (payload.new && payload.new.data) {
            const nextState = normalizeWorkspaceState(payload.new.data);
            const activeDrawing =
              view === "canvas" &&
              tldrawEditor &&
              tldrawEditorProjectId &&
              tldrawEditorProjectId === scope &&
              snapshotTldrawStore(tldrawEditor.store);
            state = activeDrawing
              ? {
                  ...nextState,
                  projectDrawings: {
                    ...nextState.projectDrawings,
                    [tldrawEditorProjectId]: activeDrawing,
                  },
                }
              : nextState;

            if (view !== "canvas") {
              render();
            }
          }
        },
      )
      .subscribe();
    $("#save-status").textContent = "Workspace synced";
  } catch (error) {
    $("#save-status").textContent = "Sync failed";
    warn("Could not load the workspace. Saving is disabled until you reload.");
  }
  await checkUserSession();
  setView(view);
  render();
  if (workspaceLoaded && googleAccessToken) {
    (async () => {
      for (const project of state.projects) {
        try {
          await backupBoardToDrive(project.id);
        } catch (error) {
          console.warn(
            `Automatic board backup failed for ${project.name}:`,
            error,
          );
        }
      }
    })();
  }
})();
