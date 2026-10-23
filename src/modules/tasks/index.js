import { listTasks, saveTask } from "./data.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "tasks",
  nav: { label: "Tasks", order: 30, view: "tasks" },
  async init() {},
  async mount(element, ctx) {
    let showEverything = false;
    const render = async () => {
      const tasks = await listTasks(ctx.supabase, ctx.route.projectId, showEverything, ctx.session.user.id);
      element.innerHTML = `<section><h1>Tasks</h1><button data-lens>Show ${showEverything ? "my lens" : "everything"}</button><div>${tasks
        .map((task) => `<article><strong>${escapeHtml(task.title)}</strong><span> ${escapeHtml(task.status)}</span><p>${escapeHtml(task.description)}</p></article>`)
        .join("") || "<p>No tasks in this lens.</p>"}</div><form data-new-task><input name="title" placeholder="Task title" required><button>Create task</button></form></section>`;
      element.querySelector("[data-lens]").addEventListener("click", async () => {
        showEverything = !showEverything;
        await render();
      });
      element.querySelector("[data-new-task]").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await saveTask(ctx.supabase, {
          project_id: ctx.route.projectId,
          title: form.get("title"),
          created_by: ctx.session.user.id,
        });
        await render();
      });
    };
    await render();
  },
  unmount() {},
};
