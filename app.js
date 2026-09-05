/* =========================================================
   X-CULTURE TEAM HUB — Amigos Caffè
   Data / State / Persistence layer (Firebase Firestore, shared
   live across the whole team + localStorage as an offline cache)
   ========================================================= */

const STORAGE_KEY = 'xculture_hub_state_v1';
const SESSION_KEY = 'xculture_hub_session_v1';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

/* ---------- Globals declared early to avoid temporal-dead-zone errors ----------
   These are referenced by functions that can run during the boot sequence
   (e.g. enterApp -> buildNav, or renderAll -> renderRoadmap), so they must
   exist before any of that code runs, not just "later in the file". */
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
let expandedWeekId = null; // which roadmap week card is expanded to show its tasks
let taskFilter = 'all'; // current filter selected on the Tasks page

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
    currentWeekIndex: 1,
    // Each week has its own `status`: 'done' | 'current' | 'upcoming'.
    // ONLY the leader decides this (via the Roadmap page buttons) — simple
    // and predictable, no automatic date-based guessing involved.
    roadmap: [
      { id:'w1', title:'Week 1', dateRange:'Aug 24 – Aug 30', goal:'Understand the X-Culture challenge, form our team, and define our strategy.', deadline:'2026-08-31', status:'done',
        tasks:['Read project requirements','Introduce ourselves','Assign initial responsibilities','Establish communication channels','Pass the readiness test'] },
      { id:'w2', title:'Week 2', dateRange:'Aug 31 – Sep 6', goal:'Get to know teammates and prepare to select our client company.', deadline:'2026-09-07', status:'current',
        tasks:['Video call to meet the team','Review available client challenges','Discuss role division','Select Amigos Caffè as client'] },
      { id:'w3', title:'Week 3', dateRange:'Sep 7 – Sep 13', goal:'Kick off Section 1: industry & competitor research for Amigos Caffè.', deadline:'2026-09-14', status:'upcoming',
        tasks:['Research Italian coffee competitors','Identify candidate target markets','Draft consumer interview questions','Begin SWOT analysis'] },
      { id:'w4', title:'Week 4', dateRange:'Sep 14 – Sep 20', goal:'Finish Section 1 draft and select the proposed target market.', deadline:'2026-09-21', status:'upcoming',
        tasks:['Complete competitor analysis','Conduct consumer/buyer interviews','Finalize target market choice','Submit Section 1 draft'] },
      { id:'w5', title:'Week 5', dateRange:'Sep 21 – Sep 27', goal:'Work on Section 2: product, pricing, entry mode, logistics, legal & HR.', deadline:'2026-09-28', status:'upcoming',
        tasks:['Match products to target market','Draft pricing strategy','Compare market entry modes','Research logistics & compliance'] },
      { id:'w6', title:'Week 6', dateRange:'Sep 28 – Oct 4', goal:'Finish Section 2 and start Section 3: marketing plan.', deadline:'2026-10-05', status:'upcoming',
        tasks:['Submit Section 2 draft','Analyze current marketing assets','Choose promotion channels','Draft campaign message'] },
      { id:'w7', title:'Week 7', dateRange:'Oct 5 – Oct 8', goal:'Assemble the complete report draft and refine all sections.', deadline:'2026-10-05', status:'upcoming',
        tasks:['Compile Title Page & Exec Summary','Merge all sections','Create promotional material sample','Proofread & format to guidelines'] },
      { id:'w8', title:'Week 8', dateRange:'Oct 9 – Oct 12', goal:'Finalize and submit the report; complete post-project survey.', deadline:'2026-10-09', status:'upcoming',
        tasks:['Final proofreading pass','Submit FINAL report','Submit recommendations summary','Complete post-project survey'] },
    ],
    // Team tasks are now created ONLY by the leader (via the Tasks tab), each one
    // tied to a Weekly Roadmap week. Weeks 1-3 are pre-marked done since they're
    // already finished in real life.
    tasks: [],
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

function isLeader(user){
  user = user || getCurrentUser();
  return !!user && user.role==='leader';
}

