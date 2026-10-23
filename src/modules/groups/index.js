import { createGroup, listGroups } from "./data.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "groups",
  nav: { label: "Groups", order: 20, view: "groups" },
  async init() {},
  async mount(element, ctx) {
    const groups = await listGroups(ctx.supabase, ctx.route.projectId);
    element.innerHTML = `<section><h1>Groups</h1><div data-groups>${groups
      .map((group) => `<article><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.description)}</p></article>`)
      .join("") || "<p>No active groups.</p>"}</div><form data-new-group><input name="name" placeholder="Group name" required><input name="description" placeholder="Description"><button>Create group</button></form></section>`;
    element.querySelector("[data-new-group]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await createGroup(ctx.supabase, ctx.route.projectId, form.get("name"), form.get("description") || "", ctx.session.user.id);
      await this.mount(element, ctx);
    });
  },
  unmount() {},
};
