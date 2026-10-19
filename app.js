'use strict';

// Initialize Supabase Client
const SUPABASE_URL = 'https://tnupwlucufewosslvcaz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXB3bHVjdWZld29zc2x2Y2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTM4MjIsImV4cCI6MjEwNzMyOTgyMn0.4TFRb6t4pE547wywotP_SWZG50NiJzlxs1_Ds51aQmM';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storage: window.localStorage, autoRefreshToken: true }
});

async function signInWithGoogle() {
  await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

async function checkUserSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const statusEl = document.getElementById('save-status');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  if (session) {
    statusEl.textContent = `Logged in: ${session.user.email}`;
    if(loginBtn) loginBtn.style.display = 'none';
    if(logoutBtn) logoutBtn.style.display = 'inline-flex';
  } else {
    statusEl.textContent = 'Not signed in';
    if(loginBtn) loginBtn.style.display = 'inline-flex';
    if(logoutBtn) logoutBtn.style.display = 'none';
  }
}

supabaseClient.auth.onAuthStateChange(() => { checkUserSession(); });
window.addEventListener('DOMContentLoaded', () => { checkUserSession(); });

const $ = (s, root = document) => root.querySelector(s); const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let view = 'canvas';
const teams = ['Controls', 'Electrical', 'Mechanical', 'Shared'];
const projects = [{ id: 'exo', name: 'EXO', description: 'Lower-limb exoskeleton' }];
const nameOf = id => projects.find(p => p.id === id)?.name || 'Unknown project';

// View HTML Generators
function overviewHTML() {
  return `<div class="panel">
    <div class="panel-head"><div><h2>Project Overview</h2><p>Live Exoskeleton Workspace connected to Supabase and Figma.</p></div></div>
  </div>`;
}

function boardHTML() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>Exo Live FigJam Canvas</h2><p>Collaborative whiteboard synchronized with Figma.</p></div></div>
    <div style="height: 680px; width: 100%; background: var(--bg);">
      <iframe style="border:none; width: 100%; height: 100%;" src="https://embed.figma.com/board/YOUR_FIGJAM_BOARD_ID?embed-host=share" allowfullscreen></iframe>
    </div>
  </section>`;
}

function filesHTML() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>Project Files</h2><p>Document library and references.</p></div></div>
    <div class="table-scroll"><table><thead><tr><th>File name</th><th>Project</th><th>Team</th></tr></thead><tbody><tr><td><strong>Exo_Architecture.pdf</strong></td><td>EXO</td><td><span class="tag">Shared</span></td></tr></tbody></table></div>
  </section>`;
}

function bomHTML() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>Master Bill of Materials</h2><p>Supabase Database Connected</p></div></div>
    <div class="table-scroll"><table><thead><tr><th>Item ID</th><th>Subsystem</th><th>Component</th><th>Qty</th></tr></thead><tbody><tr><td><strong>EXO-01</strong></td><td>Mechanical</td><td>Actuator Mount</td><td>2</td></tr></tbody></table></div>
  </section>`;
}

function galleryHTML() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>Project Photo Gallery</h2><p>Assemblies, prototypes, and progress photos.</p></div></div>
  </section>`;
}

function resourcesHTML() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>Connected Resources</h2><p>Repositories and Drive folders.</p></div></div>
  </section>`;
}

function render() {
  $$('#nav .nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  
  const titles = {
    overview: 'Project Overview',
    canvas: 'Exo Collaboration Board',
    files: 'Project Files',
    bom: 'Master Bill of Materials',
    gallery: 'Photo Gallery',
    resources: 'Connected Resources'
  };
  
  $('#page-title').textContent = titles[view] || 'Workspace';
  
  const views = { overview: overviewHTML, canvas: boardHTML, files: filesHTML, bom: bomHTML, gallery: galleryHTML, resources: resourcesHTML };
  $('#view').innerHTML = (views[view] || boardHTML)();
}

document.addEventListener('click', e => {
  const el = e.target.closest('button,a');
  if (!el) return;
  if (el.dataset.view) {
    view = el.dataset.view;
    render();
  }
});

window.addEventListener('DOMContentLoaded', () => { render(); });