export async function listGroups(supabase, projectId) {
  const { data, error } = await supabase
    .from("groups")
    .select("id, name, description, archived_at, project_id")
    .or(`project_id.eq.${projectId},project_id.is.null`)
    .is("archived_at", null)
    .order("name");
  if (error) throw error;
  return data || [];
}

export async function createGroup(supabase, projectId, name, description, userId) {
  const { data, error } = await supabase
    .from("groups")
    .insert({ project_id: projectId, name, description, created_by: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}
