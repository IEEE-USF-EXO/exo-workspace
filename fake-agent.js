// A local joke: no chat service, messages, or network requests.
(() => {
  const agent = document.getElementById('fake-agent');
  const launcher = document.getElementById('fake-agent-launcher');
  const chat = document.getElementById('fake-agent-chat');
  const close = document.getElementById('fake-agent-close');
  const dismiss = document.getElementById('fake-agent-dismiss');
  let dismissed = false;

  function setOpen(open) {
    chat.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Close AI chat' : 'Open AI chat');
    (open ? close : launcher).focus();
  }

  launcher.addEventListener('click', () => setOpen(chat.hidden));
  close.addEventListener('click', () => setOpen(false));
  dismiss.addEventListener('click', () => {
    dismissed = true;
    chat.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    if (agent.hidePopover) agent.hidePopover();
    agent.hidden = true;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !chat.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    }
  }, true);

  // Use the top layer so page stacking contexts cannot cover the widget.
  if (agent.showPopover) {
    agent.showPopover();
    document.querySelectorAll('dialog').forEach(dialog => {
      dialog.addEventListener('toggle', () => {
        if (dismissed) return;
        agent.hidePopover();
        agent.showPopover();
      });
    });
  }
})();
