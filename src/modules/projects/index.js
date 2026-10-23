import {
  archiveProject,
  createBoard,
  createProject,
  listBoards,
  listProjects,
  persistProjectSelection,
  projectHash,
  updateBoard,
} from "./data.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "projects",
  nav: { label: "Projects", order: 10, view: "projects" },
  async init(ctx) {
    ctx.projects = await listProjects(ctx.drive);
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
          project.drive_folder_id
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
        <button type="button" data-create-project>Create project</button>
        <button type="button" data-delete-project>Delete project</button>
      </section>`;
    element.querySelector("[data-project-switcher]")?.addEventListener("change", (event) => {
      const next = ctx.projects.find((item) => item.id === event.target.value);
      if (!next) return;
      persistProjectSelection(next);
      window.location.hash = projectHash(next, "projects");
    });
    element.querySelectorAll("[data-board-id]").forEach((button) => {
      button.addEventListener("click", () => {
        window.location.hash = `#/p/${encodeURIComponent(project.id)}/board/${button.dataset.boardId}`;
      });
    });
    element.querySelector("[data-create-project]")?.addEventListener("click", async () => {
      const name = window.prompt("Project name");
      if (!name?.trim()) return;
      try {
        const { project } = await createProject(
          ctx.supabase,
          ctx.drive,
          name.trim(),
          ctx.session.user.id,
        );
        persistProjectSelection(project);
        window.location.hash = projectHash(project, "projects");
      } catch (error) {
        console.error("Project could not be created", error);
        element.insertAdjacentHTML(
          "afterbegin",
          `<p role="alert">Project could not be created: ${escapeHtml(error.message)}</p>`,
        );
      }
    });
    element.querySelector("[data-delete-project]")?.addEventListener("click", async () => {
      if (!project.drive_folder_id || !window.confirm(`Move "${project.name}" to Drive trash?`)) return;
      await archiveProject(ctx.supabase, ctx.drive, project);
      const next = ctx.projects.find((item) => item.id !== project.id);
      if (next) {
        persistProjectSelection(next);
        window.location.hash = projectHash(next, "projects");
      } else {
        window.location.reload();
      }
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
