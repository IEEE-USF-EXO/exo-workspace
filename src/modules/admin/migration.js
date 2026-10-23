import { PROJECTS_DRIVE_FOLDER_ID } from "../../core/config.js";
import { boardRecordRow, upsertBoardRecords } from "../board/data.js";

const allowedTypes = new Set(["page", "shape", "asset", "binding"]);

function drawingStore(drawing) {
  return drawing?.document?.store || drawing?.store || {};
}

function decodeDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  return {
    contentType: match[1] || "application/octet-stream",
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

export async function inspectLegacyDrawings(supabase) {
  const { data, error } = await supabase
    .from("workspace_state")
    .select("data")
    .eq("id", 1)
    .single();
  if (error) throw error;
  const drawings = data?.data?.projectDrawings || {};
  return Object.entries(drawings).map(([projectId, drawing]) => {
    const records = Object.values(drawingStore(drawing)).filter((record) =>
      allowedTypes.has(record?.typeName),
    );
    const recordsById = new Map(records.map((record) => [record.id, record]));
    return {
      projectId,
      recordCount: records.length,
      pages: records.filter((record) => record.typeName === "page").length,
      unresolved: records.filter(
        (record) =>
          record.typeName !== "page" &&
          record.typeName !== "asset" &&
          !record.pageId &&
          !record.parentId &&
          !record.fromId,
      ).length,
      records,
      recordsById,
    };
  });
}

export async function alignLegacyProjectsWithDrive(
  supabase,
  drive,
  dryRun = true,
) {
  const [{ data: workspace, error: workspaceError }, { data: projects, error }] =
    await Promise.all([
      supabase.from("workspace_state").select("data").eq("id", 1).single(),
      supabase
        .from("projects")
        .select("id, name, drive_folder_id")
        .is("drive_folder_id", null),
    ]);
  if (workspaceError) throw workspaceError;
  if (error) throw error;
  const folders = await drive.list(
    PROJECTS_DRIVE_FOLDER_ID,
    "mimeType = 'application/vnd.google-apps.folder'",
  );
  const legacyProjects = workspace?.data?.projects || [];
  const results = [];
  for (const project of projects || []) {
    const legacy = legacyProjects.find(
      (candidate) =>
        String(candidate.name || "").trim().toLowerCase() ===
        String(project.name || "").trim().toLowerCase(),
    );
    const folder = folders.find(
      (candidate) =>
        String(candidate.name || "").trim().toLowerCase() ===
        String((legacy || project).name || "").trim().toLowerCase(),
    );
    if (!folder) {
      results.push({ projectId: project.id, matched: false });
      continue;
    }
    if (!dryRun) {
      const { error: updateError } = await supabase
        .from("projects")
        .update({ drive_folder_id: folder.id, name: folder.name })
        .eq("id", project.id);
      if (updateError) throw updateError;
    }
    results.push({
      projectId: project.id,
      driveFolderId: folder.id,
      matched: true,
      dryRun,
    });
  }
  return results;
}

export async function migrateLegacyDrawings(supabase, userId, dryRun = true) {
  const reports = await inspectLegacyDrawings(supabase);
  const result = [];
  for (const report of reports) {
    const { data: existing, error: boardError } = await supabase
      .from("boards")
      .select("id")
      .eq("project_id", report.projectId)
      .eq("name", "Main board")
      .maybeSingle();
    if (boardError) throw boardError;
    let board = existing;
    if (!board && dryRun) board = { id: "dry-run", project_id: report.projectId };
    if (!board && !dryRun) {
      const { data, error } = await supabase
        .from("boards")
        .insert({
          project_id: report.projectId,
          name: "Main board",
          created_by: userId,
        })
        .select("id, project_id")
        .single();
      if (error) throw error;
      board = data;
    }
    const rows = report.records.map((record) =>
      boardRecordRow(board.id, record, report.recordsById, userId),
    );
    if (!dryRun) {
      const assets = rows.filter((row) => row.type_name === "asset");
      for (const row of assets) {
        const decoded = decodeDataUrl(row.data?.props?.src);
        if (!decoded) continue;
        const path = `${board.id}/${row.record_id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const { error: uploadError } = await supabase.storage
          .from("board-assets")
          .upload(path, decoded.bytes, {
            contentType: decoded.contentType,
            upsert: true,
          });
        if (uploadError) throw uploadError;
        row.data = {
          ...row.data,
          props: { ...row.data.props, src: path },
        };
      }
      await upsertBoardRecords(supabase, rows);
    }
    result.push({
      projectId: report.projectId,
      boardId: board.id,
      recordCount: rows.length,
      unresolved: rows.filter((row) => row.page_id === null).length,
      dryRun,
    });
  }
  return result;
}
