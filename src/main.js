import { readAuthState, subscribeToAuthChanges } from "./core/auth.js";
import { supabase } from "./core/supabase.js";
import { drive } from "./../services/drive/index.js";
import { navigate, parseRoute } from "./core/router.js";
import { modules } from "./core/registry.js";
import { screen } from "./core/ui.js";
import {
  persistProjectSelection,
  projectHash,
  projectSlug,
  resolveProject,
  reconcileDriveProjects,
} from "./modules/projects/data.js";

const root = document.querySelector("#phase1-root");
let mountedModule = null;
let mountedElement = null;
let authSubscription;

async function boot() {
  if (!root) return;
  root.hidden = false;
  document.querySelector(".app")?.setAttribute("hidden", "");
  mountedModule?.unmount?.();
  mountedModule = null;
  mountedElement = null;
  screen(root, "Loading EXO workspace", "Checking your session…");
  try {
    const auth = await readAuthState();
    if (!auth.session) {
      screen(root, "Sign in required", "Sign in with Google to continue.");
      return;
    }
    if (!auth.member || auth.member.status !== "approved") {
      screen(
        root,
        "Waiting for approval",
        "Your account is signed in, but an administrator must approve it before workspace data is available.",
      );
      return;
    }
    if (auth.session.provider_token) drive.setToken(auth.session.provider_token);
    const route = parseRoute();
    if (route.redirect) {
      window.location.replace(route.redirect);
      return;
    }
    const ctx = { supabase, ...auth, route, drive };
    const projectModule = modules.find((item) => item.id === "projects");
    let project = null;
    if (route.name !== "admin") {
      await projectModule.init(ctx);
      const resolved = resolveProject(ctx.projects, route);
      project = resolved.project;
      if (project) {
        persistProjectSelection(project);
        const requestedView =
          resolved.source === "hash" && route.name === "project"
            ? route.view
            : "projects";
        const requestedParam =
          resolved.source === "hash" && route.name === "project"
            ? route.param
            : null;
        const expectedHash = projectHash(project, requestedView, requestedParam);
        if (window.location.hash !== expectedHash) {
          navigate({
            name: "project",
            projectId: project.id,
            projectSlug: project.drive_folder_id || projectSlug(project),
            view: requestedView,
            param: requestedParam,
          });
          return;
        }
        ctx.route = {
          ...route,
          name: "project",
          projectId: project.id,
          projectKey: project.id,
          view: requestedView,
          param: requestedParam,
        };
      } else {
        if (drive.status() === "ok") {
          const sync = await reconcileDriveProjects(supabase, drive, auth.session.user.id);
          if (!sync.skipped && sync.count > 0) {
            return boot();
          }
        }
        screen(root, "No active projects", "Create or sync a project from Google Drive to begin.");
        return;
      }
    }
    const module =
      route.name === "admin"
        ? modules.find((item) => item.id === "admin")
        : modules.find((item) => item.nav?.view === route.view) ||
          projectModule;
    if (!module) {
      screen(root, "EXO workspace", "Choose a project to begin.");
      return;
    }
    mountedElement = root;
    mountedModule = module;
    if (module.id !== "projects") await module.init(ctx);
    await module.mount(root, ctx, ctx.route);
    if (drive.status() === "ok" && (project || route.name === "admin")) {
      reconcileDriveProjects(supabase, drive, auth.session.user.id)
        .then((result) => {
          if (project && result.archivedIds?.includes(project.id)) boot();
        })
        .catch((error) =>
          console.error("Background Drive project reconciliation failed", error),
        );
    }
  } catch (error) {
    console.error("Phase 1 boot failed", error);
    screen(root, "Workspace unavailable", error.message);
  }
}

authSubscription = subscribeToAuthChanges(() => boot());
window.addEventListener("hashchange", () => boot());
boot();

window.addEventListener("beforeunload", () => {
  mountedModule?.unmount?.();
  authSubscription?.data?.subscription?.unsubscribe?.();
  mountedElement = null;
});
