const legacyViews = {
  "drawing-board": "overview",
  files: "files",
  bom: "bom",
  gallery: "gallery",
  repos: "resources",
};

export function parseRoute(hash = window.location.hash) {
  const value = hash.replace(/^#\/?/, "");
  if (legacyViews[value]) {
    return { redirect: `#/p/default/${legacyViews[value]}` };
  }
  if (value === "admin") return { name: "admin" };
  const parts = value.split("/").filter(Boolean);
  if ((!parts[0] || !parts[1]) && parts[0] !== "p") {
    return { name: "default" };
  }
  const isPrefixed = parts[0] === "p";
  const projectKey = isPrefixed ? parts[1] : parts[0];
  const view = isPrefixed ? parts[2] : parts[1];
  if (!projectKey || !view) return { name: "default" };
  return {
    name: "project",
    projectKey: decodeURIComponent(projectKey),
    projectId: decodeURIComponent(projectKey),
    view: decodeURIComponent(view),
    param: parts[isPrefixed ? 3 : 2] ? decodeURIComponent(parts[isPrefixed ? 3 : 2]) : null,
  };
}

export function navigate(route) {
  window.location.hash =
    route.name === "admin"
      ? "#/admin"
      : `#/${encodeURIComponent(route.projectSlug || route.projectId)}/${encodeURIComponent(route.view)}${
          route.param ? `/${encodeURIComponent(route.param)}` : ""
        }`;
}
