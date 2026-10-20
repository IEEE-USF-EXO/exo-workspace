'use strict';

// Repository Configuration
const GITHUB_ORG_OR_USERNAME = 'cristobairl'; 
const GITHUB_REPO_NAME = 'folder_upload';

// Initialize Supabase Client
const SUPABASE_URL = 'https://tnupwlucufewosslvcaz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXB3bHVjdWZld29zc2x2Y2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTM4MjIsImV4cCI6MjEwNzMyOTgyMn0.4TFRb6t4pE547wywotP_SWZG50NiJzlxs1_Ds51aQmM';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storage: window.localStorage, autoRefreshToken: true }
});

let githubAccessToken = localStorage.getItem('gh_provider_token') || null;

// GitHub Authentication Flow
async function signInWithGitHub() {
  await supabaseClient.auth.signInWithOAuth({
    provider: 'github',
    options: {
      scopes: 'public_repo', // Use 'repo' if cristobairl/folder_upload is Private
      redirectTo: window.location.origin + window.location.pathname
    }
  });
}

async function signOut() {
  localStorage.removeItem('gh_provider_token');
  githubAccessToken = null;
  await supabaseClient.auth.signOut();
  window.location.reload();
}

async function checkUserSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const statusEl = document.getElementById('save-status');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  if (session) {
    // Extract the GitHub provider token to use for file uploads
    if (session.provider_token) {
      githubAccessToken = session.provider_token;
      localStorage.setItem('gh_provider_token', session.provider_token);
    }
    
    statusEl.textContent = `Logged in: ${session.user.email || 'GitHub User'}`;
    if(loginBtn) loginBtn.style.display = 'none';
    if(logoutBtn) logoutBtn.style.display = 'inline-flex';
  } else {
    localStorage.removeItem('gh_provider_token');
    githubAccessToken = null;
    statusEl.textContent = 'Saved in this browser';
    if(loginBtn) loginBtn.style.display = 'inline-flex';
    if(logoutBtn) logoutBtn.style.display = 'none';
  }
}

supabaseClient.auth.onAuthStateChange((event, session) => { 
  if (session && session.provider_token) {
    githubAccessToken = session.provider_token;
    localStorage.setItem('gh_provider_token', session.provider_token);
  }
  checkUserSession(); 
});
window.addEventListener('DOMContentLoaded', () => { checkUserSession(); });

// DOM Selectors
const $= (s, root = document) => root.querySelector(s); const$$ = (s, root = document) => Array.from(root.querySelectorAll(s));

let view = 'files'; 

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
  return `
  <div class="panel">
    <div class="panel-head spread">
      <div>
        <h2 style="font-size: 18px; font-weight: 500; color: var(--ink);">Your file library</h2>
        <p style="margin-top: 6px; color: #738176; font-size: 13px;">Files added here stay in this browser. Use Export to include them in a shareable backup.</p>
      </div>
      <div><button class="secondary" style="font-size: 12px; padding: 7px 12px;">↗ GitHub uploader</button></div>
    </div>
    <div class="section-tools" style="padding-top: 5px; gap: 15px; border-bottom: 1px solid var(--line); padding-bottom: 20px;">
      <input type="text" placeholder="Search files, notes, projects..." style="flex: 1; max-width: 450px; font-size: 13px; padding: 10px 14px;">
      <select style="width: 140px; font-size: 13px; padding: 10px 14px;"><option>All teams</option></select>
    </div>
    <div class="empty-state">
      <div class="empty-icon">▱</div>
      <h3 style="font-size: 16px; font-weight: 500; margin-bottom: 10px;">Your files go here.</h3>
      <p style="color: #738176; margin-bottom: 24px; font-size: 13px;">Add your own drawings, spreadsheets, documents, or code.</p>
      <label for="empty-file-upload" class="secondary" style="font-size: 12px; padding: 8px 18px; cursor: pointer;">
        + Add files
        <input type="file" id="empty-file-upload" style="display:none;" onchange="handleFileUpload(event)">
      </label>
    </div>
  </div>
  <div style="padding: 10px 0 20px; color: #8b9789; font-size: 11px;">
    0 files · Browser storage
  </div>`;
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

// UI Rendering
function render() {
  $$('#nav .nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  
  const viewData = {
    overview: { title: 'Project Overview', sub: 'Live Exoskeleton Workspace connected to Supabase and Figma.', actions: '' },
    canvas: { title: 'Exo Collaboration Board', sub: 'Collaborative whiteboard synchronized with Figma.', actions: '' },
    files: { 
      title: 'Project files.', 
      sub: 'Add files once. Reference them anywhere on the drawing board.', 
      actions: `
        <button class="secondary">↓ Export</button>
        <label for="header-file-upload" class="primary" style="margin-left:8px; cursor:pointer; display:inline-flex; align-items:center;">
          ↑ Add files
          <input type="file" id="header-file-upload" style="display:none;" onchange="handleFileUpload(event)">
        </label>` 
    },
    bom: { title: 'Master Bill of Materials', sub: 'Supabase Database Connected', actions: '' },
    gallery: { title: 'Project Photo Gallery', sub: 'Assemblies, prototypes, and progress photos.', actions: '' },
    resources: { title: 'Connected Resources', sub: 'Repositories and Drive folders.', actions: '' }
  };
  
  const current = viewData[view] || viewData.canvas;
  
  $('#page-title').textContent = current.title;
  const subEl = $('#page-subtitle');
  if(subEl) subEl.textContent = current.sub;
  const actEl = $('#page-actions');
  if(actEl) actEl.innerHTML = current.actions;
  
  const views = { overview: overviewHTML, canvas: boardHTML, files: filesHTML, bom: bomHTML, gallery: galleryHTML, resources: resourcesHTML };
  $('#view').innerHTML = (views[view] || boardHTML)();
}

// GitHub File Upload Logic
async function uploadDirectToGitHub(file, owner, repo, targetPath, githubToken) {
    const reader = new FileReader();
    
    reader.onload = async (event) => {
        const base64Content = event.target.result.split(',')[1];
        const payload = {
            message: `Upload ${file.name} via EXO Dashboard`,
            content: base64Content
        };

        const cleanPath = targetPath ? `${targetPath}/${file.name}` : file.name;
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;
        
        try {
            const response = await fetch(apiUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                alert(`Successfully pushed ${file.name} to GitHub!`);
            } else {
                const errorData = await response.json();
                alert(`Upload failed: ${errorData.message}`);
            }
        } catch (error) {
            alert('Network error during upload.');
        }
    };
    
    reader.readAsDataURL(file);
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!githubAccessToken) {
        alert("You must sign in with GitHub before you can upload files.");
        return;
    }
    
    const targetPath = 'uploads'; // The folder inside your repo where files will be saved
    uploadDirectToGitHub(file, GITHUB_ORG_OR_USERNAME, GITHUB_REPO_NAME, targetPath, githubAccessToken);
    
    // Reset the input so the same file can be uploaded again if needed
    event.target.value = '';
}

// Event Listeners
document.addEventListener('click', e => {
  const el = e.target.closest('button.nav, button.project-button');
  if (!el) return;
  if (el.dataset.view) {
    view = el.dataset.view;
    render();
  }
});

window.addEventListener('DOMContentLoaded', () => { render(); });