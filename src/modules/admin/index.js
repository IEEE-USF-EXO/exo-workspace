import { pendingMembers, setMemberStatus } from "./data.js";
import { migrateLegacyDrawings } from "./migration.js";
import { escapeHtml } from "../../core/ui.js";

export default {
  id: "admin",
  nav: { label: "Admin", order: 100, view: "admin" },
  async init() {},
  async mount(element, ctx) {
    const members = await pendingMembers(ctx.supabase);
    element.innerHTML = `
      <section class="admin-screen">
        <h1>Administration</h1>
        <h2>Pending members</h2>
        <div class="admin-members">${
          members.length
            ? members
                .map(
                  (member) => `
                    <article class="admin-member">
                      <span>${escapeHtml(member.display_name || member.email)}</span>
                      <button type="button" data-user-id="${member.user_id}" data-status="approved">Approve</button>
                      <button type="button" data-user-id="${member.user_id}" data-status="disabled">Disable</button>
                    </article>`,
                )
                .join("")
            : "<p>No pending members.</p>"
        }</div>
        <h2>Legacy board migration</h2>
        <p>Run a dry report before importing legacy drawing records. The source workspace is never modified.</p>
        <button type="button" data-migration="dry-run">Preview migration</button>
        <button type="button" data-migration="run">Run migration</button>
        <pre data-migration-report hidden></pre>
      </section>`;
    element.querySelectorAll("[data-user-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await setMemberStatus(
            ctx.supabase,
            button.dataset.userId,
            button.dataset.status,
          );
          await this.mount(element, ctx);
        } catch (error) {
          console.error("Could not update member status", error);
          element.insertAdjacentHTML(
            "afterbegin",
            `<p role="alert">Could not update member: ${escapeHtml(error.message)}</p>`,
          );
          button.disabled = false;
        }
      });
      element.querySelectorAll("[data-migration]").forEach((button) => {
        button.addEventListener("click", async () => {
          const report = element.querySelector("[data-migration-report]");
          button.disabled = true;
          try {
            const results = await migrateLegacyDrawings(
              ctx.supabase,
              ctx.session.user.id,
              button.dataset.migration === "dry-run",
            );
            report.hidden = false;
            report.textContent = JSON.stringify(results, null, 2);
          } catch (error) {
            report.hidden = false;
            report.textContent = `Migration failed: ${error.message}`;
          } finally {
            button.disabled = false;
          }
        });
      });
    });
  },
  unmount() {},
};
