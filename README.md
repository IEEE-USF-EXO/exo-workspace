# EXO dashboard — standalone HTML prototype

Open **EXO-Dashboard.html** in Chrome, Edge, Firefox, or Safari. Double-click the file; no installation, hosting, ChatGPT login, or build step is needed. The HTML contains its own styles and JavaScript and uses no online libraries.

## Drawing board

The board starts blank. It does not generate flowcharts or project steps.

- **Add card:** write a title and assign a project, team, owner, and notes. Drag cards to position them. Double-click empty space to place a card there.
- **Draw:** drag with the mouse, pen, or touch to sketch freehand. Choose a pen color in the toolbar.
- **Connect:** click one card, then another to draw an arrow. Select the arrow to write the relationship label and notes.
- **All projects:** show cards from every project so you can connect work across project boundaries. Select a project to focus on its own work.
- **Details panel:** edit card details, attach references to uploaded files, and inspect relationships to other teams or projects.
- **Pan and zoom:** use Pan to drag around the board and the +/− buttons to zoom. Undo reverses recent board changes. Select a card, connection, or pen stroke and use its Remove button to delete it.
- Keyboard shortcuts: **V** select, **P** draw, **C** connect, **H** pan, **Ctrl/Cmd+Z** undo, **Delete** remove selection, **Escape** deselect.

## Files, BOM, and photos

- Add files to a project and team. Files are stored locally in your browser, with a 25 MB limit per file.
- Select any uploaded project file as its **Master BOM**. CSV files up to 5 MB and 10,000 rows display in a searchable table. Excel, PDF, and other source files can be downloaded and opened in their original applications.
- Add PNG, JPEG, WebP, GIF, or AVIF photos to the **Photo gallery**. Click a photo for a larger view. Notes added with photos serve as captions.
- The workspace begins with EXO and PID Spoon. **New project** adds a separate project you can use throughout the prototype.
- No sample drawings, BOM rows, photos, or uploaded engineering files are preloaded.

## Where it saves

Projects, drawings, relationships, file metadata, and file contents save in **IndexedDB inside the current browser profile on your computer**. The HTML itself is not rewritten when you edit the board.

Browser storage is not shared with other devices or browsers. Private browsing, clearing browser data, or moving the HTML file may affect access to saved work. The interface reports save failures instead of treating them as successful uploads.

Use **Export backup** to download a JSON file containing the workspace and uploaded files. To move or share it, send both the HTML and that JSON file. The recipient opens the HTML and chooses **Import backup**. Import replaces the local workspace after confirmation. Export before importing if you need to keep both versions. Imports support backups up to 200 MB.

This is a local prototype, so it has no live multiuser editing or access controls. A person receiving an exported backup can read the data and files it contains. Public hosting and shared storage would be a separate implementation.

## GitHub and Drive

The Resources view includes the project repositories and documented team Drive folders. Links open those services and use their existing permissions.

In Files, **GitHub uploader** opens GitHub's own upload screen for a selected repository and folder. Select the file and complete the commit or new branch there. It does not transfer browser-stored files automatically, and this HTML contains no GitHub token. Download a locally stored file first if you need to select it in GitHub's uploader.

This prototype does not connect to the previous ChatGPT-hosted dashboard, its Cloudflare storage, or its uploaded files. Download any files you want to reuse from that dashboard and add them here.

## Files to keep

- `EXO-Dashboard.html` — the complete application.
- `README.md` — these instructions.
- Your exported `exo-workspace-backup-YYYY-MM-DD.json` files — your data backups, created when you choose Export.

No server or cloud subscription is needed to use the prototype.
