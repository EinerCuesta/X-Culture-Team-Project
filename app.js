/* =========================================================
   X-CULTURE TEAM HUB — Amigos Caffè
   Data / State / Persistence layer (Firebase Firestore, shared
   live across the whole team + localStorage as an offline cache)
   ========================================================= */

const STORAGE_KEY = 'xculture_hub_state_v1';
const SESSION_KEY = 'xculture_hub_session_v1';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

/* ---------- Firebase config & setup ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyBiM259TlXFAeooHVH9AQmGZLn3QAhLen4",
  authDomain: "xculture-amigos-hub.firebaseapp.com",
  projectId: "xculture-amigos-hub",
  storageBucket: "xculture-amigos-hub.firebasestorage.app",
  messagingSenderId: "519384063214",
  appId: "1:519384063214:web:34511e7af1f42372c2e7ff"
};

// Single shared document holding the entire team's state.
const FIRESTORE_COLLECTION = 'xculture_teams';
const FIRESTORE_DOC_ID = 'amigos-caffe-team'; // one team = one doc; change this if you run multiple teams

let fbApp = null;
let fbDb = null;
let fbDocRef = null;
let firebaseReady = false;
let suppressNextSnapshot = false; // avoid re-render loops when WE just wrote

function initFirebase(){
  try{
    fbApp = firebase.initializeApp(firebaseConfig);
    fbDb = firebase.firestore();
    fbDocRef = fbDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC_ID);
    firebaseReady = true;
  }catch(e){
    console.error('Firebase init failed, falling back to local-only storage.', e);
    firebaseReady = false;
  }
}

/* ---------- Default seed state (matches the X-Culture Amigos Caffè calendar) ---------- */
function seedState(){
  return {
    users: [], // {id, name, email, role, joinedAt}
    currentWeekIndex: 0,
    roadmap: [
      { id:'w1', title:'Week 1', dateRange:'Aug 24 – Aug 30', goal:'Understand the X-Culture challenge, form our team, and define our strategy.', deadline:'2026-08-31',
        tasks:['Read project requirements','Introduce ourselves','Assign initial responsibilities','Establish communication channels','Pass the readiness test'] },
      { id:'w2', title:'Week 2', dateRange:'Aug 31 – Sep 6', goal:'Get to know teammates and prepare to select our client company.', deadline:'2026-09-07',
        tasks:['Video call to meet the team','Review available client challenges','Discuss role division','Select Amigos Caffè as client'] },
      { id:'w3', title:'Week 3', dateRange:'Sep 7 – Sep 13', goal:'Kick off Section 1: industry & competitor research for Amigos Caffè.', deadline:'2026-09-14',
        tasks:['Research Italian coffee competitors','Identify candidate target markets','Draft consumer interview questions','Begin SWOT analysis'] },
      { id:'w4', title:'Week 4', dateRange:'Sep 14 – Sep 20', goal:'Finish Section 1 draft and select the proposed target market.', deadline:'2026-09-21',
        tasks:['Complete competitor analysis','Conduct consumer/buyer interviews','Finalize target market choice','Submit Section 1 draft'] },
      { id:'w5', title:'Week 5', dateRange:'Sep 21 – Sep 27', goal:'Work on Section 2: product, pricing, entry mode, logistics, legal & HR.', deadline:'2026-09-28',
        tasks:['Match products to target market','Draft pricing strategy','Compare market entry modes','Research logistics & compliance'] },
      { id:'w6', title:'Week 6', dateRange:'Sep 28 – Oct 4', goal:'Finish Section 2 and start Section 3: marketing plan.', deadline:'2026-10-05',
        tasks:['Submit Section 2 draft','Analyze current marketing assets','Choose promotion channels','Draft campaign message'] },
      { id:'w7', title:'Week 7', dateRange:'Oct 5 – Oct 8', goal:'Assemble the complete report draft and refine all sections.', deadline:'2026-10-05',
        tasks:['Compile Title Page & Exec Summary','Merge all sections','Create promotional material sample','Proofread & format to guidelines'] },
      { id:'w8', title:'Week 8', dateRange:'Oct 9 – Oct 12', goal:'Finalize and submit the report; complete post-project survey.', deadline:'2026-10-09',
        tasks:['Final proofreading pass','Submit FINAL report','Submit recommendations summary','Complete post-project survey'] },
    ],
    tasks: [
      { id:'t1', name:'Read X-Culture project requirements', description:'Everyone reviews the challenge PDF and guidelines.', assignee:null, deadline:'2026-08-31', priority:'Medium', status:'Not Started', weekId:'w1' },
      { id:'t2', name:'Select Amigos Caffè as client company', description:'Confirm the team\'s chosen client for the project.', assignee:null, deadline:'2026-09-07', priority:'High', status:'Not Started', weekId:'w2' },
      { id:'t3', name:'Research Italian coffee competitors', description:'Identify direct and indirect competitors to Amigos Caffè.', assignee:null, deadline:'2026-09-13', priority:'High', status:'Not Started', weekId:'w3' },
      { id:'t4', name:'Draft consumer interview questions', description:'Prepare questions for consumers in the target market.', assignee:null, deadline:'2026-09-13', priority:'Medium', status:'Not Started', weekId:'w3' },
      { id:'t5', name:'Conduct buyer/distributor interviews', description:'Interview at least a few retail buyers or distributors.', assignee:null, deadline:'2026-09-20', priority:'High', status:'Not Started', weekId:'w4' },
      { id:'t6', name:'Draft Section 1: Market Analysis', description:'Write the industry, competitor, and SWOT analysis.', assignee:null, deadline:'2026-09-14', priority:'High', status:'Not Started', weekId:'w4' },
      { id:'t7', name:'Draft pricing strategy', description:'Recommend retail/wholesale price ranges for target market.', assignee:null, deadline:'2026-09-28', priority:'Medium', status:'Not Started', weekId:'w5' },
      { id:'t8', name:'Draft Section 3: Marketing Plan', description:'Channels, message, and a sample promotional asset.', assignee:null, deadline:'2026-10-05', priority:'Medium', status:'Not Started', weekId:'w6' },
    ],
    meetings: {
      votes: {},        // weekIndex -> [{userId, day, time}]
      finalized: {},    // weekIndex -> {day, time} once team resolves tie/confirms - optional
      attendance: {},   // weekIndex -> {userId: {status:'yes'|'no'|'pending', comment:''}}
      checklists: {},   // weekIndex -> [{id,text,done}]
      meetingNumberDates: {}, // weekIndex -> date label
    },
    history: [], // archived meetings [{weekIndex, day, time, attendance, checklist, comments, decisions}]
    comments: [], // {id, targetType:'meeting'|'task'|'objective', targetId, userId, text, date}
  };
}

