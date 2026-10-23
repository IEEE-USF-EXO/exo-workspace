import { fetchBoardRecords } from "./data.js";

async function hashRecords(records) {
  const canonical = JSON.stringify(
    records
      .filter((record) => !record.deleted)
      .sort((left, right) => left.record_id.localeCompare(right.record_id)),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function backupBoard(ctx, board) {
  const records = await fetchBoardRecords(ctx.supabase, board.id);
  const contentHash = await hashRecords(records);
  const { data: latest, error: latestError } = await ctx.supabase
    .from("board_backups")
    .select("id, content_hash")
    .eq("board_id", board.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  if (latest?.content_hash === contentHash) return { result: "skipped", contentHash };
  if (!board.drive_folder_id) {
    throw new Error("Cannot back up this board: its project has no linked Drive folder.");
  }
  const backupRoot = await ctx.drive.ensureFolder("drawing-backups", board.drive_folder_id);
  const boardFolder = await ctx.drive.ensureFolder(
    `${board.name} [${board.id}]`,
    backupRoot.id,
  );

  const payload = {
    type: "exo-board-backup",
    version: 1,
    boardId: board.id,
    boardName: board.name,
    projectId: board.project_id,
    savedAt: new Date().toISOString(),
    tldraw: "3.15.6",
    records: records.filter((record) => !record.deleted),
    contentHash,
  };
  const driveFile = await ctx.drive.uploadJson(
    `${board.name} [${board.id}] ${payload.savedAt}.json`,
    payload,
    boardFolder.id,
  );
  const { error: insertError } = await ctx.supabase.from("board_backups").insert({
    board_id: board.id,
    content_hash: contentHash,
    record_count: payload.records.length,
    drive_file_id: driveFile.id,
    created_by: ctx.session.user.id,
  });
  if (insertError) throw insertError;

  const { data: oldBackups, error: oldError } = await ctx.supabase
    .from("board_backups")
    .select("id")
    .eq("board_id", board.id)
    .order("created_at", { ascending: false })
    .range(30, 1000);
  if (oldError) throw oldError;
  if (oldBackups?.length) {
    const { error: pruneError } = await ctx.supabase
      .from("board_backups")
      .delete()
      .in("id", oldBackups.map((backup) => backup.id));
    if (pruneError) throw pruneError;
  }
  return { result: "saved", contentHash, driveFile };
}
