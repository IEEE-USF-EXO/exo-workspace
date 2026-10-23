import { drive, DriveAuthError } from "../../services/drive/index.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "gallery",
  nav: { label: "Gallery", order: 50, view: "gallery" },
  async init() {},
  async mount(element, ctx) {
    const project = ctx.projects.find((item) => item.id === ctx.route.projectId);
    element.innerHTML = `<section class="gallery-screen"><h1>Photo gallery</h1><p data-gallery-status>Loading photos…</p><div data-gallery></div></section>`;
    try {
      if (!project?.drive_folder_id) {
        throw new Error("This project is not linked to a Drive folder.");
      }
      const files = await drive.list(
        project.drive_folder_id,
        "mimeType contains 'image/'",
      );
      element.querySelector("[data-gallery-status]").textContent = `${files.length} photos`;
      element.querySelector("[data-gallery]").innerHTML = files
        .map((file) => `<a href="${escapeHtml(file.webViewLink || "#")}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a>`)
        .join("<br>") || "<p>No photos found.</p>";
    } catch (error) {
      element.querySelector("[data-gallery-status]").textContent =
        error instanceof DriveAuthError ? "Reconnect Google Drive to browse photos." : error.message;
    }
  },
  unmount() {},
};