const DEFAULT_CHECKLIST_ITEMS = [
  'Greeting & Icebreaker',
  'Review what everyone completed last week',
  'Review current project progress',
  'Discuss pending tasks',
  'Check research findings',
  'Review project deadline',
  'Assign new tasks',
  'Confirm next meeting',
];

/* ---------- Load / Save ---------- */
let STATE = null;
let saveDebounceTimer = null;
let firstSnapshotReceived = false;

function loadState(){
  // 1. Load from local cache immediately so the UI has something to show.
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    STATE = raw ? JSON.parse(raw) : seedState();
  }catch(e){
    console.error('Failed to load local cache, reseeding.', e);
    STATE = seedState();
  }
  ensureWeekChecklist(STATE.currentWeekIndex);
}

// Called once Firebase is ready: subscribes to realtime updates so every
// teammate's browser reflects the same shared data automatically.
function subscribeToCloud(){
  if(!firebaseReady){ return; }
  fbDocRef.onSnapshot((snap)=>{
    if(snap.exists){
      if(suppressNextSnapshot){
        suppressNextSnapshot = false;
      } else {
        const cloudState = snap.data().state;
        if(cloudState){
          STATE = JSON.parse(cloudState);
          ensureWeekChecklist(STATE.currentWeekIndex);
          persistLocalCache();
          if(document.getElementById('app').style.display !== 'none'){
            renderAll();
          }
        }
      }
    } else {
      // No cloud doc yet — seed it with whatever we have locally.
      pushStateToCloud();
    }
    if(!firstSnapshotReceived){
      firstSnapshotReceived = true;
      hideSyncBanner();
    }
  }, (err)=>{
    console.error('Firestore subscription error:', err);
    showStorageWarning('Could not connect to the shared team database. Showing your local copy instead — changes may not sync with teammates until this reconnects.');
  });
}

function persistLocalCache(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE)); }
  catch(e){ console.error('Local cache save failed', e); }
}

function pushStateToCloud(){
  if(!firebaseReady) return;
  suppressNextSnapshot = true;
  fbDocRef.set({ state: JSON.stringify(STATE), updatedAt: new Date().toISOString() })
    .catch(err=>{
      console.error('Cloud save failed:', err);
      showStorageWarning('Your last change could not be saved to the shared database. Check your internet connection.');
    });
}

// Public save function used everywhere in the app. Saves locally right away
// (instant UI feedback) and pushes to the cloud in a short debounce window
// so rapid edits (typing, checkbox spam) don't spam Firestore.
function saveState(){
  persistLocalCache();
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(()=>{
    pushStateToCloud();
  }, 400);
}

function ensureWeekChecklist(weekIndex){
  if(!STATE.meetings.checklists[weekIndex]){
    STATE.meetings.checklists[weekIndex] = DEFAULT_CHECKLIST_ITEMS.map((t,i)=>({id:'c'+weekIndex+'_'+i, text:t, done:false}));
    saveState();
  }
}

/* ---------- Session (who is currently "logged in" on this device) ---------- */
let CURRENT_USER_ID = null;

function loadSession(){
  try{
    CURRENT_USER_ID = localStorage.getItem(SESSION_KEY) || null;
  }catch(e){
    console.error('Could not read session from localStorage', e);
    CURRENT_USER_ID = null;
  }
}
function saveSession(userId){
  CURRENT_USER_ID = userId;
  try{
    localStorage.setItem(SESSION_KEY, userId);
    // Verify the write actually stuck (some browsers silently no-op in private mode)
    const check = localStorage.getItem(SESSION_KEY);
    if(check !== userId){
      console.error('Session write did not persist. check=', check);
      showStorageWarning();
    }
  }catch(e){
    console.error('Could not save session to localStorage', e);
    showStorageWarning();
  }
}
function clearSession(){
  CURRENT_USER_ID = null;
  try{ localStorage.removeItem(SESSION_KEY); }catch(e){ console.error(e); }
}

function storageIsWorking(){
  try{
    const testKey = '__xculture_storage_test__';
    localStorage.setItem(testKey, '1');
    const ok = localStorage.getItem(testKey) === '1';
    localStorage.removeItem(testKey);
    return ok;
  }catch(e){
    return false;
  }
}

function showStorageWarning(customMessage){
  const el = document.getElementById('storageWarning');
  if(el){
    if(customMessage){
      const textEl = el.querySelector('.warning-text');
      if(textEl) textEl.textContent = customMessage;
    }
    el.style.display = 'block';
  }
}

function hideSyncBanner(){
  const el = document.getElementById('syncBanner');
  if(el) el.style.display = 'none';
}

function getCurrentUser(){
  return STATE.users.find(u=>u.id===CURRENT_USER_ID) || null;
}

function initials(name){
  return name.trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();
}

/* ---------- Toast ---------- */
function showToast(msg){
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div');
  t.className='toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(()=>t.remove(), 3000);
}

/* ---------- Registration ---------- */
function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

document.getElementById('registerForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const errorEl = document.getElementById('regError');
  const submitBtn = e.target.querySelector('button[type=submit]');

  if(!name || !isValidEmail(email)){
    errorEl.style.display='block';
    return;
  }
  errorEl.style.display='none';

  // Pull the freshest cloud state first so two people registering around the
  // same moment don't collide on registration numbers or overwrite each other.
  if(firebaseReady){
    submitBtn.textContent = 'Joining...';
    submitBtn.disabled = true;
    try{
      const snap = await fbDocRef.get();
      if(snap.exists && snap.data().state){
        STATE = JSON.parse(snap.data().state);
        ensureWeekChecklist(STATE.currentWeekIndex);
      }
    }catch(err){
      console.error('Could not fetch latest team state before registering, using local copy.', err);
    }
    submitBtn.textContent = 'Join the team ✨';
    submitBtn.disabled = false;
  }

  // Check if user with this email already exists -> just log them in
  let user = STATE.users.find(u=>u.email.toLowerCase()===email);
  let isNewUser = false;
  if(!user){
    const isFirstUser = STATE.users.length === 0;
    isNewUser = true;
    user = {
      id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      regNumber: STATE.users.length + 1, // simple sequential registration number
      name: name,
      email: email,
      role: isFirstUser ? 'leader' : 'member', // first registrant becomes team leader
      joinedAt: new Date().toISOString(),
    };
    STATE.users.push(user);
    saveState();
    showToast(isFirstUser
      ? `Welcome, ${name}! You're member #${user.regNumber} and Team Leader 👑`
      : `Welcome, ${name}! You're member #${user.regNumber} ✨`);
    sendWelcomeEmail(user);
  } else {
    showToast(`Welcome back, ${user.name}! ✨`);
  }
  saveSession(user.id);

  // Fallback: if localStorage session didn't persist, keep the user logged in
  // for this tab via a query param they can bookmark, so registering never
  // gets "stuck" repeating even on strict/private browsers.
  if(!storageIsWorking()){
    showStorageWarning();
  }

  enterApp();
});

