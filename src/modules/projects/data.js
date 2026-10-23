export async function listProjects(supabase, includeArchived = false) {
  let query = supabase
    .from("projects")
    .select("id, name, description, status, drive_folder_id, created_at")
    .order("name");
  if (!includeArchived) query = query.neq("status", "archived");
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
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

export async function createBoard(supabase, projectId, name = "Main board") {
  const { data, error } = await supabase
    .from("boards")
    .insert({ project_id: projectId, name })
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
