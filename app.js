'use strict';

// ==========================================
// 1. GITHUB & SUPABASE CONFIGURATION
// ==========================================
const GITHUB_ORG_OR_USERNAME = 'cristobairl';
const GITHUB_REPO_NAME = 'folder_upload';

const SUPABASE_URL = 'https://tnupwlucufewosslvcaz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXB3bHVjdWZld29zc2x2Y2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTM4MjIsImV4cCI6MjEwNzMyOTgyMn0.4TFRb6t4pE547wywotP_SWZG50NiJzlxs1_Ds51aQmM';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storage: window.localStorage, autoRefreshToken: true }
});

let githubAccessToken = localStorage.getItem('gh_provider_token') || null;

async function signInWithGitHub() {
  if (window.location.protocol === 'file:') {
    notify('GitHub sign-in requires this app to run from http://localhost, not a file:// URL.');
    return;
  }
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'github',
      options: {
        scopes: 'repo', // Supports both public and private target repositories
        redirectTo: window.location.origin + window.location.pathname
      }
    });
    if (error) throw error;
  } catch (error) {
    notify('GitHub sign-in failed: ' + error.message);
  }
}

async function signOut() {
  localStorage.removeItem('gh_provider_token');
  githubAccessToken = null;
  await supabaseClient.auth.signOut();
  window.location.reload();
}

async function checkUserSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const authPill = document.getElementById('auth-status');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  if (session) {
    if (session.provider_token) {
      githubAccessToken = session.provider_token;
      localStorage.setItem('gh_provider_token', session.provider_token);
    }
    if (authPill) authPill.textContent = `Logged in: ${session.user.email || session.user.user_metadata?.user_name || 'GitHub User'}`;
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
  } else {
    localStorage.removeItem('gh_provider_token');
    githubAccessToken = null;
    if (authPill) authPill.textContent = 'OFFLINE PROTOTYPE';
    if (loginBtn) loginBtn.style.display = 'inline-flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (session && session.provider_token) {
    githubAccessToken = session.provider_token;
    localStorage.setItem('gh_provider_token', session.provider_token);
  }
  checkUserSession();
});

// Helper to push a File object directly to GitHub REST API (supports creating & updating files)
async function pushFileToGitHub(file, owner, repo, folderPath, note = '') {
  if (!githubAccessToken) {
    throw new Error('Not signed in with GitHub (or token expired). Please click Sign out and Sign in with GitHub again.');
  }

  const base64Content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const cleanFolder = String(folderPath || '').split('/').filter(s => s && s !== '.' && s !== '..').join('/');
  const fullPath = cleanFolder ? `${cleanFolder}/${file.name}` : file.name;
  const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  // Check if file already exists so we can pass its SHA to update it instead of failing with 422
  let existingSha = null;
  try {
    const checkRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${githubAccessToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (checkRes.ok) {
      const existingData = await checkRes.json();
      existingSha = existingData.sha;
    }
  } catch (_) {}

  const payload = {
    message: note ? `Upload ${file.name}: ${note}` : `Upload ${file.name} via EXO Dashboard`,
    content: base64Content
  };
  if (existingSha) payload.sha = existingSha;

  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${githubAccessToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `HTTP ${response.status}`);
  }
  return await response.json();
}