/* ---------- App boot ---------- */
function enterApp(){
  document.getElementById('welcome-screen').style.display='none';
  document.getElementById('app').style.display='block';
  buildNav();
  renderAll();
  goPage('dashboard');
}

document.getElementById('logoutBtn').addEventListener('click', function(){
  if(confirm('Switch user? You can log back in anytime with your name & email.')){
    clearSession();
    location.reload();
  }
});

/* =========================================================
   EMAILJS — pretty welcome email on registration
   Fill these in once you have your EmailJS account set up,
   then set EMAILJS_ENABLED to true.
   ========================================================= */
const EMAILJS_ENABLED = true;
const EMAILJS_PUBLIC_KEY = 'nFXIB4TdpedewRV5-';
const EMAILJS_SERVICE_ID = 'service_mixyl4e';
const EMAILJS_TEMPLATE_ID = 'template_n86vmkt';

let emailjsInitialized = false;
function ensureEmailJsInit(){
  if(emailjsInitialized || typeof emailjs === 'undefined') return;
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
  emailjsInitialized = true;
}

function sendWelcomeEmail(user){
  if(!EMAILJS_ENABLED){
    console.log('[EmailJS disabled] Would send welcome email to', user.email);
    return;
  }
  if(EMAILJS_SERVICE_ID === 'YOUR_SERVICE_ID' || EMAILJS_TEMPLATE_ID === 'YOUR_TEMPLATE_ID'){
    console.warn('EmailJS Service ID / Template ID not set yet — skipping welcome email.');
    return;
  }
  if(typeof emailjs === 'undefined'){
    console.error('EmailJS SDK not loaded.');
    return;
  }
  ensureEmailJsInit();
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_name: user.name,
    to_email: user.email,
    reg_number: user.regNumber,
    role: user.role === 'leader' ? 'Team Leader 👑' : 'Member',
    app_link: window.location.href.split('?')[0],
  }).then(
    ()=> console.log('Welcome email sent to', user.email),
    (err)=> console.error('Welcome email failed:', err)
  );
}

/* ---------- Boot sequence ---------- */
initFirebase();
loadState();
loadSession();
subscribeToCloud();
if(!storageIsWorking()){
  showStorageWarning();
}
if(CURRENT_USER_ID && getCurrentUser()){
  enterApp();
} else {
  document.getElementById('welcome-screen').style.display='flex';
}

/* =========================================================
   NAVIGATION
   ========================================================= */
const NAV_ITEMS = [
  {page:'dashboard', icon:'🏠', label:'Dashboard'},
  {page:'meetings', icon:'📅', label:'Meetings'},
  {page:'roadmap', icon:'🗺️', label:'Roadmap'},
  {page:'tasks', icon:'✅', label:'Tasks'},
  {page:'progress', icon:'📊', label:'Progress'},
  {page:'team', icon:'👥', label:'Team'},
  {page:'history', icon:'📖', label:'History'},
  {page:'profile', icon:'👤', label:'Profile'},
];

function buildNav(){
  // Sidebar already has buttons with data-page; wire clicks
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.addEventListener('click', ()=> goPage(btn.dataset.page));
  });
  // Bottom nav (mobile) - build dynamically
  const bn = document.getElementById('bottomNav');
  bn.innerHTML = NAV_ITEMS.map(n=>`
    <button class="bn-item" data-page="${n.page}">
      <span class="nav-icon">${n.icon}</span>
      <span>${n.label}</span>
    </button>
  `).join('');
  bn.querySelectorAll('.bn-item').forEach(btn=>{
    btn.addEventListener('click', ()=> goPage(btn.dataset.page));
  });
}

function goPage(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b=> b.classList.toggle('active', b.dataset.page===page));
  document.querySelectorAll('.bn-item').forEach(b=> b.classList.toggle('active', b.dataset.page===page));
  window.scrollTo({top:0, behavior:'smooth'});
  renderAll(); // keep everything fresh whenever navigating
}

/* =========================================================
   CORE CALCULATIONS
   ========================================================= */
function getProgressStats(){
  const total = STATE.tasks.length;
  const completed = STATE.tasks.filter(t=>t.status==='Finished').length;
  const inProgress = STATE.tasks.filter(t=>t.status==='Working on it').length;
  const pending = STATE.tasks.filter(t=>t.status==='Not Started').length;
  const pct = total===0 ? 0 : Math.min(100, Math.round((completed/total)*100));
  return {total, completed, inProgress, pending, pct};
}

function getCurrentWeek(){
  return STATE.roadmap[STATE.currentWeekIndex] || STATE.roadmap[STATE.roadmap.length-1];
}

function getWeekProgress(weekId){
  const weekTasks = STATE.tasks.filter(t=>t.weekId===weekId);
  if(weekTasks.length===0) return 0;
  const done = weekTasks.filter(t=>t.status==='Finished').length;
  return Math.round((done/weekTasks.length)*100);
}

function getMemberStats(userId){
  const assigned = STATE.tasks.filter(t=>t.assignee===userId);
  const completed = assigned.filter(t=>t.status==='Finished').length;
  const inProgress = assigned.filter(t=>t.status==='Working on it').length;
  const totalCompletedAllTasks = STATE.tasks.filter(t=>t.status==='Finished').length;
  const contribution = totalCompletedAllTasks===0 ? 0 : Math.round((completed/totalCompletedAllTasks)*100);
  let meetingsAttended = 0;
  Object.keys(STATE.meetings.attendance).forEach(wi=>{
    const rec = STATE.meetings.attendance[wi][userId];
    if(rec && rec.status==='yes') meetingsAttended++;
  });
  return {assigned, completed, inProgress, contribution, meetingsAttended};
}

/* =========================================================
   VOTING LOGIC
   ========================================================= */
function getVotesForWeek(weekIndex){
  return STATE.meetings.votes[weekIndex] || [];
}

function getVoteTally(weekIndex){
  const votes = getVotesForWeek(weekIndex);
  const tally = {}; // "Day Time" -> count
  votes.forEach(v=>{
    const key = `${v.day}|${v.time}`;
    tally[key] = (tally[key]||0) + 1;
  });
  return tally;
}