/* List of common IANA timezones for the registration/profile picker. */
const TIMEZONE_OPTIONS = [
  'Pacific/Midway','Pacific/Honolulu','America/Anchorage','America/Los_Angeles','America/Tijuana',
  'America/Denver','America/Phoenix','America/Chicago','America/Mexico_City','America/Bogota',
  'America/Lima','America/New_York','America/Toronto','America/Caracas','America/Santiago',
  'America/La_Paz','America/Halifax','America/Sao_Paulo','America/Argentina/Buenos_Aires',
  'Atlantic/Azores','UTC','Europe/London','Europe/Lisbon','Europe/Madrid','Europe/Paris',
  'Europe/Berlin','Europe/Rome','Europe/Amsterdam','Europe/Warsaw','Europe/Athens',
  'Europe/Helsinki','Europe/Istanbul','Europe/Moscow','Africa/Cairo','Africa/Lagos',
  'Africa/Johannesburg','Asia/Jerusalem','Asia/Dubai','Asia/Karachi','Asia/Kolkata',
  'Asia/Dhaka','Asia/Bangkok','Asia/Jakarta','Asia/Shanghai','Asia/Singapore','Asia/Hong_Kong',
  'Asia/Tokyo','Asia/Seoul','Australia/Perth','Australia/Adelaide','Australia/Sydney',
  'Pacific/Auckland',
];

function populateTimezoneSelect(selectEl, selectedValue){
  if(!selectEl) return;
  const detected = detectTimezone();
  const opts = TIMEZONE_OPTIONS.includes(detected) ? TIMEZONE_OPTIONS : [detected, ...TIMEZONE_OPTIONS];
  selectEl.innerHTML = opts.map(tz=>`<option value="${tz}">${tz.replace(/_/g,' ')}</option>`).join('');
  selectEl.value = selectedValue || detected;
  if(selectEl.value !== (selectedValue||detected)){
    // Fallback if the exact tz string wasn't in the list.
    const opt = document.createElement('option');
    opt.value = selectedValue || detected;
    opt.textContent = (selectedValue||detected).replace(/_/g,' ');
    selectEl.appendChild(opt);
    selectEl.value = selectedValue || detected;
  }
}

/* ---------- Timezone conversion for meeting times ----------
   The winning meeting day/time is voted in the "team" reference (we treat
   the vote's literal day+time as being in the CURRENT user's own local time
   for simplicity, then project it into every other member's timezone so
   everyone can see how the same real moment lands on their clock). */
function parseTimeTo24h(timeStr){
  // "2:00 PM" -> {h:14, m:0}
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if(!m) return {h:12, m:0};
  let h = parseInt(m[1],10);
  const min = parseInt(m[2],10);
  const ap = m[3].toUpperCase();
  if(ap==='PM' && h!==12) h += 12;
  if(ap==='AM' && h===12) h = 0;
  return {h, m:min};
}

function dayNameToNextDateUTCOffset(dayName){
  // Returns an offset (0-6) representing how many days from "today" the
  // next occurrence of dayName falls, purely to build a concrete Date for
  // timezone math (the specific calendar date doesn't matter, only the
  // wall-clock time + DST rules for that time of year).
  const idx = DAYS.indexOf(dayName);
  const today = new Date();
  const todayIdx = (today.getDay()+6)%7; // convert Sun=0 -> Mon=0 indexing to match DAYS
  let diff = (idx - todayIdx + 7) % 7;
  return diff;
}

/* Converts a {day, time} voted in `fromTz` into the equivalent wall-clock
   day/time in `toTz`. Uses Intl to correctly account for each zone's UTC
   offset (including DST) around the upcoming occurrence of that weekday. */
function convertMeetingTime(day, time, fromTz, toTz){
  try{
    const {h, m} = parseTimeTo24h(time);
    const offsetDays = dayNameToNextDateUTCOffset(day);
    const base = new Date();
    base.setDate(base.getDate() + offsetDays);
    base.setHours(12,0,0,0); // noon anchor to sidestep DST edge-cases while finding the offset

    // Get fromTz's UTC offset (minutes) at that date/time.
    const getOffsetMinutes = (tz, dateObj)=>{
      const dtf = new Intl.DateTimeFormat('en-US', {timeZone:tz, hourCycle:'h23',
        year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const parts = dtf.formatToParts(dateObj).reduce((acc,p)=>{acc[p.type]=p.value; return acc;},{});
      const asUTC = Date.UTC(parts.year, parts.month-1, parts.day, parts.hour, parts.minute, parts.second);
      return (asUTC - dateObj.getTime()) / 60000;
    };

    // Build the intended wall-clock moment in fromTz on that date.
    const candidateUTC = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m, 0));
    const fromOffset = getOffsetMinutes(fromTz, candidateUTC);
    const trueUTCms = candidateUTC.getTime() - fromOffset*60000;
    const trueUTC = new Date(trueUTCms);

    const toOffset = getOffsetMinutes(toTz, trueUTC);
    const localMs = trueUTC.getTime() + toOffset*60000;
    const localDate = new Date(localMs);

    const weekdayFmt = new Intl.DateTimeFormat('en-US', {timeZone:toTz, weekday:'long'});
    const timeFmt = new Intl.DateTimeFormat('en-US', {timeZone:toTz, hour:'numeric', minute:'2-digit', hour12:true});
    return { day: weekdayFmt.format(trueUTC), time: timeFmt.format(trueUTC) };
  }catch(e){
    console.error('Timezone conversion failed', e);
    return { day, time };
  }
}

