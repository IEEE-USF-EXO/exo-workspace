// Profile-based navigation only; Google Drive still checks its sharing settings.
(() => {
  function foldersForProfile({ ready, userId, previewTeamId, teams, memberships, leadership, rootFolder, teamFolders }) {
    if (!ready) return [];
    const roles = leadership.filter(role => userId && role.user_id === userId && !role.revoked_at);
    const chair = roles.some(role => role.role === 'exo_chair' && !role.team_id && !role.project_id);
    if (chair && !previewTeamId) return [rootFolder, ...teamFolders];

    const byId = new Map(teams.map(team => [team.id, team]));
    const rootNames = new Set();
    const groupIds = previewTeamId ? [previewTeamId] : [
      ...memberships.filter(member => userId && member.user_id === userId).map(member => member.team_id),
      ...roles.filter(role => ['team_lead', 'project_lead'].includes(role.role)).map(role => role.team_id),
    ];
    for (const id of groupIds) {
      let team = byId.get(id);
      const seen = new Set();
      while (team && !team.archived_at && !seen.has(team.id)) {
        seen.add(team.id);
        if (!team.parent_team_id) {
          rootNames.add(team.name.trim().toLowerCase());
          break;
        }
        team = byId.get(team.parent_team_id);
      }
    }
    return teamFolders.filter(folder => rootNames.has(folder.team.trim().toLowerCase()));
  }

  globalThis.EXO_FILES = Object.freeze({ foldersForProfile });
})();
