export async function listTasks(supabase, projectId, showEverything = false, userId = null) {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, project_id, group_id, title, description, status, assignee_id, due_date, completed_at")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  if (showEverything || !userId) return data || [];
  const { data: memberships, error: membershipError } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("user_id", userId);
  if (membershipError) throw membershipError;
  const groupIds = new Set((memberships || []).map((item) => item.group_id));
  return (data || []).filter((task) => !task.group_id || groupIds.has(task.group_id));
}

export async function saveTask(supabase, values) {
  const { data, error } = await supabase
    .from("tasks")
    .upsert(values)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function hasDependencyPath(supabase, startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  const { data, error } = await supabase
    .from("task_dependencies")
    .select("depends_on_task_id")
    .eq("task_id", startId);
  if (error) throw error;
  for (const dependency of data || []) {
    if (await hasDependencyPath(supabase, dependency.depends_on_task_id, targetId, seen)) return true;
  }
  return false;
}
