const PAGE_SIZE = 500;

export async function getBoard(supabase, boardId) {
  const { data, error } = await supabase
    .from("boards")
    .select("id, project_id, name, archived_at, projects!inner(drive_folder_id)")
    .eq("id", boardId)
    .single();
  if (error) throw error;
  return {
    ...data,
    drive_folder_id: data.projects?.drive_folder_id || null,
    projects: undefined,
  };
}

export async function fetchBoardRecords(supabase, boardId, afterRev = 0) {
  const records = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("board_records")
      .select("board_id, record_id, type_name, page_id, data, deleted, rev")
      .eq("board_id", boardId)
      .gt("rev", afterRev)
      .order("rev")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    records.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return records;
}

export async function upsertBoardRecords(supabase, rows) {
  for (let offset = 0; offset < rows.length; offset += 200) {
    const { error } = await supabase
      .from("board_records")
      .upsert(rows.slice(offset, offset + 200), {
        onConflict: "board_id,record_id",
      });
    if (error) throw error;
  }
}

export function pageIdForRecord(record, recordsById, visited = new Set()) {
  if (!record || visited.has(record.id)) return null;
  visited.add(record.id);
  if (record.typeName === "page") return record.id;
  if (record.typeName === "binding") {
    const shape = recordsById.get(record.fromId);
    return pageIdForRecord(shape, recordsById, visited);
  }
  return record.parentId
    ? pageIdForRecord(recordsById.get(record.parentId), recordsById, visited)
    : null;
}

export function boardRecordRow(boardId, record, recordsById, userId) {
  return {
    board_id: boardId,
    record_id: record.id,
    type_name: record.typeName,
    page_id: pageIdForRecord(record, recordsById),
    data: record,
    deleted: false,
    updated_by: userId,
  };
}
