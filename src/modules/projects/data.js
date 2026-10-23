import { ROOT_DRIVE_FOLDER_ID } from "../../core/config.js";
import { DriveAuthError, DriveRequestError } from "../../services/drive/index.js";

export function projectSlug(project) {
  return String(project?.name || project?.id || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function persistProjectSelection(project) {
  if (!project) return;
  localStorage.setItem(
    "exo:lastProjectId",
    project.drive_folder_id || project.id,
  );
  localStorage.setItem("exo:lastProjectSlug", projectSlug(project));
}

export function projectHash(project, view = "projects", param = null) {
  return `#/${encodeURIComponent(project.drive_folder_id || projectSlug(project) || project.id)}/${encodeURIComponent(view)}${
    param ? `/${encodeURIComponent(param)}` : ""
  }`;
}

export function resolveProject(projects, route) {
  const active = projects.filter((project) => !project.archived_at);
  const routeKey = route?.projectKey;
  const fromHash = routeKey
    ? active.find(
        (project) =>
          project.id === routeKey ||
          project.drive_folder_id === routeKey ||
          projectSlug(project) === routeKey,
      )
    : null;
  if (fromHash) return { project: fromHash, source: "hash" };
  const savedId = localStorage.getItem("exo:lastProjectId");
  const savedSlug = localStorage.getItem("exo:lastProjectSlug");
  const saved = active.find(
    (project) =>
      project.id === savedId ||
      project.drive_folder_id === savedId ||
      projectSlug(project) === savedSlug,
  );
  return { project: saved || active[0] || null, source: saved ? "storage" : "fallback" };
}

export async function listProjects(supabase, includeArchived = false) {
  let query = supabase
    .from("projects")
    .select("id, name, description, status, drive_folder_id, archived_at, created_at")
    .order("name");
  if (!includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createProject(supabase, drive, name, userId) {
  const folder = await drive.createFolder(name, ROOT_DRIVE_FOLDER_ID);
  const { data, error } = await supabase
    .from("projects")
    .insert({
      id: folder.id,
      name: folder.name || name,
      description: "",
      drive_folder_id: folder.id,
      status: "active",
      created_by: userId,
    })
    .select("id, name, description, status, drive_folder_id, archived_at, created_at")
    .single();
  if (error) throw error;
  const boards = await listBoards(supabase, data.id);
  const board = boards[0] || await createBoard(supabase, data.id, "Main board", userId);
  return { project: data, board };
}

export async function archiveProject(supabase, drive, project) {
  await drive.updateFile(project.drive_folder_id, { trashed: true });
  const { data, error } = await supabase
    .from("projects")
    .update({ archived_at: new Date().toISOString(), status: "archived" })
    .eq("id", project.id)
    .select("id, name, description, status, drive_folder_id, archived_at, created_at")
    .single();
  if (error) throw error;
  return data;
}

export async function reconcileDriveProjects(supabase, drive, userId) {
  let root;
  try {
    root = await drive.getFile(ROOT_DRIVE_FOLDER_ID);
  } catch (error) {
    console.warn("Drive project reconciliation skipped: root authorization/check failed.", error);
    return { skipped: true };
  }
  if (!root || root.trashed) return { skipped: true };
  let folders;
  try {
    folders = await drive.list(
      ROOT_DRIVE_FOLDER_ID,
      `mimeType = 'application/vnd.google-apps.folder'`,
    );
  } catch (error) {
    console.warn("Drive project reconciliation skipped: folder listing failed.", error);
    return { skipped: true };
  }
  const { data: existing, error } = await supabase
    .from("projects")
    .select("id, name, description, status, drive_folder_id, archived_at, created_at")
    .order("name");
  if (error) throw error;
  const byDriveId = new Map((existing || []).filter((item) => item.drive_folder_id).map((item) => [item.drive_folder_id, item]));
  const discoveredIds = new Set();
  const archivedIds = [];
  for (const folder of folders) {
    discoveredIds.add(folder.id);
    const current = byDriveId.get(folder.id);
    if (current) {
      if (current.name !== folder.name || current.archived_at) {
        const { error: updateError } = await supabase
          .from("projects")
          .update({ name: folder.name, archived_at: null, status: "active" })
          .eq("id", current.id);
        if (updateError) throw updateError;
      }
      const boards = await listBoards(supabase, current.id);
      if (!boards.length) await createBoard(supabase, current.id, "Main board", userId);
      continue;
    }
    const { data: project, error: insertError } = await supabase
      .from("projects")
      .insert({
        id: folder.id,
        name: folder.name,
        description: "",
        drive_folder_id: folder.id,
        status: "active",
        created_by: userId,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    if (!(await listBoards(supabase, project.id)).length) {
      await createBoard(supabase, project.id, "Main board", userId);
    }
  }
  for (const project of (existing || []).filter(
    (item) =>
      !item.archived_at &&
      (!item.drive_folder_id || !discoveredIds.has(item.drive_folder_id)),
  )) {
    try {
      if (!project.drive_folder_id) {
        const { error: archiveError } = await supabase
          .from("projects")
          .update({ archived_at: new Date().toISOString(), status: "archived" })
          .eq("id", project.id);
        if (archiveError) throw archiveError;
        archivedIds.push(project.id);
        continue;
      }
      const file = await drive.getFile(project.drive_folder_id);
      if (file.trashed || !file.parents?.includes(ROOT_DRIVE_FOLDER_ID)) {
        const { error: archiveError } = await supabase
          .from("projects")
          .update({ archived_at: new Date().toISOString(), status: "archived" })
          .eq("id", project.id);
        if (archiveError) throw archiveError;
        archivedIds.push(project.id);
      }
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) {
        const { error: archiveError } = await supabase
          .from("projects")
          .update({ archived_at: new Date().toISOString(), status: "archived" })
          .eq("id", project.id);
        if (archiveError) throw archiveError;
        archivedIds.push(project.id);
      } else if (!(error instanceof DriveAuthError)) {
        console.warn(`Could not verify Drive folder ${project.drive_folder_id}; leaving project active.`, error);
      }
    }
  }
  return { skipped: false, count: folders.length, archivedIds };
}

export async function listBoards(supabase, projectId, includeArchived = false) {
  let query = supabase
    .from("boards")
    .select("id, project_id, group_id, name, archived_at, created_at")
    .eq("project_id", projectId)
    .order("created_at");
  if (!includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createBoard(supabase, projectId, name = "Main board", createdBy = null) {
  const { data, error } = await supabase
    .from("boards")
    .insert({ project_id: projectId, name, ...(createdBy ? { created_by: createdBy } : {}) })
    .select("id, project_id, name")
    .single();
  if (error) throw error;
  return data;
}

export async function updateBoard(supabase, boardId, changes) {
  const { data, error } = await supabase
    .from("boards")
    .update(changes)
    .eq("id", boardId)
    .select("id, project_id, name, archived_at")
    .single();
  if (error) throw error;
  return data;
}
