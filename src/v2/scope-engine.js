const FOLDER_MIME = "application/vnd.google-apps.folder";

async function listChildren(parentId, token) {
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and trashed = false`,
    pageSize: "1000",
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime,size),nextPageToken",
  });
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Google Drive scopes could not be loaded (HTTP ${response.status}).`);
  return (await response.json()).files || [];
}

export function createScopeEngine({ rootId, rootName, token }) {
  let teams = [];
  let scope = { containerId: rootId, teamId: rootId, subteamId: rootId };
  const listeners = new Set();
  const childrenFor = (teamId) => teams.find((team) => team.id === teamId)?.subteams || [];

  return {
    get root() { return { id: rootId, name: rootName }; },
    get teams() { return teams; },
    get scope() { return scope; },
    get activeFolderId() { return scope.subteamId; },
    token,
    get children() { return childrenFor(scope.teamId); },
    isContainerScope(folderId) {
      return folderId === rootId || teams.some((team) =>
        team.id === folderId || team.subteams.some((subteam) => subteam.id === folderId));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sync() {
      const accessToken = token();
      if (!accessToken) {
        teams = [];
        return;
      }
      const directChildren = await listChildren(rootId, accessToken);
      const teamFolders = directChildren.filter((item) => item.mimeType === FOLDER_MIME);
      teams = await Promise.all(teamFolders.map(async (team) => ({
        id: team.id,
        name: team.name,
        subteams: (await listChildren(team.id, accessToken))
          .filter((item) => item.mimeType === FOLDER_MIME)
          .map((subteam) => ({ id: subteam.id, name: subteam.name })),
      })));
      const currentTeam = teams.find((team) => team.id === scope.teamId) || teams[0];
      const currentSubteam = currentTeam?.subteams.find((item) => item.id === scope.subteamId);
      scope = {
        containerId: rootId,
        teamId: currentTeam?.id || rootId,
        subteamId: currentSubteam?.id || currentTeam?.id || rootId,
        teamName: currentTeam?.name || "",
        subteamName: currentSubteam?.name || "",
      };
      listeners.forEach((listener) => listener(scope));
    },
    selectTeam(teamId) {
      const team = teams.find((item) => item.id === teamId);
      if (!team) return;
      scope = { containerId: rootId, teamId: team.id, subteamId: team.id, teamName: team.name, subteamName: "" };
      listeners.forEach((listener) => listener(scope));
    },
    selectSubteam(subteamId) {
      const team = teams.find((item) => item.subteams.some((item) => item.id === subteamId));
      const subteam = team?.subteams.find((item) => item.id === subteamId);
      if (!team || !subteam) return;
      scope = { ...scope, teamId: team.id, subteamId, teamName: team.name, subteamName: subteam.name };
      listeners.forEach((listener) => listener(scope));
    },
    listChildren,
  };
}