// ==========================================
// 2. ORIGINAL EXO-DASHBOARD APPLICATION LOGIC
// ==========================================
const $=(s,root=document)=>root.querySelector(s),$$=(s,root=document)=>Array.from(root.querySelectorAll(s));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
const teams=['Controls','Electrical','Mechanical','Shared'];
const teamColors={Controls:'#658e99',Electrical:'#b29a58',Mechanical:'#769667',Shared:'#869b76'};
const initial=()=>({version:1,projects:[{id:'exo',name:'EXO',description:'Lower-limb exoskeleton'},{id:'pid-spoon',name:'PID Spoon',description:'Stabilized assistive utensil'}],files:[],nodes:[],edges:[],strokes:[],resources:[],bom:{}});
let penColor="#346d4b"; document.addEventListener("input",event=>{if(event.target.id==="pen-color")penColor=event.target.value;});
let state=initial(),db=null,view='canvas',scope='all',tool='select',selected=null,connectFrom=null,zoom=1,search='',fileTeam='all',storageAvailable=false,history=[],saving=Promise.resolve(),urls=new Map(),gesture=null,toastTimer;
const folderIds=[['exo','Controls','1Pdx0N6EHctdZKqb7P29tVHuNVr8v8yrN'],['exo','Electrical','1WLCSZ5bMisg1GjJH-oVJhsXjM938elaR'],['exo','Mechanical','1sMgbFofCqB6DEapmZF6tF5tD1TZEUM76'],['pid-spoon','Controls','1jie8n23dzmk5Pc_jcJEEmj1bJYQxc9Tl'],['pid-spoon','Electrical','16DcGIMgwtcuZrYI7QaQJs6lVmQ6q1_ZE'],['pid-spoon','Mechanical','1a1LPEQUeCjfbkV6nDJag9Hsq55-Go0J8']];
const knownResources=[
  {id:'test-upload-repo',project:'exo',team:'Shared',title:`Test Upload Repo (${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME})`,url:`https://github.com/${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME}`},
  ...['exo','pid-spoon'].flatMap(project=>teams.map(team=>({id:project+team,project,team,title:team+' repository',url:'https://github.com/IEEE-USF-EXO/'+project+'-'+(team==='Shared'?'interfaces':team.toLowerCase())}))),
  ...folderIds.map(([project,team,id])=>({id,project,team,title:team+' Drive folder',url:'https://drive.google.com/drive/folders/'+id}))
];
const nameOf=id=>state.projects.find(p=>p.id===id)?.name||'Unknown project';
const inScope=item=>scope==='all'||item.project===scope;
const currentProject=()=>scope==='all'?state.projects[0].id:scope;
const teamOptions=value=>teams.map(t=>`<option ${value===t?'selected':''}>${t}</option>`).join('');
const projectOptions=value=>state.projects.map(p=>`<option value="${esc(p.id)}" ${value===p.id?'selected':''}>${esc(p.name)}</option>`).join('');
const sizeOf=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const isPhoto=f=>/^image\/(png|jpeg|webp|gif|avif)$/.test(f.type);
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5000);}
function warn(message){$('#storage-warning').textContent=message;$('#storage-warning').classList.remove('hidden');}
function openDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open('exo-html-workspace-v1',1);request.onupgradeneeded=()=>{request.result.createObjectStore('state');request.result.createObjectStore('blobs');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function record(store,key){return new Promise((resolve,reject)=>{const request=db.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function writeStores(nextState,blobs=[],replace=false){return new Promise((resolve,reject)=>{const tx=db.transaction(['state','blobs'],'readwrite');tx.objectStore('state').put(nextState,'workspace');if(replace)tx.objectStore('blobs').clear();for(const item of blobs)tx.objectStore('blobs').put(item.blob,item.id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Storage write interrupted'));});}
function persist(){const snapshot=structuredClone(state);$('#save-status').textContent='Saving…';saving=saving.catch(()=>{}).then(async()=>{if(!db)throw new Error('Browser storage unavailable');await writeStores(snapshot);$('#save-status').textContent='Saved in this browser';}).catch(error=>{$('#save-status').textContent='Not saved';warn('Your browser could not save this change. Keep this tab open and export a backup. '+error.message);});return saving;}
function checkpoint(){history.push(JSON.stringify({nodes:state.nodes,edges:state.edges,strokes:state.strokes}));if(history.length>35)history.shift();}
function undo(){if(!history.length)return;const previous=JSON.parse(history.pop());Object.assign(state,previous);selected=null;connectFrom=null;persist();render();}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function getBlob(id){return urls.has('blob-'+id)?urls.get('blob-'+id):db?await record('blobs',id):null;}
async function fileURL(id){if(urls.has(id))return urls.get(id);const blob=await getBlob(id);if(!blob)return null;const url=URL.createObjectURL(blob);urls.set(id,url);return url;}
async function downloadFile(id){const f=state.files.find(x=>x.id===id),blob=await getBlob(id);if(!blob){notify('The file is missing. Import a complete backup or add it again.');return;}download(blob,f?.name||'file');}
function openModal(title,html){$('#modal-title').textContent=title;$('#modal-body').innerHTML=html;$('#dialog').classList.remove('lightbox');$('#dialog').showModal();}
const actions=label=>`<div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit" class="primary">${label}</button></div>`;

function projectForm(){openModal('Start a new project',`<form id="project-form"><label class="field">Project name<input name="name" maxlength="80" placeholder="Name your project" required autofocus></label><label class="field">Description<textarea name="description" maxlength="500" placeholder="What are you building?"></textarea></label>${actions('Create project')}</form>`);$('#project-form').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.target),name=String(form.get('name')).trim();if(!name)return;if(state.projects.some(p=>p.name.toLowerCase()===name.toLowerCase())){notify('A project with that name already exists.');return;}const p={id:uid(),name,description:String(form.get('description'))};state.projects.push(p);scope=p.id;await persist();$('#dialog').close();render();};}

// Upgraded showUpload: Saves locally in IndexedDB AND pushes directly to GitHub (cristobairl/folder_upload) when signed in!
function showUpload(photos=false){
  const ghStatusNote = githubAccessToken
    ? `Signed in: Files will be saved locally AND pushed directly to <b>${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME}</b>.`
    : `Not signed in to GitHub: Files will be saved locally in this browser only. Sign in at the top right to also push to GitHub.`;
  openModal(photos?'Add project photos':'Add project files',`<form id="upload-form"><p class="hint" style="margin-bottom:14px">${ghStatusNote}</p><label class="field">${photos?'Photos':'Files'}<input type="file" name="files" ${photos?'accept="image/png,image/jpeg,image/webp,image/gif,image/avif"':''} multiple required><small>Up to 25 MB each.</small></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions('Shared')}</select></label></div><label class="field">GitHub target folder<input name="folder" value="uploads" placeholder="e.g. uploads or cad/actuators"><small>Folder inside ${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME} where files will be committed.</small></label><label class="field">Note or photo caption<textarea name="note" maxlength="1000" placeholder="Context, version, or what the photo shows"></textarea></label>${actions(photos?'Add photos':'Add files')}</form>`);
  $('#upload-form').onsubmit=async e=>{
    e.preventDefault();
    const form=new FormData(e.target),files=Array.from(e.target.elements.files.files);
    if(files.some(f=>!f.size||f.size>25*1024*1024)){notify('Choose nonempty files up to 25 MB each.');return;}
    if(photos&&files.some(f=>!isPhoto(f))){notify('Choose PNG, JPEG, WebP, GIF, or AVIF photos.');return;}
    const button=$('[type=submit]',e.target);button.disabled=true;button.textContent='Saving & Uploading…';
    const proj=String(form.get('project')),team=String(form.get('team')),note=String(form.get('note')),folder=String(form.get('folder')||'uploads').trim();
    const additions=files.map(f=>({id:uid(),name:f.name,type:f.type||'application/octet-stream',size:f.size,project:proj,team:team,note:note,created:new Date().toISOString()}));
    try{
      if(db){
        await saving;
        const next={...state,files:[...state.files,...additions]};
        await writeStores(next,additions.map((f,i)=>({id:f.id,blob:files[i]})));
        state=next;
        $('#save-status').textContent='Saved in this browser';
      }
      if(githubAccessToken){
        for(const f of files){
          await pushFileToGitHub(f, GITHUB_ORG_OR_USERNAME, GITHUB_REPO_NAME, folder, note);
        }
        $('#dialog').close();render();
        notify(`Saved locally & pushed ${files.length} file(s) to ${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME}/${folder}!`);
      } else {
        $('#dialog').close();render();
        notify(photos?'Photos added to browser gallery (Sign in with GitHub to sync to repo).':'Files added to browser storage (Sign in with GitHub to sync to repo).');
      }
    }catch(error){
      notify('Upload error: '+error.message);
      button.disabled=false;button.textContent='Try again';
    }
  };
}

function addCard(x,y){openModal('Add a card',`<form id="card-form"><label class="field">Card title<input name="title" maxlength="120" placeholder="What should this card represent?" required autofocus></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions('Shared')}</select></label></div><label class="field">Owner<input name="owner" maxlength="100" placeholder="Person or team"></label><label class="field">Notes<textarea name="note" maxlength="2000"></textarea></label>${actions('Place card')}</form>`);$('#card-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);checkpoint();const node={id:uid(),title:String(f.get('title')).trim(),project:String(f.get('project')),team:String(f.get('team')),owner:String(f.get('owner')),note:String(f.get('note')),status:'Not started',x:Math.max(10,Math.min(2170,x)),y:Math.max(10,Math.min(1460,y)),files:[]};if(!node.title)return;state.nodes.push(node);selected={kind:'node',id:node.id};persist();$('#dialog').close();render();};}
function centerCard(){const v=$('.canvas-viewport');addCard(v?(v.scrollLeft+v.clientWidth/2)/zoom-110:100,v?(v.scrollTop+v.clientHeight/2)/zoom-60:100);}
function showStorage(){openModal('Your workspace storage',`<p class="hint">This workspace saves locally in your browser (IndexedDB) and pushes files directly to GitHub when you sign in.</p><ul class="storage-list"><li><b>Where it saves locally</b>IndexedDB in this browser profile, on this device. Projects, drawings, relationships, BOM selections, and uploaded file bytes are stored locally.</li><li><b>Direct GitHub Upload</b>When signed in via GitHub, adding files pushes them directly to <code>${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME}</code> via the GitHub API.</li><li><b>Share or back up</b>Export a JSON backup containing your workspace and files. Someone else can open this site and import that backup.</li></ul><div class="row"><button class="primary" data-action="export">↓ Export full backup</button><button class="secondary" data-action="import">↑ Import backup</button></div>`);}
function toolHint(){return tool==='pen'?'Drag on the board to draw.':tool==='connect'?(connectFrom?'Choose a second card to connect.':'Choose the first card, then the second.'):tool==='hand'?'Drag the board to pan.':'Drag cards to arrange them. Select a connection to label it.';}
function boardHTML(){const nodes=state.nodes.filter(inScope),nodeIds=new Set(nodes.map(n=>n.id)),edges=state.edges.filter(e=>nodeIds.has(e.from)&&nodeIds.has(e.to)),strokes=state.strokes.filter(inScope);return `<section class="panel"><div class="canvas-top"><div class="tools" aria-label="Drawing tools">${[['select','↖ Select'],['pen','✎ Draw'],['connect','↗ Connect'],['hand','✋ Pan']].map(([id,label])=>`<button class="tool ${tool===id?'active':''}" data-tool="${id}" aria-pressed="${tool===id}">${label}</button>`).join('')}</div><div class="row"><input id="pen-color" type="color" value="#346d4b" title="Pen color" aria-label="Pen color" style="padding:2px;width:27px;height:27px"><button class="text-button" data-action="undo" ${history.length?'':'disabled'}>↶ Undo</button><button class="secondary" data-action="zoom-out" aria-label="Zoom out">−</button><span id="zoom-label" class="small muted">${Math.round(zoom*100)}%</span><button class="secondary" data-action="zoom-in" aria-label="Zoom in">＋</button></div></div><div class="canvas-layout"><div class="canvas-viewport" tabindex="0" aria-label="Drawing board. Use Add card for cards, Draw for freehand marks, and Connect for relationships."><div class="world-space" style="width:${2400*zoom}px;height:${1600*zoom}px"><div class="world ${tool==='pen'?'draw':tool}" style="transform:scale(${zoom})"><svg width="2400" height="1600" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="#9caf90"/></marker></defs>${edges.map(edgeSVG).join('')}${strokes.map(s=>`<polyline class="stroke" data-stroke="${s.id}" points="${s.points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${selected?.id===s.id?4:2.5}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>${nodes.map(cardHTML).join('')}</div></div>${!nodes.length&&!strokes.length?`<div class="canvas-note"><strong>A blank board. Yours to shape.</strong><p>Add your own cards or choose Draw and start sketching. Nothing is generated for you.</p></div>`:''}</div><aside class="inspector" id="inspector"></aside></div><div class="canvas-footer"><span id="tool-hint">${toolHint()}</span><span>${nodes.length} cards · ${edges.length} connections · ${scope==='all'?'All projects':esc(nameOf(scope))}</span></div></section>`;}
function edgeSVG(edge){const a=state.nodes.find(n=>n.id===edge.from),b=state.nodes.find(n=>n.id===edge.to);if(!a||!b)return '';const right=b.x>=a.x,x1=a.x+(right?220:0),y1=a.y+56,x2=b.x+(right?0:220),y2=b.y+56,mx=(x1+x2)/2,my=(y1+y2)/2,d=`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,sel=selected?.id===edge.id;return `<g><path d="${d}" stroke="${sel?'#477b3a':'#a7b99b'}" stroke-width="${sel?2.5:1.4}" fill="none" marker-end="url(#arrow)"/><path class="edge-hit" data-edge="${edge.id}" d="${d}" stroke="transparent" stroke-width="18" fill="none"/>${edge.label?`<rect x="${mx-75}" y="${my-13}" width="150" height="24" rx="5" fill="#fbfdf7" stroke="#e0e8d8"/><text x="${mx}" y="${my+3}" text-anchor="middle" font-size="10" fill="#718962">${esc(edge.label.slice(0,25))}</text>`:''}</g>`;}
function cardHTML(n){return `<button class="canvas-card ${selected?.id===n.id?'selected':''} ${connectFrom===n.id?'connect-source':''}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px;--card-color:${teamColors[n.team]||teamColors.Shared}" aria-label="${esc(n.title)}"><span class="card-meta"><span>${esc(n.team)}</span><span>${esc(nameOf(n.project))}</span></span><strong class="card-title">${esc(n.title)}</strong><span class="card-foot"><span>${esc(n.owner||'Owner unassigned')}</span><span>${n.files.length?'▱ '+n.files.length+' · ':''}${esc(n.status)}</span></span></button>`;}
function renderInspector(){const root=$('#inspector');if(!root)return;if(!selected){root.innerHTML=`<div class="eyebrow">DETAILS & RELATIONSHIPS</div><h3>Give the work context.</h3><p>Select a card to assign its project and team, add notes, or reference a file.</p><div class="related"><h3>Cross-team references</h3><p>Use Connect to draw an arrow between cards. Select that arrow and describe the relationship in your own words.</p><p style="margin-top:12px">Choose All projects in the sidebar to connect cards belonging to different projects.</p></div>`;return;}if(selected.kind==='node'){const n=state.nodes.find(x=>x.id===selected.id);if(!n){selected=null;renderInspector();return;}const connections=state.edges.filter(e=>e.from===n.id||e.to===n.id);root.innerHTML=`<div class="eyebrow">SELECTED CARD</div><form id="node-edit"><label class="field">Title<input name="title" maxlength="120" value="${esc(n.title)}" required></label><label class="field">Project<select name="project">${projectOptions(n.project)}</select></label><label class="field">Team<select name="team">${teamOptions(n.team)}</select></label><label class="field">Owner<input name="owner" maxlength="100" value="${esc(n.owner)}"></label><label class="field">Status<select name="status">${['Not started','In progress','Blocked','Complete'].map(s=>`<option ${n.status===s?'selected':''}>${s}</option>`).join('')}</select></label><label class="field wide">Notes<textarea name="note" maxlength="2000">${esc(n.note)}</textarea></label><button class="primary" type="submit">Save details</button></form><div class="related"><h3>File references</h3><div class="attachments">${n.files.map(id=>{const f=state.files.find(f=>f.id===id);return f?`<div class="attachment"><a href="#" data-download="${f.id}">${esc(f.name)}</a><button data-unlink="${f.id}" aria-label="Remove file reference">×</button></div>`:'';}).join('')}</div><label class="field">Attach a workspace file<select id="attach-file"><option value="">Choose a file…</option>${state.files.filter(f=>!n.files.includes(f.id)).map(f=>`<option value="${f.id}">${esc(nameOf(f.project))} /${esc(f.name)}</option>`).join('')}</select></label></div><div class="related"><h3>Relationships · ${connections.length}</h3>${connections.map(e=>{const other=state.nodes.find(x=>x.id===(e.from===n.id?e.to:e.from));return other?`<button class="related-card" data-select-edge="${e.id}">${e.from===n.id?'↗':'↙'} ${esc(other.title)}<small>${esc(nameOf(other.project))} · ${esc(other.team)}<br>${esc(e.label||'Unlabeled connection')}</small></button>`:'';}).join('')||'<p>No relationships drawn yet.</p>'}</div><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove card</button>`;$('#node-edit').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);checkpoint();for(const key of ['title','project','team','owner','status','note'])n[key]=String(f.get(key)).trim();persist();renderBoardPreservingScroll();};$('#attach-file').onchange=e=>{if(!e.target.value)return;checkpoint();n.files.push(e.target.value);persist();renderBoardPreservingScroll();};return;}if(selected.kind==='edge'){const edge=state.edges.find(e=>e.id===selected.id);if(!edge)return;const a=state.nodes.find(n=>n.id===edge.from),b=state.nodes.find(n=>n.id===edge.to);root.innerHTML=`<div class="eyebrow">SELECTED RELATIONSHIP</div><h3>${esc(a?.title)} → ${esc(b?.title)}</h3><p>${esc(nameOf(a?.project))} / ${esc(a?.team)}<br>to ${esc(nameOf(b?.project))} / ${esc(b?.team)}</p><form id="edge-edit" style="margin-top:18px"><label class="field">Relationship label<input name="label" maxlength="100" placeholder="e.g. supplies sensor data to" value="${esc(edge.label)}"></label><label class="field">Notes<textarea name="note" maxlength="1500">${esc(edge.note||'')}</textarea></label><button class="primary" type="submit">Save relationship</button></form><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove connection</button>`;$('#edge-edit').onsubmit=e=>{e.preventDefault();checkpoint();const f=new FormData(e.target);edge.label=String(f.get('label'));edge.note=String(f.get('note'));persist();renderBoardPreservingScroll();};return;}root.innerHTML='<h3>Selected drawing</h3><p>This stroke is part of your freehand drawing.</p><button class="danger" data-action="delete-selection" style="margin-top:20px">Remove stroke</button>';}
function renderBoardPreservingScroll(){const v=$('.canvas-viewport'),left=v?.scrollLeft||0,top=v?.scrollTop||0;$('#view').innerHTML=boardHTML();const next=$('.canvas-viewport');next.scrollLeft=left;next.scrollTop=top;bindBoard();renderInspector();}
function bindBoard(){$("#pen-color").value=penColor;const world=$('.world'),viewport=$('.canvas-viewport');world.onpointerdown=e=>{if(e.button!==0)return;const target=e.target.closest('[data-node],[data-edge],[data-stroke]'),rect=world.getBoundingClientRect(),point=[(e.clientX-rect.left)/zoom,(e.clientY-rect.top)/zoom];if(tool==='hand'){gesture={kind:'pan',x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};}else if(tool==='pen'){checkpoint();const stroke={id:uid(),project:currentProject(),color:$('#pen-color').value,points:[point]};state.strokes.push(stroke);const path=document.createElementNS('http://www.w3.org/2000/svg','polyline');for(const [k,v] of Object.entries({fill:'none',stroke:stroke.color,'stroke-width':'2.5','stroke-linecap':'round','stroke-linejoin':'round'}))path.setAttribute(k,v);$('svg',world).appendChild(path);gesture={kind:'draw',stroke,path};$('.canvas-note')?.remove();}else if(target?.dataset.node){const n=state.nodes.find(n=>n.id===target.dataset.node);if(tool==='connect'){if(connectFrom&&connectFrom!==n.id){if(state.edges.some(edge=>edge.from===connectFrom&&edge.to===n.id)){notify('These cards are already connected.');connectFrom=null;renderBoardPreservingScroll();return;}checkpoint();const edge={id:uid(),from:connectFrom,to:n.id,label:'',note:''};state.edges.push(edge);selected={kind:'edge',id:edge.id};connectFrom=null;persist();renderBoardPreservingScroll();}else{connectFrom=n.id;selected={kind:'node',id:n.id};renderBoardPreservingScroll();}return;}selected={kind:'node',id:n.id};checkpoint();gesture={kind:'move',node:n,start:point,x:n.x,y:n.y,el:target};$$('.canvas-card').forEach(el=>el.classList.toggle('selected',el.dataset.node===n.id));renderInspector();}else if(target?.dataset.edge){selected={kind:'edge',id:target.dataset.edge};renderBoardPreservingScroll();return;}else if(target?.dataset.stroke){selected={kind:'stroke',id:target.dataset.stroke};renderInspector();return;}else{selected=null;connectFrom=null;renderInspector();$$('.canvas-card').forEach(el=>el.classList.remove('selected','connect-source'));}if(gesture){world.setPointerCapture(e.pointerId);e.preventDefault();}};
 world.onpointermove=e=>{if(!gesture)return;const rect=world.getBoundingClientRect(),p=[(e.clientX-rect.left)/zoom,(e.clientY-rect.top)/zoom];if(gesture.kind==='draw'){if(gesture.stroke.points.length<12000){gesture.stroke.points.push(p);gesture.path.setAttribute('points',gesture.stroke.points.map(v=>v.join(',')).join(' '));}}else if(gesture.kind==='move'){const g=gesture;g.node.x=Math.max(0,Math.min(2175,g.x+p[0]-g.start[0]));g.node.y=Math.max(0,Math.min(1465,g.y+p[1]-g.start[1]));g.el.style.left=g.node.x+'px';g.el.style.top=g.node.y+'px';const svg=$('svg',world);$$('g',svg).forEach(el=>el.remove());svg.insertAdjacentHTML('beforeend',state.edges.filter(edge=>state.nodes.filter(inScope).some(n=>n.id===edge.from)&&state.nodes.filter(inScope).some(n=>n.id===edge.to)).map(edgeSVG).join(''));}else if(gesture.kind==='pan'){viewport.scrollLeft=gesture.left+gesture.x-e.clientX;viewport.scrollTop=gesture.top+gesture.y-e.clientY;}};
 const end=e=>{if(!gesture)return;const changed=gesture.kind!=='pan';gesture=null;if(world.hasPointerCapture(e.pointerId))world.releasePointerCapture(e.pointerId);if(changed)persist();renderBoardPreservingScroll();};world.onpointerup=end;world.onpointercancel=end;world.ondblclick=e=>{if(tool==='select'&&!e.target.closest('[data-node],[data-edge]')){const r=world.getBoundingClientRect();addCard((e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom);}};
}
function deleteSelection(){if(!selected)return;checkpoint();if(selected.kind==='node'){state.nodes=state.nodes.filter(n=>n.id!==selected.id);state.edges=state.edges.filter(e=>e.from!==selected.id&&e.to!==selected.id);}if(selected.kind==='edge')state.edges=state.edges.filter(e=>e.id!==selected.id);if(selected.kind==='stroke')state.strokes=state.strokes.filter(s=>s.id!==selected.id);selected=null;persist();renderBoardPreservingScroll();}
function overviewHTML(){const files=state.files.filter(inScope),nodes=state.nodes.filter(inScope),ids=new Set(nodes.map(n=>n.id));return `<div class="stats"><div class="stat"><span>Files</span><b>${files.length}</b><small>${sizeOf(files.reduce((s,f)=>s+f.size,0))} stored locally</small></div><div class="stat"><span>Cards on board</span><b>${nodes.length}</b><small>Manually placed by you</small></div><div class="stat"><span>Relationships</span><b>${state.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).length}</b><small>Connections you have drawn</small></div><div class="stat"><span>Gallery photos</span><b>${files.filter(isPhoto).length}</b><small>From this workspace</small></div></div><div class="overview-actions"><button class="overview-action" data-view="canvas"><b>↗ Draw the relationships</b><p>Arrange your work and link projects, teams, and files.</p></button><button class="overview-action" data-view="bom"><b>☷ Open the Master BOM</b><p>Choose your source file and inspect CSV parts lists.</p></button><button class="overview-action" data-view="gallery"><b>▧ Tell the story in photos</b><p>Build a gallery of assemblies, prototypes, and progress.</p></button></div><div class="panel"><div class="panel-head"><div><h2>A workspace you can take with you.</h2><p>Open the HTML, work locally, and push files directly to GitHub (${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME}).</p></div><button class="secondary" data-action="storage">How storage works</button></div></div>`;}
function fileRows(files){return files.map(f=>`<tr><td><div class="file-title"><strong>${esc(f.name)}</strong><small>${esc(f.note||nameOf(f.project))}</small></div></td><td>${esc(nameOf(f.project))}</td><td><span class="tag ${f.team.toLowerCase()}">${esc(f.team)}</span></td><td>${sizeOf(f.size)}</td><td><button class="text-button" data-download="${f.id}">↓ Download</button></td></tr>`).join('');}
function filteredFiles(){return state.files.filter(inScope).filter(f=>(fileTeam==='all'||f.team===fileTeam)&&(f.name+' '+f.note+' '+f.team+' '+nameOf(f.project)).toLowerCase().includes(search.toLowerCase()));}
const empty=(symbol,title,description,action)=>`<div class="empty"><div class="empty-symbol">${symbol}</div><h3>${title}</h3><p>${description}</p>${action||''}</div>`;
function filesHTML(){const files=filteredFiles();return `<section class="panel"><div class="panel-head"><div><h2>Your file library</h2><p>Files added here save in this browser and push directly to ${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME} when signed in.</p></div><button class="secondary" data-action="github">↗ GitHub uploader</button></div><div class="section-tools"><input id="file-search" aria-label="Search files" placeholder="Search files, notes, projects…" value="${esc(search)}"><select id="team-filter" aria-label="Filter by team"><option value="all">All teams</option>${teamOptions(fileTeam)}</select></div>${files.length?`<div class="table-scroll"><table><thead><tr><th>File name</th><th>Project</th><th>Team</th><th>Size</th><th>Access</th></tr></thead><tbody>${fileRows(files)}</tbody></table></div>`:empty('▱','Your files go here.','Add your own drawings, spreadsheets, documents, or code.','<button class="secondary" data-action="upload">＋ Add files</button>')}<div class="table-footer">${files.length} files · Browser storage + GitHub sync (${GITHUB_ORG_OR_USERNAME}/${GITHUB_REPO_NAME})</div></section>`;}
function galleryHTML(){const photos=state.files.filter(inScope).filter(isPhoto);return `<section class="panel"><div class="panel-head"><div><h2>Project photo gallery</h2><p>Your actual photos, with their project, team, and notes.</p></div><span class="pill">${photos.length} photos</span></div>${photos.length?`<div class="tiles">${photos.map(f=>`<article class="photo"><button class="photo-image" data-photo="${f.id}" aria-label="View ${esc(f.name)}"><img data-local-image="${f.id}" alt="${esc(f.note||f.name)}"></button><div class="photo-info"><b>${esc(f.name)}</b><p>${esc(nameOf(f.project))} · ${esc(f.team)}</p><p>${esc(f.note)}</p><button class="text-button" data-download="${f.id}">↓ Original photo</button></div></article>`).join('')}</div>`:empty('▧','Show what you are building.','Add photos of prototypes, assemblies, and team progress.','<button class="secondary" data-action="photos">＋ Add photos</button>')}</section>`;}
async function loadImages(){for(const img of $$('[data-local-image]')){const url=await fileURL(img.dataset.localImage);if(url)img.src=url;}}
function bomHTML(){const project=currentProject(),id=state.bom[project],file=state.files.find(f=>f.id===id);return `<section class="panel"><div class="panel-head"><div><h2>Master bill of materials</h2><p>${scope==='all'?'Choose a project to see its BOM. Showing '+esc(nameOf(project))+'.':'Choose the file your team treats as the source of truth.'}</p></div></div><div class="bom-bar"><div><strong>${file?esc(file.name):'No master BOM selected'}</strong><small>${esc(nameOf(project))}${file?' · '+esc(file.team)+' · '+sizeOf(file.size):''}</small></div><div class="row">${file?`<button class="secondary" data-download="${file.id}">↓ Download source</button>`:''}<button class="secondary" data-action="choose-bom">${file?'Change file':'Choose BOM file'}</button></div></div><div id="bom-preview">${file?'<div class="empty"><p>Opening BOM…</p></div>':empty('☷','Keep the source easy to find.','Add a BOM in Files, then select it here. CSV files display as a searchable table; other file types remain downloadable.')}</div></section>`;}
function parseCSV(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';if(rows.length>10000)throw new Error('Preview supports up to 10,000 rows.');}else cell+=c;}row.push(cell);if(row.some(v=>v.trim()))rows.push(row);if(quoted)throw new Error('CSV has an unclosed quoted field.');return rows;}
async function previewBOM(){const target=$('#bom-preview');if(!target)return;const file=state.files.find(f=>f.id===state.bom[currentProject()]);if(!file)return;if(!/\.csv$/i.test(file.name)){target.innerHTML=empty('▱','Source file ready to download.','This offline prototype previews CSV tables. Download Excel, PDF, or other formats to open them in their original application.');return;}if(file.size>5*1024*1024){target.innerHTML=empty('☷','Large CSV source available.','The preview supports CSV files up to 5 MB. Use Download source for this file.');return;}try{const blob=await getBlob(file.id);if(!blob)throw new Error('The source file is missing from this browser.');const rows=parseCSV((await blob.text()).replace(/^\uFEFF/,''));if(!target.isConnected)return;if(!rows.length){target.innerHTML=empty('☷','Empty CSV.','The selected file has no table rows.');return;}const [head,...body]=rows;target.innerHTML=`<div class="section-tools"><input id="bom-search" placeholder="Search parts, descriptions, teams…" aria-label="Search BOM"></div><div class="table-scroll"><table><thead><tr>${head.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody id="bom-rows"></tbody></table></div><div class="table-footer" id="bom-count"></div>`;const draw=query=>{const list=body.filter(row=>row.join(' ').toLowerCase().includes(query.toLowerCase()));$('#bom-rows').innerHTML=list.map(row=>`<tr>${head.map((_,i)=>`<td>${esc(row[i]||'')}</td>`).join('')}</tr>`).join('');$('#bom-count').textContent=list.length+' line items · CSV source preview';};draw('');$('#bom-search').oninput=e=>draw(e.target.value);}catch(error){target.innerHTML=empty('☷','Could not preview this BOM.',esc(error.message));}}
function chooseBOM(){const files=state.files.filter(f=>f.project===currentProject());if(!files.length){notify('Add a BOM file to this project first.');showUpload();return;}openModal('Choose the Master BOM',`<form id="bom-form"><p class="hint" style="margin-bottom:18px">Select the source file for ${esc(nameOf(currentProject()))}. No BOM data is invented or imported automatically.</p><label class="field">Source file<select name="file" required><option value="">Choose a file…</option>${files.map(f=>`<option value="${f.id}" ${state.bom[currentProject()]===f.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label>${actions('Set Master BOM')}</form>`);$('#bom-form').onsubmit=e=>{e.preventDefault();state.bom[currentProject()]=String(new FormData(e.target).get('file'));persist();$('#dialog').close();render();};}
function resourcesHTML(){const links=[...knownResources,...state.resources].filter(inScope);return `<section class="panel"><div class="panel-head"><div><h2>Connected resources</h2><p>Existing GitHub repositories and documented Drive folders. Their own access rules apply.</p></div></div><div class="resource-grid">${links.map(r=>`<a class="resource" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"><div><b>${esc(r.title)}</b><small>${esc(nameOf(r.project))} ·${esc(r.team)}</small></div><span>↗</span></a>`).join('')}</div>${!links.length?empty('↗','Connect your project.','Add a repository, folder, or reference link.'):''}</section>`;}
function resourceForm(){openModal('Add a resource',`<form id="resource-form"><label class="field">Title<input name="title" required maxlength="100"></label><label class="field">HTTPS address<input name="url" type="url" required placeholder="https://…" maxlength="2000"></label><div class="form-grid"><label class="field">Project<select name="project">${projectOptions(currentProject())}</select></label><label class="field">Team<select name="team">${teamOptions('Shared')}</select></label></div>${actions('Add resource')}</form>`);$('#resource-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),url=String(f.get('url'));try{if(new URL(url).protocol!=='https:')throw new Error();}catch{notify('Use a full https:// address.');return;}state.resources.push({id:uid(),title:String(f.get('title')),url,project:String(f.get('project')),team:String(f.get('team'))});persist();$('#dialog').close();render();};}

// Upgraded githubForm: Lets users pick any repo/folder and upload a file directly via API (or open in GitHub)
function githubForm(){
  const repos=knownResources.filter(r=>r.url.startsWith('https://github.com/'));
  openModal('Direct GitHub Repo Uploader',`<p class="hint" style="margin-bottom:16px">Push a file directly into a GitHub repository using your signed-in GitHub account.</p><form id="github-form"><label class="field">Repository<select name="repo">${repos.map(r=>`<option value="${esc(r.url)}" ${r.id==='test-upload-repo'?'selected':''}>${esc(r.title)} (${esc(r.url.replace('https://github.com/',''))})</option>`).join('')}</select></label><label class="field">Folder path<input name="folder" value="uploads" placeholder="e.g. uploads or docs/drawings" pattern="[a-zA-Z0-9_./ -]*"><small>Leave empty for the repository root.</small></label><label class="field">Select file to push<input type="file" name="ghfile" required></label>${actions('Push to GitHub ↗')}</form>`);
  $('#github-form').onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(e.target),repoUrl=String(f.get('repo')),folder=String(f.get('folder')||'').trim(),file=e.target.elements.ghfile.files[0];
    if(!file)return;
    const match=repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if(!match){notify('Invalid GitHub repository URL.');return;}
    const [,owner,repo]=match;
    const btn=$('[type=submit]',e.target);btn.disabled=true;btn.textContent='Uploading…';
    try{
      await pushFileToGitHub(file, owner, repo, folder);
      $('#dialog').close();
      notify(`Successfully pushed ${file.name} to ${owner}/${repo}!`);
    }catch(err){
      notify('GitHub upload failed: '+err.message);
      btn.disabled=false;btn.textContent='Push to GitHub ↗';
    }
  };
}

async function exportBackup(){notify('Preparing a backup with your files…');await saving;try{const blobs=[];for(const f of state.files){const blob=await getBlob(f.id);if(!blob)throw new Error('Missing file: '+f.name);const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});blobs.push({id:f.id,type:f.type,data:base64});}download(new Blob([JSON.stringify({format:'exo-html-backup',version:1,exported:new Date().toISOString(),state,blobs})],{type:'application/json'}),'exo-workspace-backup-'+new Date().toISOString().slice(0,10)+'.json');notify('Backup exported. It includes your files and drawings.');}catch(error){notify('Backup could not be completed: '+error.message);}}
function validateBackup(data){if(data?.format!=='exo-html-backup'||data.version!==1||!data.state||!Array.isArray(data.blobs))throw new Error('Not an EXO HTML backup.');const s=data.state;if(!['projects','files','nodes','edges','strokes','resources'].every(k=>Array.isArray(s[k]))||!s.projects.length||!s.bom||typeof s.bom!=='object')throw new Error('Backup structure is incomplete.');const str=(v,max=2000)=>typeof v==='string'&&v.length<=max;const validId=v=>str(v,100)&&/^[a-zA-Z0-9_-]+$/.test(v);for(const group of ['projects','files','nodes','edges','strokes','resources'])if(new Set(s[group].map(x=>x.id)).size!==s[group].length||s[group].some(x=>!validId(x.id)))throw new Error('Invalid or duplicate record identifiers.');const projects=new Set(s.projects.map(x=>x.id)),files=new Set(s.files.map(x=>x.id)),nodes=new Set(s.nodes.map(x=>x.id));for(const p of s.projects)if(!str(p.name,80)||!str(p.description,500))throw new Error('Invalid project.');for(const f of s.files)if(!projects.has(f.project)||!str(f.name,250)||!str(f.type,100)||!str(f.note,1000)||!teams.includes(f.team)||!Number.isFinite(f.size)||f.size<=0||f.size>25*1024*1024)throw new Error('Invalid file metadata.');for(const n of s.nodes)if(!projects.has(n.project)||!str(n.title,120)||!str(n.owner,100)||!str(n.note)||!teams.includes(n.team)||!['Not started','In progress','Blocked','Complete'].includes(n.status)||![n.x,n.y].every(v=>Number.isFinite(v)&&v>=0&&v<=2400)||!Array.isArray(n.files)||n.files.some(id=>!files.has(id)))throw new Error('Invalid drawing card.');for(const e of s.edges)if(!nodes.has(e.from)||!nodes.has(e.to)||!str(e.label,100)||!str(e.note,1500))throw new Error('Invalid relationship.');for(const p of s.strokes)if(!projects.has(p.project)||!/^#[0-9a-f]{6}$/i.test(p.color)||!Array.isArray(p.points)||p.points.length>12000||p.points.some(v=>!Array.isArray(v)||v.length!==2||!v.every(x=>Number.isFinite(x)&&Math.abs(x)<10000)))throw new Error('Invalid pen stroke.');for(const r of s.resources)if(!projects.has(r.project)||!str(r.title,100)||!teams.includes(r.team)||!str(r.url,2000)||new URL(r.url).protocol!=='https:')throw new Error('Invalid resource link.');for(const [project,id]of Object.entries(s.bom))if(!projects.has(project)||!files.has(id)||s.files.find(f=>f.id===id)?.project!==project)throw new Error('Invalid BOM reference.');if(data.blobs.length!==s.files.length||new Set(data.blobs.map(b=>b.id)).size!==data.blobs.length)throw new Error('The backup must include every file exactly once.');return s;}
async function importBackup(file){if(!file)return;try{if(file.size>200*1024*1024)throw new Error('Backup is larger than the 200 MB prototype import limit.');const data=JSON.parse(await file.text()),next=validateBackup(data),blobs=[];for(const b of data.blobs){const meta=next.files.find(f=>f.id===b.id);if(!meta||typeof b.data!=='string')throw new Error('File data is incomplete.');const raw=atob(b.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));if(bytes.length!==meta.size)throw new Error('File size does not match: '+meta.name);blobs.push({id:b.id,blob:new Blob([bytes],{type:meta.type})});}if(!confirm('Replace the current local workspace with this backup? Export your current work first if you want to keep it.'))return;if(!db)throw new Error('Local browser storage is unavailable.');await saving;await writeStores(next,blobs,true);for(const [key,url]of urls)if(!key.startsWith('blob-'))URL.revokeObjectURL(url);urls.clear();state=next;scope='all';selected=null;connectFrom=null;history=[];render();notify('Backup imported, including files and drawings.');$('#dialog').close();}catch(error){notify('Import failed: '+error.message);}}
function render(){const labels={overview:['The whole project, at a glance.','Files, drawings, and references in one local workspace.','＋ Add files'],canvas:['Your ideas. Your connections.','Draw freely, place cards, and connect work across teams and projects.','＋ Add card'],files:['Project files.','Add files once. Reference them anywhere on the drawing board.','↑ Add files'],bom:['One place for the parts list.','Choose the source file your team uses as its Master BOM.','↑ Add BOM file'],gallery:['A closer look at the work.','Keep your actual project photos together, with notes and context.','＋ Add photos'],resources:['Your project, connected.','Open the tools, repositories, and folders your team uses.','＋ Add resource']};$('#page-title').textContent=labels[view][0];$('#page-description').textContent=labels[view][1];$('#page-action').textContent=labels[view][2];$('#eyebrow').textContent=(scope==='all'?'WORKSPACE':nameOf(scope).toUpperCase())+' / '+(view==='canvas'?'DRAWING BOARD':view.toUpperCase());$('#crumb').textContent=scope==='all'?'All projects':nameOf(scope);$$('#nav .nav').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('#project-list').innerHTML=`<button class="project-button ${scope==='all'?'active':''}" data-project="all"><span class="dot" style="background:#a9b294"></span>All projects</button>`+state.projects.map(p=>`<button class="project-button ${scope===p.id?'active':''}" data-project="${p.id}"><span class="dot"></span>${esc(p.name)}</button>`).join('');$('#view').innerHTML=view==='canvas'?boardHTML():view==='overview'?overviewHTML():view==='files'?filesHTML():view==='gallery'?galleryHTML():view==='bom'?bomHTML():resourcesHTML();if(view==='canvas'){bindBoard();renderInspector();}if(view==='gallery')loadImages();if(view==='bom')previewBOM();if(view==='files'){$('#file-search').oninput=e=>{search=e.target.value;const pos=e.target.selectionStart;render();$('#file-search').focus();$('#file-search').setSelectionRange(pos,pos);};$('#team-filter').onchange=e=>{fileTeam=e.target.value;render();};}}
document.addEventListener('click',async e=>{const el=e.target.closest('button,a');if(!el)return;if(el.dataset.view){view=el.dataset.view;selected=null;render();}if(el.dataset.project){scope=el.dataset.project;selected=null;connectFrom=null;search='';fileTeam='all';render();}if(el.dataset.tool){tool=el.dataset.tool;connectFrom=null;renderBoardPreservingScroll();}if(el.dataset.download){e.preventDefault();downloadFile(el.dataset.download);}if(el.dataset.selectEdge){selected={kind:'edge',id:el.dataset.selectEdge};renderBoardPreservingScroll();}if(el.dataset.unlink&&selected?.kind==='node'){checkpoint();const n=state.nodes.find(n=>n.id===selected.id);n.files=n.files.filter(id=>id!==el.dataset.unlink);persist();renderBoardPreservingScroll();}if(el.dataset.photo){const f=state.files.find(f=>f.id===el.dataset.photo),url=await fileURL(f.id);openModal(f.name,`<img src="${esc(url)}" alt="${esc(f.note||f.name)}" style="width:100%;max-height:68vh;object-fit:contain"><p class="hint" style="margin-top:15px">${esc(nameOf(f.project))} · ${esc(f.team)} · ${esc(f.note)}</p>`);$('#dialog').classList.add('lightbox');}if(el.hasAttribute('data-close'))$('#dialog').close();const action=el.dataset.action;if(action==='login')signInWithGitHub();if(action==='upload')showUpload();if(action==='photos')showUpload(true);if(action==='storage')showStorage();if(action==='export')exportBackup();if(action==='import')$('#backup-input').click();if(action==='undo')undo();if(action==='delete-selection')deleteSelection();if(action==='choose-bom')chooseBOM();if(action==='github')githubForm();if(action==='zoom-in'||action==='zoom-out'){zoom=Math.max(.4,Math.min(1.6,Math.round((zoom+(action==='zoom-in'?.1:-.1))*10)/10));renderBoardPreservingScroll();}});
$('#page-action').onclick=()=>view==='canvas'?centerCard():view==='gallery'?showUpload(true):view==='resources'?resourceForm():showUpload();$('#new-project').onclick=projectForm;$('#close-dialog').onclick=()=>$('#dialog').close();$('#dialog').onclick=e=>{if(e.target===$('#dialog'))$('#dialog').close();};$('#backup-input').onchange=e=>{importBackup(e.target.files[0]);e.target.value='';};
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||$('#dialog').open)return;if(view!=='canvas')return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection();}else if(e.key==='Escape'){selected=null;connectFrom=null;renderBoardPreservingScroll();}else{const map={v:'select',p:'pen',c:'connect',h:'hand'};if(map[e.key.toLowerCase()]){tool=map[e.key.toLowerCase()];connectFrom=null;renderBoardPreservingScroll();}}});
window.addEventListener('beforeunload',e=>{if(gesture){e.preventDefault();e.returnValue='';}});
(async()=>{
  checkUserSession();
  try{
    db=await openDB();
    state=await record('state','workspace')||initial();
    storageAvailable=true;
    $('#save-status').textContent='Saved in this browser';
  }catch(error){
    $('#save-status').textContent='Storage unavailable';
    warn('This browser has blocked local storage. Drawing can be explored, but files cannot be saved. Use a regular browser window with local storage enabled.');
  }
  render();
})();