function tzAbbrev(tz){
  try{
    const parts = new Intl.DateTimeFormat('en-US', {timeZone:tz, timeZoneName:'short'}).formatToParts(new Date());
    const tzPart = parts.find(p=>p.type==='timeZoneName');
    return tzPart ? tzPart.value : tz;
  }catch(e){ return tz; }
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

// Best-effort auto-detected IANA timezone for this browser (e.g. "America/Bogota").
function detectTimezone(){
  try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch(e){ return 'UTC'; }
}

document.getElementById('registerForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const timezoneSel = document.getElementById('regTimezone');
  const timezone = (timezoneSel && timezoneSel.value) ? timezoneSel.value : detectTimezone();
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
      timezone: timezone,
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
const EMAILJS_TEMPLATE_ID = 'template_n86vmkt'; // welcome email

// NEW: separate EmailJS template used whenever the leader assigns (or
// reassigns) a task to a teammate. Create this template in your EmailJS
// dashboard with variables matching what's sent in sendTaskAssignedEmail()
// below (to_name, to_email, task_name, task_description, task_deadline,
// task_priority, week_title, app_link), then paste its ID here.
const EMAILJS_TASK_TEMPLATE_ID = 'template_task_assigned';

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

/* Sent whenever the leader assigns a task to someone (new task, or an
   existing task's assignee is changed to a new person). */
function sendTaskAssignedEmail(user, task){
  if(!user || !user.email) return;
  if(!EMAILJS_ENABLED){
    console.log('[EmailJS disabled] Would send task-assigned email to', user.email, task && task.name);
    return;
  }
  if(!EMAILJS_TASK_TEMPLATE_ID || EMAILJS_TASK_TEMPLATE_ID==='YOUR_TASK_TEMPLATE_ID'){
    console.warn('EmailJS task-assignment Template ID not set yet — skipping task email.');
    return;
  }
  if(typeof emailjs === 'undefined'){
    console.error('EmailJS SDK not loaded.');
    return;
  }
  ensureEmailJsInit();
  const week = STATE.roadmap.find(w=>w.id===task.weekId);
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TASK_TEMPLATE_ID, {
    to_name: user.name,
    to_email: user.email,
    task_name: task.name,
    task_description: task.description || '(no description)',
    task_deadline: task.deadline ? formatDate(task.deadline) : 'No deadline set',
    task_priority: task.priority,
    week_title: week ? week.title : '—',
    app_link: window.location.href.split('?')[0],
  }).then(
    ()=> console.log('Task-assignment email sent to', user.email),
    (err)=> console.error('Task-assignment email failed:', err)
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
  populateTimezoneSelect(document.getElementById('regTimezone'));
}

/* =========================================================
   NAVIGATION
   ========================================================= */
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
  const todayIso = new Date().toISOString().slice(0,10);
  const overdue = STATE.tasks.filter(t=>t.status!=='Finished' && t.deadline && t.deadline < todayIso).length;
  return {total, completed, inProgress, pending, pct, overdue};
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

/* Auto-marks a roadmap week as 'done' once every task tied to it is
   Finished (and there's at least one task). Only auto-promotes 'current'
   or 'upcoming' weeks that reach 100% — never overrides a week the leader
   hasn't started yet with zero tasks, and never un-does a manual leader
   choice by demoting it back down (that still requires the leader). */
function autoUpdateWeekCompletion(weekId){
  const week = STATE.roadmap.find(w=>w.id===weekId);
  if(!week) return false;
  const weekTasks = STATE.tasks.filter(t=>t.weekId===weekId);
  if(weekTasks.length===0) return false;
  const allDone = weekTasks.every(t=>t.status==='Finished');
  if(allDone && week.status!=='done'){
    week.status = 'done';
    return true;
  }
  return false;
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
  const myOverdue = STATE.tasks.filter(t=>t.assignee===user.id && t.status!=='Finished' && t.deadline && t.deadline < new Date().toISOString().slice(0,10)).length;
  document.getElementById('dashSub').textContent = myOverdue>0
    ? `⚠️ You have ${myOverdue} overdue task${myOverdue!==1?'s':''} — check your Tasks tab!`
    : 'Ready to move our X-Culture project forward?';

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

  const myTz = user.timezone || detectTimezone();
  document.getElementById('meetHeroDay').textContent = `${win.day} — ${win.time}`;
  document.getElementById('meetHeroSub').innerHTML = (win.isTie
    ? '⚖️ It\'s a tie! Keeping the default until the team resolves it.'
    : win.isDefault ? 'Default time · no votes cast yet this week' : '🏆 Selected by team vote')
    + ` <span style="opacity:.7;">(your timezone: ${myTz.replace(/_/g,' ')} · ${tzAbbrev(myTz)})</span>`;

  renderTimezoneTable(win, myTz);

  // Day picker
  const votes = getVotesForWeek(wi);
  const myVote = votes.find(v=>v.userId===user.id);
  const dayPicker = document.getElementById('dayPicker');
  dayPicker.innerHTML = DAYS.map(d=>`<button type="button" class="day-chip ${myVote && myVote.day===d ? 'selected':''}" data-day="${d}">${d.slice(0,3)}</button>`).join('');
  dayPicker.querySelectorAll('.day-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      dayPicker.querySelectorAll('.day-chip').forEach(c=>c.classList.remove('selected'));
      chip.classList.add('selected');
      updateVotePreviewTable();
    });
  });
  if(myVote){ document.getElementById('timePicker').value = myVote.time; }
  const timePickerEl = document.getElementById('timePicker');
  if(timePickerEl && !timePickerEl.dataset.tzBound){
    timePickerEl.addEventListener('change', updateVotePreviewTable);
    timePickerEl.dataset.tzBound = '1';
  }
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

