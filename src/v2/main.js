import { createScopeEngine } from "./scope-engine.js";
import { createWorkspaceShell } from "./shell.js";

const HASHES = new Set([
  "overview",
  "tasks",
  "drawing-board",
  "files",
  "bom",
  "gallery",
  "repos",
]);

const viewFromHash = () => {
  const value = window.location.hash.slice(1).toLowerCase();
  return HASHES.has(value) ? value : "overview";
};

const setHash = (view) => {
  const next = `#${view}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
};

const supabaseClient = window.supabase?.createClient(
  "https://tnupwlucufewosslvcaz.supabase.co",
  "******",
  { auth: { persistSession: true, storage: window.localStorage } },
);

const engine = createScopeEngine({
  rootId: "1TEs2PCaDcNQ0nlahtM9FWJKULPTjQAWM",
  rootName: "EXO Workspace",
  token: () => sessionStorage.getItem("google_provider_token"),
});

const shell = createWorkspaceShell({
  root: document.body,
  engine,
  initialView: viewFromHash(),
  onViewChange: (view) => setHash(view),
  onScopeChange: async (scope) => {
    if (window.ExoBoard) window.ExoBoard.setScope(scope);
    await Promise.all([
      shell.loadFiles(scope),
      shell.loadBOM(scope, supabaseClient),
      shell.loadDrawing(scope),
    ]);
  },
  onLogin: async () => {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes: "https://www.googleapis.com/auth/drive",
        queryParams: { access_type: "offline", prompt: "consent" },
        redirectTo: window.location.origin + window.location.pathname + "?app=v2",
      },
    });
    if (error) throw error;
  },
});

window.addEventListener("hashchange", () => shell.setView(viewFromHash()));

try {
  const sessionResult = await supabaseClient?.auth.getSession();
  const providerToken = sessionResult?.data?.session?.provider_token;
  if (providerToken) sessionStorage.setItem("google_provider_token", providerToken);
  await engine.sync();
  shell.render();
  const scope = engine.scope;
  if (window.ExoBoard) window.ExoBoard.setScope(scope);
  await Promise.all([
    shell.loadFiles(scope),
    shell.loadBOM(scope, supabaseClient),
    shell.loadDrawing(scope),
  ]);
} catch (error) {
  shell.showError(error instanceof Error ? error.message : "Drive scopes could not be loaded.");
}