function getWinningMeeting(weekIndex){
  const votes = getVotesForWeek(weekIndex);
  if(votes.length===0){
    return {day:'Monday', time:'2:00 PM', isDefault:true, isTie:false};
  }
  const tally = getVoteTally(weekIndex);
  let max = 0;
  Object.values(tally).forEach(c=>{ if(c>max) max=c; });
  const winners = Object.entries(tally).filter(([k,c])=>c===max).map(([k])=>k);
  if(winners.length > 1){
    return {day:'Monday', time:'2:00 PM', isDefault:true, isTie:true, tiedOptions: winners};
  }
  const [day, time] = winners[0].split('|');
  return {day, time, isDefault:false, isTie:false};
}

function submitVote(weekIndex, userId, day, time){
  if(!STATE.meetings.votes[weekIndex]) STATE.meetings.votes[weekIndex] = [];
  const arr = STATE.meetings.votes[weekIndex];
  const existingIdx = arr.findIndex(v=>v.userId===userId);
  if(existingIdx>=0){ arr[existingIdx] = {userId, day, time}; }
  else { arr.push({userId, day, time}); }
  saveState();
}

/* =========================================================
   RENDER: DASHBOARD
   ========================================================= */
function renderDashboard(){
  const user = getCurrentUser();
  if(!user) return;
  document.getElementById('dashGreeting').textContent = `Hi, ${user.name.split(' ')[0]}! ✨`;
  document.getElementById('dashSub').textContent = 'Ready to move our X-Culture project forward?';

  const stats = getProgressStats();
  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (stats.pct/100)*circumference;
  document.getElementById('progressRing').style.strokeDasharray = circumference;
  document.getElementById('progressRing').style.strokeDashoffset = offset;
  document.getElementById('progressRingText').textContent = stats.pct + '%';
  document.getElementById('statCompleted').textContent = stats.completed;
  document.getElementById('statProgress').textContent = stats.inProgress;
  document.getElementById('statPending').textContent = stats.pending;

  // Next meeting
  const win = getWinningMeeting(STATE.currentWeekIndex);
  document.getElementById('dashNextMeeting').innerHTML = `
    <div style="font-family:'Fredoka'; font-size:20px;">${win.day} — ${win.time}</div>
    <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:4px;">
      ${win.isTie ? '⚖️ Tie — default kept until resolved' : win.isDefault ? 'Default time (no votes yet)' : '🏆 Team-voted time'}
    </div>
  `;

  // This week's objective
  const week = getCurrentWeek();
  document.getElementById('dashWeekObjective').innerHTML = `
    <div style="font-weight:800; margin-bottom:4px;">${week.title} · ${week.dateRange}</div>
    <div style="font-size:13px; color:var(--plum-soft); font-weight:700;">${week.goal}</div>
  `;

  // My tasks
  const myTasks = STATE.tasks.filter(t=>t.assignee===user.id && t.status!=='Finished').slice(0,4);
  document.getElementById('dashMyTasks').innerHTML = myTasks.length ? myTasks.map(t=>`
    <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid var(--cream-2);">
      <span style="font-weight:700; font-size:13px;">${escapeHtml(t.name)}</span>
      <span class="status-pill status-${t.status.replace(/\s+/g,'-')}">${statusEmoji(t.status)}</span>
    </div>`).join('') : `<div class="empty-state" style="padding:14px;"><div class="es-icon">🌸</div><p>No pending tasks — great job!</p></div>`;

  // Team progress mini
  document.getElementById('dashTeamProgress').innerHTML = `
    <div style="font-size:13px; font-weight:700; color:var(--plum-soft); margin-bottom:8px;">${stats.completed} / ${stats.total} tasks completed across the team</div>
    <div class="week-progress-track"><div class="week-progress-fill" style="width:${stats.pct}%"></div></div>
  `;

  // Upcoming deadline
  const upcoming = getUpcomingMilestone();
  document.getElementById('dashUpcomingDeadline').innerHTML = upcoming ? `
    <div style="font-weight:800;">${upcoming.name}</div>
    <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:2px;">${formatDate(upcoming.date)}</div>
  ` : `<div class="empty-state" style="padding:10px;"><p>All milestones complete! 🎓</p></div>`;
}

function statusEmoji(status){
  if(status==='Not Started') return '🟡';
  if(status==='Working on it') return '🔵';
  if(status==='Finished') return '🟢';
  return '';
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso){
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
}

/* =========================================================
   MILESTONES (Project Timeline)
   ========================================================= */
function getMilestones(){
  return [
    {name:'Team Formed & Readiness Test', date:'2026-08-24', status: STATE.currentWeekIndex>=0 ? 'done':'upcoming'},
    {name:'Establish Teammate Contact', date:'2026-08-27', status: STATE.currentWeekIndex>=1 ? 'done': (STATE.currentWeekIndex===0?'progress':'upcoming')},
    {name:'Select Client Company', date:'2026-09-07', status: STATE.currentWeekIndex>=2 ? 'done': (STATE.currentWeekIndex===1?'progress':'upcoming')},
    {name:'Section 1 Draft', date:'2026-09-14', status: STATE.currentWeekIndex>=3 ? 'done': (STATE.currentWeekIndex===2?'progress':'upcoming')},
    {name:'Section 2 Draft', date:'2026-09-21', status: STATE.currentWeekIndex>=4 ? 'done': (STATE.currentWeekIndex===3?'progress':'upcoming')},
    {name:'Section 3 Draft', date:'2026-09-28', status: STATE.currentWeekIndex>=5 ? 'done': (STATE.currentWeekIndex===4?'progress':'upcoming')},
    {name:'Complete Report Draft', date:'2026-10-05', status: STATE.currentWeekIndex>=6 ? 'done': (STATE.currentWeekIndex===5?'progress':'upcoming')},
    {name:'FINAL Report Submission', date:'2026-10-09', status: STATE.currentWeekIndex>=7 ? 'done':'deadline'},
    {name:'Post-Project Survey', date:'2026-10-12', status:'upcoming'},
  ];
}

function getUpcomingMilestone(){
  const ms = getMilestones();
  return ms.find(m=>m.status!=='done') || null;
}

