import {
  boardRecordRow,
  fetchBoardRecords,
  getBoard,
  upsertBoardRecords,
} from "./data.js";

const allowedTypes = new Set(["page", "shape", "asset", "binding"]);
let active = null;

async function loadTldraw() {
  const [{ createRoot }, { default: React }, { Tldraw }] = await Promise.all([
    import("https://esm.sh/react-dom@18/client"),
    import("https://esm.sh/react@18"),
    import("https://esm.sh/tldraw@3.15.6"),
  ]);
  return { createRoot, React, Tldraw };
}

function recordsForEditor(rows) {
  return rows
    .filter((row) => !row.deleted && allowedTypes.has(row.type_name))
    .map((row) => row.data);
}

export default {
  id: "board",
  async init() {},
  async mount(element, ctx, params = ctx.route) {
    const boardId = params.param;
    if (!boardId) throw new Error("A board id is required.");
    const board = await getBoard(ctx.supabase, boardId);
    element.innerHTML = '<section class="board-screen"><div data-board-canvas></div><p data-board-status>Loading board…</p></section>';
    const container = element.querySelector("[data-board-canvas]");
    const rows = await fetchBoardRecords(ctx.supabase, board.id);
    const { createRoot, React, Tldraw } = await loadTldraw();
    const root = createRoot(container);
    active = { board, root, editor: null, channel: null, unlisten: null };
    root.render(
      React.createElement(Tldraw, {
        onMount: async (editor) => {
          if (!active || active.root !== root) return;
          active.editor = editor;
          const records = recordsForEditor(rows);
          if (records.length) editor.store.mergeRemoteChanges(() => editor.store.put(records));
          if (!records.some((record) => record.typeName === "page")) {
            const page = editor.getCurrentPage();
            const recordsById = new Map(
              Object.values(editor.store.getStoreSnapshot().store).map((record) => [record.id, record]),
            );
            await upsertBoardRecords(ctx.supabase, [
              boardRecordRow(board.id, page, recordsById, ctx.session.user.id),
            ]);
          }
          const status = element.querySelector("[data-board-status]");
          if (status) status.remove();
          active.channel = ctx.supabase
            .channel(`board:${board.id}`)
            .on("broadcast", { event: "board-changes" }, ({ payload }) => {
              if (!payload || payload.clientId === ctx.session.user.id) return;
              const incoming = [...(payload.put || [])];
              editor.store.mergeRemoteChanges(() => {
                editor.store.put(incoming);
                editor.store.remove(payload.remove || []);
              });
            })
            .subscribe();
          active.unlisten = editor.store.listen(
            async ({ changes, source }) => {
              if (source !== "user") return;
              const put = [...Object.values(changes.added || {}), ...Object.values(changes.updated || {})]
                .map((change) => Array.isArray(change) ? change[1] : change)
                .filter((record) => allowedTypes.has(record.typeName));
              const remove = Object.keys(changes.removed || {});
              const recordsById = new Map(
                Object.values(editor.store.getStoreSnapshot().store).map((record) => [record.id, record]),
              );
              const rowsToSave = put.map((record) =>
                boardRecordRow(board.id, record, recordsById, ctx.session.user.id),
              );
              rowsToSave.push(...remove.map((recordId) => ({
                board_id: board.id,
                record_id: recordId,
                type_name: "shape",
                page_id: null,
                data: { id: recordId, typeName: "shape" },
                deleted: true,
                updated_by: ctx.session.user.id,
              })));
              if (rowsToSave.length) await upsertBoardRecords(ctx.supabase, rowsToSave);
              await active.channel?.send({
                type: "broadcast",
                event: "board-changes",
                payload: { clientId: ctx.session.user.id, put, remove },
              });
            },
            { scope: "document", source: "user" },
          );
        },
      }),
    );
  },
  unmount() {
    active?.unlisten?.();
    if (active?.channel) active.channel.unsubscribe();
    active?.root?.unmount?.();
    active = null;
  },
};
