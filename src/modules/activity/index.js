import { escapeHtml } from "../../core/ui.js";

export default {
  id: "activity",
  nav: { label: "Activity", order: 80, view: "activity" },
  async init() {},
  async mount(element, ctx) {
    const { data, error } = await ctx.supabase
      .from("events")
      .select("id, type, entity_type, entity_id, payload, created_at")
      .eq("project_id", ctx.route.projectId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    element.innerHTML = `<section><h1>Activity</h1><ul>${(data || [])
      .map((item) => `<li>${escapeHtml(item.type)} · ${escapeHtml(item.created_at)}</li>`)
      .join("") || "<li>No activity yet.</li>"}</ul></section>`;
  },
  unmount() {},
};
