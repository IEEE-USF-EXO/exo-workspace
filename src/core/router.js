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
  if (parts[0] !== "p" || !parts[1] || !parts[2]) {
    return { name: "default" };
  }
  return {
    name: "project",
    projectId: decodeURIComponent(parts[1]),
    view: decodeURIComponent(parts[2]),
    param: parts[3] ? decodeURIComponent(parts[3]) : null,
  };
}

export function navigate(route) {
  window.location.hash =
    route.name === "admin"
      ? "#/admin"
      : `#/p/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.view)}`;
}
