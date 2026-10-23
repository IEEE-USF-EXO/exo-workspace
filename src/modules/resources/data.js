export async function listResources(supabase, projectId) {
  const { data, error } = await supabase
    .from("resources")
    .select("id, team, title, url, description, basis, created_at")
    .eq("project_id", projectId)
    .order("created_at");
  if (error) throw error;
  return data || [];
}

export async function createResource(supabase, projectId, values, userId) {
  const { data, error } = await supabase
    .from("resources")
    .insert({ ...values, project_id: projectId, created_by: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}