function renderProgressPage(){
  const stats = getProgressStats();
  document.getElementById('bigProgressNum').textContent = stats.pct + '%';
  document.getElementById('bigProgressSub').textContent = `${stats.completed} / ${stats.total} tasks completed`;
  document.getElementById('bigProgressBar').style.width = stats.pct + '%';
  document.getElementById('progWeekLabel').textContent = getCurrentWeek().title;
  document.getElementById('progMeetingsHeld').textContent = STATE.history.length;
  const upcoming = getUpcomingMilestone();
  document.getElementById('progMilestone').textContent = upcoming ? upcoming.name.split(' ').slice(0,2).join(' ') : 'Complete!';

  const ms = getMilestones();
  document.getElementById('timelineList').innerHTML = ms.map(m=>`
    <div class="tl-item">
      <div class="tl-dot ${m.status}"></div>
      <div class="tl-card">
        <div class="tl-date">${formatDate(m.date)}</div>
        <div class="tl-name">${m.name}</div>
        <div style="font-size:12px; font-weight:800; color:${milestoneColor(m.status)}">${milestoneLabel(m.status)}</div>
      </div>
    </div>
  `).join('');
}
function milestoneLabel(s){ return {done:'🟢 Completed', progress:'🔵 In Progress', upcoming:'🟡 Upcoming', deadline:'🔴 Deadline'}[s]; }
function milestoneColor(s){ return {done:'#3E8B54', progress:'#2E71A3', upcoming:'#A67C1E', deadline:'#B5433F'}[s]; }

/* =========================================================
   RENDER: MEETINGS
   ========================================================= */
