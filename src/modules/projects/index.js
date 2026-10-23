import { createBoard, listBoards, listProjects, updateBoard } from "./data.js";
import { escapeHtml } from "../../core/ui.js";
import { ROOT_DRIVE_FOLDER_ID } from "../../core/config.js";

export default {
  id: "projects",
  nav: { label: "Projects", order: 10, view: "projects" },
  async init(ctx) {
    ctx.projects = await listProjects(ctx.supabase);
    ctx.boards = new Map();
    for (const project of ctx.projects) {
      ctx.boards.set(project.id, await listBoards(ctx.supabase, project.id));
    }
  },
  async mount(element, ctx) {
    const project = ctx.projects.find((item) => item.id === ctx.route.projectId);
    if (!project) {
      element.innerHTML = "<p>Project not found.</p>";
      return;
    }
    const boards = ctx.boards.get(project.id) || [];
    let driveFolderMissing = false;
    if (project.drive_folder_id && ctx.drive.status() === "ok") {
      const rootItems = await ctx.drive.list(ROOT_DRIVE_FOLDER_ID);
      driveFolderMissing = !rootItems.some(
        (item) => item.id === project.drive_folder_id,
      );
    }
    element.innerHTML = `
      <section class="projects-screen">
        <label>Project
          <select data-project-switcher>${ctx.projects
            .map(
              (item) =>
                `<option value="${escapeHtml(item.id)}" ${
                  item.id === project.id ? "selected" : ""
                }>${escapeHtml(item.name)}</option>`,
            )
            .join("")}</select>
        </label>
        <h1>${escapeHtml(project.name)}</h1>
        <p>${escapeHtml(project.description)}</p>
        ${
          project.drive_folder_id && !driveFolderMissing
            ? ""
            : '<p role="status">Drive folder missing. Project data remains available, but Drive files and gallery items are unavailable until a folder is linked.</p>'
        }
        <h2>Boards</h2>
        <div>${boards
          .map(
            (board) =>
              `<button type="button" data-board-id="${board.id}">${escapeHtml(board.name)}</button>`,
          )
          .join("") || "<p>No boards yet.</p>"}</div>
        <button type="button" data-create-board>Create board</button>
      </section>`;
    element.querySelector("[data-project-switcher]")?.addEventListener("change", (event) => {
      window.location.hash = `#/p/${encodeURIComponent(event.target.value)}/projects`;
    });
    element.querySelectorAll("[data-board-id]").forEach((button) => {
      button.addEventListener("click", () => {
        window.location.hash = `#/p/${encodeURIComponent(project.id)}/board/${button.dataset.boardId}`;
      });
    });
    element.querySelector("[data-create-board]")?.addEventListener("click", async () => {
      const board = await createBoard(ctx.supabase, project.id);
      ctx.boards.set(project.id, [...boards, board]);
      await this.mount(element, ctx);
    });
  },
  unmount() {},
  async onProjectChange(projectId, ctx) {
    ctx.boards.set(projectId, await listBoards(ctx.supabase, projectId));
  },
  updateBoard,
};
