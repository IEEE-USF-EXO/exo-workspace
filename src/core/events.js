export function createEventLogger(supabase, userId) {
  return async function log(event) {
    const { error } = await supabase.from("events").insert({
      ...event,
      actor_id: userId,
    });
    if (error) console.error("Event log failed", error);
  };
}
