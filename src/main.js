import { readAuthState, subscribeToAuthChanges } from "./core/auth.js";
import { supabase } from "./core/supabase.js";
import { drive } from "./../services/drive/index.js";
import { parseRoute } from "./core/router.js";
import { modules } from "./core/registry.js";
import { screen } from "./core/ui.js";

const root = document.querySelector("#phase1-root");
let mountedModule = null;
let mountedElement = null;
let authSubscription;

async function boot() {
  if (!root) return;
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
      project = ctx.projects.find((item) => item.id === route.projectId);
    }
    if (route.name === "default") {
      const fallback = localStorage.getItem("exo:lastProject") || ctx.projects[0]?.id;
      if (fallback) {
        window.location.replace(`#/p/${encodeURIComponent(fallback)}/projects`);
        return;
      }
    }
    if (route.name === "project" && project) {
      localStorage.setItem("exo:lastProject", project.id);
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
    await module.mount(root, ctx, route);
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
