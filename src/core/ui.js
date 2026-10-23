export function screen(root, title, message) {
  root.innerHTML = `<section class="phase1-screen"><h1>${title}</h1><p>${message}</p></section>`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
