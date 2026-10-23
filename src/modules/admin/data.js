export async function pendingMembers(supabase) {
  const { data, error } = await supabase
    .from("members")
    .select("user_id, display_name, email, status, created_at")
    .eq("status", "pending")
    .order("created_at");
  if (error) throw error;
  return data || [];
}

export async function setMemberStatus(supabase, userId, status) {
  const { error } = await supabase
    .from("members")
    .update({
      status,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    })
    .eq("user_id", userId);
  if (error) throw error;
}

export async function updateProjectStatus(supabase, projectId, status) {
  const { error } = await supabase
    .from("projects")
    .update({ status })
    .eq("id", projectId);
  if (error) throw error;
}
