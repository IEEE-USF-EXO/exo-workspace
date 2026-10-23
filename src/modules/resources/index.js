import { listResources } from "./data.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "resources",
  nav: { label: "Resources", order: 60, view: "resources" },
  async init() {},
  async mount(element, ctx) {
    const resources = await listResources(ctx.supabase, ctx.route.projectId);
    element.innerHTML = `<section class="resources-screen"><h1>Resources</h1>${resources
      .map((resource) => `<article><a href="${escapeHtml(resource.url)}" target="_blank" rel="noopener">${escapeHtml(resource.title)}</a><p>${escapeHtml(resource.description)}</p></article>`)
      .join("") || "<p>No resources yet.</p>"}</section>`;
  },
  unmount() {},
};
