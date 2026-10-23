import { PROJECTS_DRIVE_FOLDER_ID } from "../../core/config.js";

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

export async function listProjects(drive) {
  const folders = await drive.list(
    PROJECTS_DRIVE_FOLDER_ID,
    "mimeType = 'application/vnd.google-apps.folder'",
    { bypassCache: true },
  );
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    description: "",
    status: "active",
    drive_folder_id: folder.id,
    archived_at: null,
    created_at: folder.modifiedTime || null,
  }));
}

export async function createProject(supabase, drive, name, userId) {
  const folder = await drive.createFolder(name, PROJECTS_DRIVE_FOLDER_ID);
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
  let folders;
  try {
    folders = await drive.list(
      PROJECTS_DRIVE_FOLDER_ID,
      `mimeType = 'application/vnd.google-apps.folder'`,
      { bypassCache: true },
    );
  } catch (error) {
    console.warn("Drive project reconciliation skipped: folder listing failed.", error);
    return { skipped: true };
  }
  for (const folder of folders) {
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
    if (insertError && insertError.code !== "23505") throw insertError;
    const projectId = project?.id || folder.id;
    if (!(await listBoards(supabase, projectId)).length) {
      await createBoard(supabase, projectId, "Main board", userId);
    }
  }
  return { skipped: false, count: folders.length, archivedIds: [] };
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