function renderMeetingsPage(){
  const user = getCurrentUser();
  const wi = STATE.currentWeekIndex;
  ensureWeekChecklist(wi);
  const win = getWinningMeeting(wi);

  document.getElementById('meetHeroDay').textContent = `${win.day} — ${win.time}`;
  document.getElementById('meetHeroSub').innerHTML = win.isTie
    ? '⚖️ It\'s a tie! Keeping the default until the team resolves it.'
    : win.isDefault ? 'Default time · no votes cast yet this week' : '🏆 Selected by team vote';

  // Day picker
  const votes = getVotesForWeek(wi);
  const myVote = votes.find(v=>v.userId===user.id);
  const dayPicker = document.getElementById('dayPicker');
  dayPicker.innerHTML = DAYS.map(d=>`<button type="button" class="day-chip ${myVote && myVote.day===d ? 'selected':''}" data-day="${d}">${d.slice(0,3)}</button>`).join('');
  dayPicker.querySelectorAll('.day-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      dayPicker.querySelectorAll('.day-chip').forEach(c=>c.classList.remove('selected'));
      chip.classList.add('selected');
    });
  });
  if(myVote){ document.getElementById('timePicker').value = myVote.time; }
  document.getElementById('myVoteNote').textContent = myVote ? `You voted: ${myVote.day} at ${myVote.time}. You can change it anytime before the meeting.` : 'You haven\'t voted yet this week.';

  // Voting results
  const tally = getVoteTally(wi);
  const entries = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
  const maxVotes = entries.length ? entries[0][1] : 0;
  document.getElementById('voteResults').innerHTML = entries.length ? entries.map(([key,count])=>{
    const [day,time] = key.split('|');
    const isWinner = count===maxVotes && !win.isTie;
    const pct = Math.round((count / votes.length) * 100);
    return `
      <div class="vote-bar-row">
        <div class="vote-bar-label"><span>${day} ${time} ${isWinner ? '<span class=\"winning-badge\">WINNING</span>':''} ${win.isTie && count===maxVotes ? '<span class=\"tie-badge\">TIE</span>':''}</span><span>${count} vote${count!==1?'s':''}</span></div>
        <div class="vote-bar-track"><div class="vote-bar-fill ${isWinner?'winner':''}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('') : `<div class="empty-state"><div class="es-icon">🗳️</div><p>No votes yet — be the first to vote!</p></div>`;

  // My attendance form
  if(!STATE.meetings.attendance[wi]) STATE.meetings.attendance[wi] = {};
  const myAtt = STATE.meetings.attendance[wi][user.id] || {status:'pending', comment:''};
  document.getElementById('myAttendanceForm').innerHTML = `
    <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
      <button class="btn btn-sm ${myAtt.status==='yes' ? 'btn-green':'btn-outline'}" id="attYesBtn">☑ I'll be there!</button>
      <button class="btn btn-sm ${myAtt.status==='no' ? 'btn-danger-outline':'btn-outline'}" id="attNoBtn">✕ Can't make it</button>
    </div>
    <label style="font-weight:800; font-size:12px; color:var(--plum-soft); display:block; margin-bottom:6px;">Comment (optional)</label>
    <textarea class="tnote" id="attComment" placeholder="e.g. I might arrive 10 minutes late.">${escapeHtml(myAtt.comment||'')}</textarea>
    <button class="btn btn-lav btn-sm" style="margin-top:10px;" id="saveAttBtn">Save</button>
  `;

  // Team attendance
  const attMap = STATE.meetings.attendance[wi];
  document.getElementById('teamAttendance').innerHTML = STATE.users.map(u=>{
    const rec = attMap[u.id] || {status:'pending', comment:''};
    const icon = rec.status==='yes' ? '✓' : rec.status==='no' ? '✕' : '?';
    const cls = rec.status==='yes' ? 'att-yes' : rec.status==='no' ? 'att-no' : 'att-pending';
    return `<div class="attendance-row">
      <div class="att-status ${cls}">${icon}</div>
      <div>
        <div style="font-weight:800; font-size:13px;">${escapeHtml(u.name)}</div>
        ${rec.comment ? `<div class="att-comment">"${escapeHtml(rec.comment)}"</div>` : ''}
      </div>
    </div>`;
  }).join('') || `<div class="empty-state"><p>No team members yet.</p></div>`;

  // Reminder card
  const stats = getProgressStats();
  const week = getCurrentWeek();
  document.getElementById('reminderCard').innerHTML = `
    <div style="background:var(--cream); border-radius:16px; padding:16px 18px;">
      <div style="font-weight:800; margin-bottom:6px;">✨ Reminder! Our X-Culture meeting is coming up.</div>
      <div style="font-family:'Fredoka'; font-size:17px;">${win.day} at ${win.time}</div>
      <div style="font-size:13px; color:var(--plum-soft); font-weight:700; margin-top:6px;">
        📍 Location/link: <em>${STATE.meetingLink || 'Not configured yet — add your video call link!'}</em><br>
        📊 Current progress: ${stats.pct}%<br>
        🎯 Focus: ${escapeHtml(week.goal)}
      </div>
      <div style="font-size:11px; color:var(--plum-soft); margin-top:8px; opacity:0.75;">
        Simulated in-app reminder — structured so a real email service (e.g. via SendGrid/EmailJS) can be plugged in via <code>sendMeetingReminder()</code> later.
      </div>
    </div>
  `;

  // Agenda checklist
  renderChecklist();
}

function renderChecklist(){
  const wi = STATE.currentWeekIndex;
  const week = getCurrentWeek();
  ensureWeekChecklist(wi);
  const items = STATE.meetings.checklists[wi];
  const doneCount = items.filter(i=>i.done).length;
  document.getElementById('agendaChecklist').innerHTML = `
    <div style="font-weight:800; margin-bottom:10px;">Meeting — ${week.title}</div>
    ${items.map(it=>`
      <div class="checklist-item ${it.done?'done':''}">
        <input type="checkbox" id="chk_${it.id}" ${it.done?'checked':''} data-id="${it.id}">
        <label for="chk_${it.id}">${escapeHtml(it.text)}</label>
      </div>
    `).join('')}
    <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:8px;">${doneCount} / ${items.length} checked off</div>
  `;
  document.querySelectorAll('#agendaChecklist input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', function(){
      const item = STATE.meetings.checklists[wi].find(i=>i.id===cb.dataset.id);
      item.done = cb.checked;
      saveState();
      renderChecklist();
      if(STATE.meetings.checklists[wi].every(i=>i.done)){
        showToast('Week complete! You did it! 🌸');
      }
    });
  });
}

/* Meetings page interactions (event delegation via re-render, so bind on document) */
document.addEventListener('click', function(e){
  if(e.target.id==='submitVoteBtn'){
    const user = getCurrentUser();
    const selectedDay = document.querySelector('#dayPicker .day-chip.selected');
    if(!selectedDay){ showToast('Please choose a day first 🌸'); return; }
    const time = document.getElementById('timePicker').value;
    submitVote(STATE.currentWeekIndex, user.id, selectedDay.dataset.day, time);
    showToast('Vote submitted! ✨');
    renderMeetingsPage();
    renderDashboard();
  }
  if(e.target.id==='attYesBtn' || e.target.id==='attNoBtn'){
    const wi = STATE.currentWeekIndex;
    const user = getCurrentUser();
    if(!STATE.meetings.attendance[wi]) STATE.meetings.attendance[wi] = {};
    const existing = STATE.meetings.attendance[wi][user.id] || {comment:''};
    existing.status = e.target.id==='attYesBtn' ? 'yes' : 'no';
    STATE.meetings.attendance[wi][user.id] = existing;
    saveState();
    renderMeetingsPage();
  }
  if(e.target.id==='saveAttBtn'){
    const wi = STATE.currentWeekIndex;
    const user = getCurrentUser();
    if(!STATE.meetings.attendance[wi]) STATE.meetings.attendance[wi] = {};
    const existing = STATE.meetings.attendance[wi][user.id] || {status:'pending'};
    existing.comment = document.getElementById('attComment').value.trim();
    STATE.meetings.attendance[wi][user.id] = existing;
    saveState();
    showToast('Attendance saved ✨');
    renderMeetingsPage();
  }
});

/* =========================================================
   RENDER: ROADMAP
   ========================================================= */
function renderRoadmap(){
  document.getElementById('roadmapList').innerHTML = STATE.roadmap.map((week, idx)=>{
    const pct = getWeekProgress(week.id);
    const weekTasks = STATE.tasks.filter(t=>t.weekId===week.id);
    const isCurrent = idx===STATE.currentWeekIndex;
    return `
      <div class="week-card ${isCurrent ? 'active-week':''}">
        <div class="week-head">
          <div>
            <span class="week-badge ${isCurrent?'current':''}">${week.title}${isCurrent?' · CURRENT':''}</span>
            <span style="font-size:12px; color:var(--plum-soft); font-weight:800; margin-left:8px;">${week.dateRange}</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; font-weight:800; color:var(--plum-soft);">Deadline: ${formatDate(week.deadline)}</span>
            ${!isCurrent ? `<button class="btn btn-sm btn-outline" data-set-week="${idx}">Set as current</button>` : ''}
          </div>
        </div>
        <div style="font-weight:800; margin-bottom:6px;">🎯 ${escapeHtml(week.goal)}</div>
        <div class="week-progress-track"><div class="week-progress-fill" style="width:${pct}%"></div></div>
        <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:4px;">${pct}% of this week's tasks complete</div>
        <ul class="week-tasks-list">
          ${weekTasks.map(t=>`<li>${statusEmoji(t.status)} ${escapeHtml(t.name)}</li>`).join('') || week.tasks.map(t=>`<li>· ${escapeHtml(t)}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');

  document.querySelectorAll('[data-set-week]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      STATE.currentWeekIndex = parseInt(btn.dataset.setWeek, 10);
      ensureWeekChecklist(STATE.currentWeekIndex);
      saveState();
      showToast(`Now viewing ${STATE.roadmap[STATE.currentWeekIndex].title} as current week`);
      renderAll();
    });
  });
}

/* =========================================================
   RENDER: TASKS
   ========================================================= */
let taskFilter = 'all';

function renderTaskFilterBar(){
  const filters = [
    {key:'all', label:'All'},
    {key:'Not Started', label:'🟡 Not Started'},
    {key:'Working on it', label:'🔵 Working on it'},
    {key:'Finished', label:'🟢 Finished'},
    {key:'mine', label:'👤 My Tasks'},
  ];
  document.getElementById('taskFilterBar').innerHTML = filters.map(f=>
    `<button class="btn btn-sm ${taskFilter===f.key?'btn-lav':'btn-outline'}" data-filter="${f.key}">${f.label}</button>`
  ).join('');
  document.querySelectorAll('[data-filter]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ taskFilter = btn.dataset.filter; renderTasksPage(); });
  });
}

function renderTasksPage(){
  const stats = getProgressStats();
  document.getElementById('taskTotalCount').textContent = stats.total;
  document.getElementById('taskNotStartedCount').textContent = stats.pending;
  document.getElementById('taskWorkingCount').textContent = stats.inProgress;
  document.getElementById('taskFinishedCount').textContent = stats.completed;

  renderTaskFilterBar();

  const user = getCurrentUser();
  let list = STATE.tasks;
  if(taskFilter==='mine') list = list.filter(t=>t.assignee===user.id);
  else if(taskFilter!=='all') list = list.filter(t=>t.status===taskFilter);

  document.getElementById('taskList').innerHTML = list.length ? list.map(t=>{
    const assigneeUser = STATE.users.find(u=>u.id===t.assignee);
    const canEdit = user.role==='leader' || t.assignee===user.id;
    return `
    <div class="task-card">
      <div class="task-top">
        <div>
          <div class="task-name">${escapeHtml(t.name)}</div>
          ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
        </div>
        <span class="priority-tag priority-${t.priority}">${t.priority}</span>
      </div>
      <div class="task-meta">
        <span>👤 ${assigneeUser ? escapeHtml(assigneeUser.name) : 'Unassigned'}</span>
        ${t.deadline ? `<span>📅 ${formatDate(t.deadline)}</span>` : ''}
        <span>Week: ${STATE.roadmap.find(w=>w.id===t.weekId)?.title || '—'}</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; flex-wrap:wrap; gap:8px;">
        ${canEdit ? `
        <select class="status-select" data-task-status="${t.id}">
          <option value="Not Started" ${t.status==='Not Started'?'selected':''}>🟡 Not Started</option>
          <option value="Working on it" ${t.status==='Working on it'?'selected':''}>🔵 Working on it</option>
          <option value="Finished" ${t.status==='Finished'?'selected':''}>🟢 Finished</option>
        </select>` : `<span class="status-pill status-${t.status.replace(/\s+/g,'-')}">${statusEmoji(t.status)} ${t.status}</span>`}
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-outline" data-comment-task="${t.id}">💬 Comment</button>
          ${user.role==='leader' ? `<button class="btn btn-sm btn-outline" data-edit-task="${t.id}">✏️ Edit</button>` : ''}
        </div>
      </div>
      ${renderTaskComments(t.id)}
    </div>`;
  }).join('') : `<div class="empty-state"><div class="es-icon">🌷</div><p>No tasks here yet.</p></div>`;

  document.querySelectorAll('[data-task-status]').forEach(sel=>{
    sel.addEventListener('change', function(){
      const task = STATE.tasks.find(t=>t.id===sel.dataset.taskStatus);
      const oldStatus = task.status;
      task.status = sel.value;
      saveState();
      if(oldStatus!=='Finished' && task.status==='Finished'){
        showToast('Nice work! ✨ Task completed!');
        checkProgressMilestoneToast();
      }
      renderAll();
    });
  });
  document.querySelectorAll('[data-edit-task]').forEach(btn=>{
    btn.addEventListener('click', ()=> openTaskModal(btn.dataset.editTask));
  });
  document.querySelectorAll('[data-comment-task]').forEach(btn=>{
    btn.addEventListener('click', ()=> openCommentModal('task', btn.dataset.commentTask));
  });
}

function renderTaskComments(taskId){
  const cmts = STATE.comments.filter(c=>c.targetType==='task' && c.targetId===taskId);
  if(cmts.length===0) return '';
  return `<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--cream-2);">
    ${cmts.map(c=>renderCommentHtml(c)).join('')}
  </div>`;
}

function renderCommentHtml(c){
  const u = STATE.users.find(u=>u.id===c.userId);
  return `<div class="comment-item">
    <div class="comment-avatar">${u ? initials(u.name) : '?'}</div>
    <div class="comment-body">
      <div class="comment-head"><span>${u ? escapeHtml(u.name) : 'Unknown'}</span><span class="cdate">${formatDate(c.date)}</span></div>
      <div style="font-size:13px;">${escapeHtml(c.text)}</div>
    </div>
  </div>`;
}

let lastToastedMilestone = 0;
function checkProgressMilestoneToast(){
  const pct = getProgressStats().pct;
  if(pct>=100 && lastToastedMilestone<100){ showToast('Project completed! 🎓✨'); lastToastedMilestone=100; }
  else if(pct>=50 && lastToastedMilestone<50){ showToast("We're halfway there! 🎉"); lastToastedMilestone=50; }
}

/* Task modal */
function openTaskModal(taskId){
  const modal = document.getElementById('taskModal');
  const assigneeSel = document.getElementById('taskAssignee');
  assigneeSel.innerHTML = `<option value="">Unassigned</option>` + STATE.users.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');

  if(taskId){
    const t = STATE.tasks.find(t=>t.id===taskId);
    document.getElementById('taskModalTitle').textContent = 'Edit Task';
    document.getElementById('taskId').value = t.id;
    document.getElementById('taskName').value = t.name;
    document.getElementById('taskDesc').value = t.description||'';
    assigneeSel.value = t.assignee || '';
    document.getElementById('taskDeadline').value = t.deadline||'';
    document.getElementById('taskPriority').value = t.priority;
    document.getElementById('taskStatus').value = t.status;
  } else {
    document.getElementById('taskModalTitle').textContent = 'New Task';
    document.getElementById('taskForm').reset();
    document.getElementById('taskId').value = '';
  }
  modal.classList.add('show');
}
function closeModal(id){ document.getElementById(id).classList.remove('show'); }

document.getElementById('newTaskBtn').addEventListener('click', ()=> openTaskModal(null));

document.getElementById('taskForm').addEventListener('submit', function(e){
  e.preventDefault();
  const id = document.getElementById('taskId').value;
  const data = {
    name: document.getElementById('taskName').value.trim(),
    description: document.getElementById('taskDesc').value.trim(),
    assignee: document.getElementById('taskAssignee').value || null,
    deadline: document.getElementById('taskDeadline').value,
    priority: document.getElementById('taskPriority').value,
    status: document.getElementById('taskStatus').value,
  };
  if(id){
    const t = STATE.tasks.find(t=>t.id===id);
    const wasFinished = t.status==='Finished';
    Object.assign(t, data);
    if(!wasFinished && t.status==='Finished'){ showToast('Nice work! ✨ Task completed!'); checkProgressMilestoneToast(); }
  } else {
    data.id = 't_' + Date.now();
    data.weekId = getCurrentWeek().id;
    STATE.tasks.push(data);
    showToast('Task created! 🌸');
  }
  saveState();
  closeModal('taskModal');
  renderAll();
});

/* Comment modal */
function openCommentModal(targetType, targetId){
  document.getElementById('commentTarget').value = targetType+'|'+targetId;
  document.getElementById('commentText').value='';
  document.getElementById('commentModal').classList.add('show');
}
document.getElementById('commentForm').addEventListener('submit', function(e){
  e.preventDefault();
  const [targetType, targetId] = document.getElementById('commentTarget').value.split('|');
  const user = getCurrentUser();
  STATE.comments.push({
    id:'cm_'+Date.now(), targetType, targetId, userId:user.id,
    text: document.getElementById('commentText').value.trim(),
    date: new Date().toISOString().slice(0,10),
  });
  saveState();
  closeModal('commentModal');
  showToast('Comment posted 💬');
  renderAll();
});

/* =========================================================
   RENDER: TEAM
   ========================================================= */
function renderTeamPage(){
  document.getElementById('teamGrid').innerHTML = STATE.users.map(u=>{
    const stats = getMemberStats(u.id);
    const assignedActive = stats.assigned.filter(t=>t.status!=='Finished');
    return `
      <div class="member-card">
        <div class="member-avatar">${initials(u.name)}</div>
        <div class="member-name">✨ ${escapeHtml(u.name)} ${u.role==='leader' ? '👑':''}</div>
        <div class="member-email">${escapeHtml(u.email)}</div>
        <div style="font-size:11px; color:var(--plum-soft); font-weight:800; margin-bottom:6px;">Member #${u.regNumber || '—'}</div>
        <div style="font-size:12px; color:var(--plum-soft); font-weight:800;">${stats.assigned.length} task${stats.assigned.length!==1?'s':''} · ${stats.completed} completed</div>
        <div class="member-stats">
          <div><div class="num">${assignedActive.length}</div>Active</div>
          <div><div class="num">${stats.completed}</div>Done</div>
          <div><div class="num">${stats.contribution}%</div>Contrib.</div>
        </div>
      </div>
    `;
  }).join('') || `<div class="empty-state"><div class="es-icon">👥</div><p>No team members registered yet. Share the link with your teammates!</p></div>`;
}

/* =========================================================
   RENDER: MEETING HISTORY
   ========================================================= */
function archiveCurrentMeeting(){
  const wi = STATE.currentWeekIndex;
  const win = getWinningMeeting(wi);
  const attendance = STATE.meetings.attendance[wi] || {};
  const checklist = STATE.meetings.checklists[wi] || [];
  STATE.history.push({
    weekIndex: wi,
    weekTitle: getCurrentWeek().title,
    day: win.day, time: win.time,
    attendance: JSON.parse(JSON.stringify(attendance)),
    checklist: JSON.parse(JSON.stringify(checklist)),
    archivedAt: new Date().toISOString(),
  });
  saveState();
}

function renderHistoryPage(){
  const user = getCurrentUser();
  const canArchive = user.role==='leader';
  let html = '';
  if(canArchive){
    html += `<div style="margin-bottom:16px;"><button class="btn btn-pink btn-sm" id="archiveMeetingBtn">📥 Archive this week's meeting</button></div>`;
  }
  if(STATE.history.length===0){
    html += `<div class="empty-state"><div class="es-icon">📖</div><p>No completed meetings yet. Your first archived meeting will show up here!</p></div>`;
  } else {
    html += [...STATE.history].reverse().map((m, i)=>{
      const attRows = Object.entries(m.attendance).map(([uid,rec])=>{
        const u = STATE.users.find(u=>u.id===uid);
        const icon = rec.status==='yes' ? '✓' : rec.status==='no' ? '✕' : '?';
        return `<div style="font-size:12px; font-weight:700; padding:2px 0;">${icon} ${u?escapeHtml(u.name):'—'} ${rec.comment ? `<em style="color:var(--plum-soft);">"${escapeHtml(rec.comment)}"</em>`:''}</div>`;
      }).join('') || '<div style="font-size:12px; color:var(--plum-soft);">No attendance recorded.</div>';
      const checkedItems = m.checklist.filter(c=>c.done).length;
      return `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-title">📖 ${m.weekTitle} — ${m.day}, ${m.time}</div>
        <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-bottom:8px;">Archived ${formatDate(m.archivedAt.slice(0,10))}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          <div><div style="font-weight:800; font-size:13px; margin-bottom:6px;">Attendance</div>${attRows}</div>
          <div><div style="font-weight:800; font-size:13px; margin-bottom:6px;">Checklist (${checkedItems}/${m.checklist.length})</div>
            ${m.checklist.map(c=>`<div style="font-size:12px; font-weight:700; padding:2px 0; ${c.done?'text-decoration:line-through; color:var(--plum-soft);':''}">${c.done?'☑':'☐'} ${escapeHtml(c.text)}</div>`).join('')}
          </div>
        </div>
      </div>`;
    }).join('');
  }
  document.getElementById('historyList').innerHTML = html;

  const archiveBtn = document.getElementById('archiveMeetingBtn');
  if(archiveBtn){
    archiveBtn.addEventListener('click', ()=>{
      archiveCurrentMeeting();
      showToast('Meeting archived to history 📥');
      renderHistoryPage();
    });
  }
}

/* =========================================================
   RENDER: PROFILE
   ========================================================= */
function renderProfilePage(){
  const user = getCurrentUser();
  document.getElementById('profileAvatar').textContent = initials(user.name);
  document.getElementById('profileName').textContent = user.name + (user.role==='leader' ? ' 👑 (Team Leader)' : '');
  document.getElementById('profileEmail').textContent = user.email;
  document.getElementById('profileRegNumber').textContent = `Member #${user.regNumber || '—'} · ${user.role==='leader' ? 'Team Leader' : 'Member'}`;

  const stats = getMemberStats(user.id);
  document.getElementById('pfCompleted').textContent = stats.completed;
  document.getElementById('pfProgress').textContent = stats.inProgress;
  document.getElementById('pfMeetings').textContent = stats.meetingsAttended;
  document.getElementById('pfContribution').textContent = stats.contribution + '%';

  document.getElementById('pfTaskList').innerHTML = stats.assigned.length ? stats.assigned.map(t=>`
    <div style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-bottom:1px solid var(--cream-2);">
      <div>
        <div style="font-weight:800; font-size:13px;">${escapeHtml(t.name)}</div>
        ${t.deadline ? `<div style="font-size:11px; color:var(--plum-soft); font-weight:700;">Due ${formatDate(t.deadline)}</div>` : ''}
      </div>
      <span class="status-pill status-${t.status.replace(/\s+/g,'-')}">${statusEmoji(t.status)} ${t.status}</span>
    </div>
  `).join('') : `<div class="empty-state"><div class="es-icon">🌷</div><p>No tasks assigned to you yet.</p></div>`;
}

/* =========================================================
   MASTER RENDER
   ========================================================= */
function renderAll(){
  const user = getCurrentUser();
  if(!user) return;
  document.getElementById('sidebarAvatar').textContent = initials(user.name);
  document.getElementById('sidebarName').textContent = user.name;
  document.getElementById('sidebarRole').textContent = user.role==='leader' ? 'Team Leader 👑' : 'Member';

  renderDashboard();
  renderMeetingsPage();
  renderRoadmap();
  renderTasksPage();
  renderProgressPage();
  renderTeamPage();
  renderHistoryPage();
  renderProfilePage();
}

/* Placeholder for future real email integration */
function sendMeetingReminder(meetingData){
  // TODO: connect to a real email API (e.g. EmailJS, SendGrid, Supabase Edge Function).
  console.log('[Simulated email reminder]', meetingData);
}
