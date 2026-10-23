import { drive, DriveAuthError } from "../../services/drive/index.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "files",
  nav: { label: "Files", order: 40, view: "files" },
  async init() {},
  async mount(element, ctx) {
    const project = ctx.projects.find((item) => item.id === ctx.route.projectId);
    element.innerHTML = `<section class="files-screen"><h1>Files</h1><p data-drive-status>Loading Drive files…</p><div data-files></div></section>`;
    try {
      if (!project?.drive_folder_id) {
        throw new Error("This project is not linked to a Drive folder.");
      }
      const files = await drive.list(project.drive_folder_id);
      element.querySelector("[data-drive-status]").textContent = `${files.length} items`;
      element.querySelector("[data-files]").innerHTML = files
        .map((file) => `<a href="${escapeHtml(file.webViewLink || "#")}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a>`)
        .join("<br>") || "<p>No files found.</p>";
    } catch (error) {
      element.querySelector("[data-drive-status]").textContent =
        error instanceof DriveAuthError ? "Reconnect Google Drive to browse files." : error.message;
    }
  },
  unmount() {},
};