/* Shows the voted meeting time converted into every team member's own
   timezone, so everyone can immediately see how the chosen slot lands for
   them (and flag if it's an awkward hour). */
function renderTimezoneTable(win, myTz){
  const el = document.getElementById('timezoneTable');
  if(!el) return;
  if(STATE.users.length===0){
    el.innerHTML = `<div class="empty-state"><p>No team members yet.</p></div>`;
    return;
  }
  el.innerHTML = STATE.users.map(u=>{
    const tz = u.timezone || 'UTC';
    const converted = convertMeetingTime(win.day, win.time, myTz, tz);
    const {h} = parseTimeTo24h(converted.time);
    const isAwkward = (h < 7 || h >= 22); // flag very early / very late local hours
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-bottom:1px solid var(--cream-2);">
        <div>
          <div style="font-weight:800; font-size:13px;">${escapeHtml(u.name)} ${u.role==='leader'?'👑':''}</div>
          <div style="font-size:11px; color:var(--plum-soft); font-weight:700;">${tz.replace(/_/g,' ')} (${tzAbbrev(tz)})</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:800; font-size:14px; ${isAwkward?'color:var(--red);':''}">${converted.day}, ${converted.time}</div>
          ${isAwkward ? `<div style="font-size:11px; color:var(--red); font-weight:800;">⚠️ Outside typical hours</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

/* Live-updates the timezone table using whatever day/time the user currently
   has selected in the vote form (before they even submit), so they can
   preview how a candidate time lands for everyone. */
function updateVotePreviewTable(){
  const user = getCurrentUser();
  const myTz = user.timezone || detectTimezone();
  const selectedDay = document.querySelector('#dayPicker .day-chip.selected');
  const time = document.getElementById('timePicker').value;
  if(!selectedDay) return;
  renderTimezoneTable({day:selectedDay.dataset.day, time}, myTz);
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
function weekStatusBadgeLabel(status){
  return { done:'✅ DONE', current:'🔵 CURRENT', upcoming:'⏳ UPCOMING' }[status] || status;
}

function renderRoadmap(){
  const user = getCurrentUser();
  const leader = isLeader(user);

  document.getElementById('roadmapList').innerHTML = STATE.roadmap.map((week, idx)=>{
    const pct = getWeekProgress(week.id);
    const weekTasks = STATE.tasks.filter(t=>t.weekId===week.id);
    const status = week.status || (idx===STATE.currentWeekIndex ? 'current' : 'upcoming');
    const isExpanded = expandedWeekId===week.id;

    return `
      <div class="week-card status-${status}">
        <div class="week-head" data-toggle-week="${week.id}" style="cursor:pointer;">
          <div>
            <span class="week-badge ${status==='current'?'current':''}">${week.title} · ${weekStatusBadgeLabel(status)}</span>
            <span style="font-size:12px; color:var(--plum-soft); font-weight:800; margin-left:8px;">${week.dateRange}</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; font-weight:800; color:var(--plum-soft);">Deadline: ${formatDate(week.deadline)}</span>
            <span style="font-size:16px;">${isExpanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <div style="font-weight:800; margin-bottom:6px;">🎯 ${escapeHtml(week.goal)}</div>
        <div class="week-progress-track"><div class="week-progress-fill" style="width:${pct}%"></div></div>
        <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:4px;">${pct}% of this week's tasks complete (${weekTasks.filter(t=>t.status==='Finished').length}/${weekTasks.length||0} tasks)</div>

        ${leader ? `
        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; align-items:center;">
          <span style="font-size:11px; font-weight:800; color:var(--plum-soft); align-self:center;">👑 Leader controls:</span>
          <button type="button" class="btn btn-sm ${status==='current'?'btn-lav':'btn-outline'}" data-set-week-status="${week.id}|current">Mark as Current</button>
          <button type="button" class="btn btn-sm ${status==='done'?'btn-green':'btn-outline'}" data-set-week-status="${week.id}|done">Mark as Done</button>
          <button type="button" class="btn btn-sm ${status==='upcoming'?'btn-lav':'btn-outline'}" data-set-week-status="${week.id}|upcoming">Mark as Upcoming</button>
        </div>` : `
        <div style="margin-top:10px; font-size:11px; color:var(--plum-soft); font-weight:700; opacity:.8;">
          🔒 Only the team leader can change a week's status. (You're signed in as: ${escapeHtml(user.name)}, role: ${user.role})
        </div>`}

        ${isExpanded ? `
        <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--cream-2);">
          <div style="font-weight:800; font-size:13px; margin-bottom:8px;">📋 Tasks in this week's roadmap</div>
          ${weekTasks.length ? weekTasks.map(t=>renderWeekTaskRow(t, user, leader)).join('') :
            `<ul class="week-tasks-list">${week.tasks.map(t=>`<li>· ${escapeHtml(t)}</li>`).join('')}</ul>
             <div style="font-size:12px; color:var(--plum-soft); font-weight:700; margin-top:6px;">No tracked tasks yet — these are the planned topics. ${leader?'Create tasks in the Tasks tab and assign them to this week.':''}</div>`}
        </div>` : ''}
      </div>
    `;
  }).join('');

  document.querySelectorAll('[data-toggle-week]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.toggleWeek;
      expandedWeekId = (expandedWeekId===id) ? null : id;
      renderRoadmap();
    });
  });

  document.querySelectorAll('[data-set-week-status]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      e.stopPropagation();
      console.log('[Roadmap] Mark-status button clicked:', btn.dataset.setWeekStatus, 'currentUser role:', getCurrentUser() && getCurrentUser().role);
      if(!isLeader()){ showToast('Only the team leader can change a week\'s status 👑'); return; }
      const [weekId, newStatus] = btn.dataset.setWeekStatus.split('|');
      const week = STATE.roadmap.find(w=>w.id===weekId);
      if(!week){ console.error('[Roadmap] Could not find week with id', weekId); return; }
      week.status = newStatus;
      if(newStatus==='current'){
        const idx = STATE.roadmap.findIndex(w=>w.id===weekId);
        STATE.currentWeekIndex = idx;
        ensureWeekChecklist(idx);
      }
      saveState();
      showToast(`${week.title} marked as ${newStatus.toUpperCase()}`);
      renderAll();
    });
  });
}

/* A single task row shown inside an expanded roadmap week. Any team member
   can VIEW every task here; only the assignee can flip it to "Working on
   it" / "Done". The leader can still fully edit via the Tasks tab. */
function renderWeekTaskRow(t, user, leader){
  const assigneeUser = STATE.users.find(u=>u.id===t.assignee);
  const isMine = t.assignee===user.id;
  const canChangeStatus = isMine || leader;
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid var(--cream-2); flex-wrap:wrap;">
      <div>
        <div style="font-weight:800; font-size:13px;">${escapeHtml(t.name)}</div>
        <div style="font-size:11px; color:var(--plum-soft); font-weight:700;">👤 ${assigneeUser?escapeHtml(assigneeUser.name):'Unassigned'} ${t.deadline?`· 📅 ${formatDate(t.deadline)}`:''}</div>
      </div>
      ${canChangeStatus ? `
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm ${t.status==='Working on it'?'btn-lav':'btn-outline'}" data-week-task-working="${t.id}">🔵 Working on it</button>
          <button class="btn btn-sm ${t.status==='Finished'?'btn-green':'btn-outline'}" data-week-task-done="${t.id}">🟢 Done</button>
        </div>
      ` : `<span class="status-pill status-${t.status.replace(/\s+/g,'-')}">${statusEmoji(t.status)} ${t.status}</span>`}
    </div>
  `;
}

document.addEventListener('click', function(e){
  if(e.target.dataset && e.target.dataset.weekTaskWorking){
    const t = STATE.tasks.find(x=>x.id===e.target.dataset.weekTaskWorking);
    const user = getCurrentUser();
    if(!(t.assignee===user.id || isLeader(user))){ showToast('Only the assignee can update this task 🌸'); return; }
    t.status = 'Working on it';
    saveState();
    renderAll();
  }
  if(e.target.dataset && e.target.dataset.weekTaskDone){
    const t = STATE.tasks.find(x=>x.id===e.target.dataset.weekTaskDone);
    const user = getCurrentUser();
    if(!(t.assignee===user.id || isLeader(user))){ showToast('Only the assignee can update this task 🌸'); return; }
    const wasFinished = t.status==='Finished';
    t.status = 'Finished';
    saveState();
    if(!wasFinished){
      showToast('Nice work! ✨ Task completed!');
      checkProgressMilestoneToast();
      const weekBecameDone = autoUpdateWeekCompletion(t.weekId);
      saveState();
      if(weekBecameDone){
        const week = STATE.roadmap.find(w=>w.id===t.weekId);
        showToast(`🎉 ${week.title} is now 100% complete — auto-marked as DONE!`);
      }
    }
    renderAll();
  }
});

/* =========================================================
   RENDER: TASKS
   ========================================================= */
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
  const overdueEl = document.getElementById('taskOverdueCount');
  if(overdueEl) overdueEl.textContent = stats.overdue;

  renderTaskFilterBar();

  const user = getCurrentUser();
  const leader = isLeader(user);

  // Only the leader sees the "+ New Task" button — creation & assignment is leader-only.
  const newTaskBtn = document.getElementById('newTaskBtn');
  if(newTaskBtn) newTaskBtn.style.display = leader ? 'inline-flex' : 'none';

  let list = STATE.tasks;
  if(taskFilter==='mine') list = list.filter(t=>t.assignee===user.id);
  else if(taskFilter!=='all') list = list.filter(t=>t.status===taskFilter);

  document.getElementById('taskList').innerHTML = list.length ? list.map(t=>{
    const assigneeUser = STATE.users.find(u=>u.id===t.assignee);
    // Only the assignee themself (or the leader) may change a task's status.
    const canChangeStatus = leader || t.assignee===user.id;
    const week = STATE.roadmap.find(w=>w.id===t.weekId);
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
        ${t.deadline ? `<span style="${t.status!=='Finished' && t.deadline < new Date().toISOString().slice(0,10) ? 'color:var(--red); font-weight:900;' : ''}">📅 ${formatDate(t.deadline)}${t.status!=='Finished' && t.deadline < new Date().toISOString().slice(0,10) ? ' ⚠️ OVERDUE' : ''}</span>` : ''}
        <span>🗺️ ${week ? escapeHtml(week.title) : '—'}</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; flex-wrap:wrap; gap:8px;">
        ${canChangeStatus ? `
        <select class="status-select" data-task-status="${t.id}">
          <option value="Not Started" ${t.status==='Not Started'?'selected':''}>🟡 Not Started</option>
          <option value="Working on it" ${t.status==='Working on it'?'selected':''}>🔵 Working on it</option>
          <option value="Finished" ${t.status==='Finished'?'selected':''}>🟢 Finished</option>
        </select>` : `<span class="status-pill status-${t.status.replace(/\s+/g,'-')}">${statusEmoji(t.status)} ${t.status}</span>`}
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-outline" data-comment-task="${t.id}">💬 Comment</button>
          ${leader ? `<button class="btn btn-sm btn-outline" data-edit-task="${t.id}">✏️ Edit</button>` : ''}
        </div>
      </div>
      ${renderTaskComments(t.id)}
    </div>`;
  }).join('') : `<div class="empty-state"><div class="es-icon">🌷</div><p>No tasks here yet. ${leader?'Create one with the button above!':'Your leader will assign tasks here soon.'}</p></div>`;

  document.querySelectorAll('[data-task-status]').forEach(sel=>{
    sel.addEventListener('change', function(){
      const task = STATE.tasks.find(t=>t.id===sel.dataset.taskStatus);
      if(!(leader || task.assignee===user.id)){ showToast('Only the assignee can update this task 🌸'); renderTasksPage(); return; }
      const oldStatus = task.status;
      task.status = sel.value;
      saveState();
      if(oldStatus!=='Finished' && task.status==='Finished'){
        showToast('Nice work! ✨ Task completed!');
        checkProgressMilestoneToast();
        const weekBecameDone = autoUpdateWeekCompletion(task.weekId);
        saveState();
        if(weekBecameDone){
          const week = STATE.roadmap.find(w=>w.id===task.weekId);
          showToast(`🎉 ${week.title} is now 100% complete — auto-marked as DONE!`);
        }
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

/* Task modal — creating & fully editing tasks (including assignment and
   which roadmap week they belong to) is LEADER-ONLY. */
function openTaskModal(taskId){
  if(!isLeader()){ showToast('Only the team leader can create or edit tasks 👑'); return; }
  const modal = document.getElementById('taskModal');
  const assigneeSel = document.getElementById('taskAssignee');
  assigneeSel.innerHTML = `<option value="">Unassigned</option>` + STATE.users.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');

  const weekSel = document.getElementById('taskWeek');
  if(weekSel){
    weekSel.innerHTML = STATE.roadmap.map(w=>`<option value="${w.id}">${escapeHtml(w.title)} (${escapeHtml(w.dateRange)})</option>`).join('');
  }

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
    if(weekSel) weekSel.value = t.weekId || getCurrentWeek().id;
  } else {
    document.getElementById('taskModalTitle').textContent = 'New Task';
    document.getElementById('taskForm').reset();
    document.getElementById('taskId').value = '';
    if(weekSel) weekSel.value = getCurrentWeek().id;
  }
  modal.classList.add('show');
}
function closeModal(id){ document.getElementById(id).classList.remove('show'); }

document.getElementById('newTaskBtn').addEventListener('click', ()=> openTaskModal(null));

document.getElementById('taskForm').addEventListener('submit', function(e){
  e.preventDefault();
  if(!isLeader()){ showToast('Only the team leader can create or edit tasks 👑'); return; }
  const id = document.getElementById('taskId').value;
  const weekSel = document.getElementById('taskWeek');
  const data = {
    name: document.getElementById('taskName').value.trim(),
    description: document.getElementById('taskDesc').value.trim(),
    assignee: document.getElementById('taskAssignee').value || null,
    deadline: document.getElementById('taskDeadline').value,
    priority: document.getElementById('taskPriority').value,
    status: document.getElementById('taskStatus').value,
    weekId: weekSel ? weekSel.value : getCurrentWeek().id,
  };
  let taskForEmail = null;
  let previousAssignee = null;
  if(id){
    const t = STATE.tasks.find(t=>t.id===id);
    previousAssignee = t.assignee;
    const wasFinished = t.status==='Finished';
    Object.assign(t, data);
    if(!wasFinished && t.status==='Finished'){
      showToast('Nice work! ✨ Task completed!');
      checkProgressMilestoneToast();
      autoUpdateWeekCompletion(t.weekId);
    }
    taskForEmail = t;
  } else {
    data.id = 't_' + Date.now();
    STATE.tasks.push(data);
    showToast('Task created! 🌸');
    taskForEmail = data;
  }
  saveState();

  // Notify the assignee by email whenever a task is (re)assigned to them.
  if(taskForEmail.assignee && taskForEmail.assignee !== previousAssignee){
    const assignedUser = STATE.users.find(u=>u.id===taskForEmail.assignee);
    if(assignedUser){
      sendTaskAssignedEmail(assignedUser, taskForEmail);
      showToast(`📧 Notification email sent to ${assignedUser.name}`);
    }
  }

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
  const user = getCurrentUser();
  const leader = isLeader(user);

  document.getElementById('teamGrid').innerHTML = STATE.users.map(u=>{
    const stats = getMemberStats(u.id);
    const assignedActive = stats.assigned.filter(t=>t.status!=='Finished');
    const tz = u.timezone || 'UTC';
    // Leader can remove anyone except themselves (a leader must transfer or
    // there must always be at least one leader; simplest safe rule: can't
    // delete your own account from here).
    const canDelete = leader && u.id!==user.id;
    return `
      <div class="member-card">
        ${canDelete ? `<button class="btn btn-sm btn-danger-outline" style="position:absolute; top:12px; right:12px;" data-remove-member="${u.id}" title="Remove member">🗑️</button>` : ''}
        <div class="member-avatar">${initials(u.name)}</div>
        <div class="member-name">✨ ${escapeHtml(u.name)} ${u.role==='leader' ? '👑':''}</div>
        <div class="member-email">${escapeHtml(u.email)}</div>
        <div style="font-size:11px; color:var(--plum-soft); font-weight:800; margin-bottom:2px;">Member #${u.regNumber || '—'}</div>
        <div style="font-size:11px; color:var(--plum-soft); font-weight:700; margin-bottom:6px;">🌍 ${tz.replace(/_/g,' ')} (${tzAbbrev(tz)})</div>
        <div style="font-size:12px; color:var(--plum-soft); font-weight:800;">${stats.assigned.length} task${stats.assigned.length!==1?'s':''} · ${stats.completed} completed</div>
        <div class="member-stats">
          <div><div class="num">${assignedActive.length}</div>Active</div>
          <div><div class="num">${stats.completed}</div>Done</div>
          <div><div class="num">${stats.contribution}%</div>Contrib.</div>
        </div>
      </div>
    `;
  }).join('') || `<div class="empty-state"><div class="es-icon">👥</div><p>No team members registered yet. Share the link with your teammates!</p></div>`;

  document.querySelectorAll('[data-remove-member]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const memberId = btn.dataset.removeMember;
      const member = STATE.users.find(u=>u.id===memberId);
      if(!member) return;
      if(!confirm(`Remove ${member.name} completely? This deletes ALL their data (tasks assignment, votes, attendance, comments) permanently. This cannot be undone.`)) return;
      removeMemberCompletely(memberId);
      showToast(`${member.name} was removed from the team 🗑️`);
      renderAll();
    });
  });
}

/* Fully deletes a member and every trace of their data across the shared
   state: unassigns their tasks (so tasks aren't silently lost, just freed
   up), strips their meeting votes/attendance/comments, and removes them
   from the users list. LEADER-ONLY action. */
function removeMemberCompletely(userId){
  if(!isLeader()){ showToast('Only the team leader can remove members 👑'); return; }
  const target = STATE.users.find(u=>u.id===userId);
  if(!target || target.role==='leader') return; // safety: never remove the leader from here

  // Unassign (not delete) their tasks, so team task history stays intact.
  STATE.tasks.forEach(t=>{ if(t.assignee===userId) t.assignee=null; });

  // Strip their meeting votes.
  Object.keys(STATE.meetings.votes).forEach(wi=>{
    STATE.meetings.votes[wi] = (STATE.meetings.votes[wi]||[]).filter(v=>v.userId!==userId);
  });
  // Strip their attendance records.
  Object.keys(STATE.meetings.attendance).forEach(wi=>{
    if(STATE.meetings.attendance[wi]) delete STATE.meetings.attendance[wi][userId];
  });
  // Strip their comments.
  STATE.comments = STATE.comments.filter(c=>c.userId!==userId);
  // Strip their attendance from archived history too.
  STATE.history.forEach(h=>{ if(h.attendance) delete h.attendance[userId]; });

  // Finally remove the user record itself.
  STATE.users = STATE.users.filter(u=>u.id!==userId);

  saveState();
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

  populateTimezoneSelect(document.getElementById('profileTimezone'), user.timezone);
}

document.addEventListener('click', function(e){
  if(e.target.id==='saveProfileTimezoneBtn'){
    const user = getCurrentUser();
    const tz = document.getElementById('profileTimezone').value;
    user.timezone = tz;
    saveState();
    showToast('Timezone updated 🌍');
    renderAll();
  }
});

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
