import { escapeHtml } from "../../core/ui.js";

export default {
  id: "updates",
  nav: { label: "Updates", order: 70, view: "updates" },
  async init() {},
  async mount(element, ctx) {
    const { data, error } = await ctx.supabase
      .from("updates")
      .select("id, author_name, body, created_at")
      .eq("project_id", ctx.route.projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    element.innerHTML = `<section><h1>Updates</h1>${(data || [])
      .map((item) => `<article><strong>${escapeHtml(item.author_name)}</strong><p>${escapeHtml(item.body)}</p></article>`)
      .join("") || "<p>No updates yet.</p>"}</section>`;
  },
  unmount() {},
};
