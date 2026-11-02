'use strict';

const $ = (id) => document.getElementById(id);
const live = $('live'), stage = $('stage'), sel = $('selection'), hint = $('hint'), camEl = $('cam');
const views = { setup: $('viewSetup'), stage: $('viewStage'), result: $('viewResult') };

/* ---------- Settings (remembered between sessions) ---------- */
const SETTINGS_KEY = 'clipora.settings.v1';
const LEGACY_SETTINGS_KEY = 'screenRecorder.settings.v1';
const DEFAULTS = {
  system: true, mic: false, cam: false, countdown: true,
  quality: '8000000', fps: '30', format: 'mp4',
  camSize: 0.22, camU: 0.86, camV: 0.8
};
const ALLOWED = { quality: ['4000000', '8000000', '16000000'], fps: ['30', '60'], format: ['mp4', 'webm'] };

function loadSettings() {
  try {
    // One-time migration from the pre-rename brand (preserves saved preferences).
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy !== null && localStorage.getItem(SETTINGS_KEY) === null) {
      localStorage.setItem(SETTINGS_KEY, legacy);
      localStorage.removeItem(LEGACY_SETTINGS_KEY);
    }
  } catch { /* storage unavailable */ }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { /* storage unavailable */ }
  const s = { ...DEFAULTS, ...saved };
  for (const k of Object.keys(ALLOWED)) if (!ALLOWED[k].includes(String(s[k]))) s[k] = DEFAULTS[k];
  for (const k of ['system', 'mic', 'cam', 'countdown']) s[k] = !!s[k];
  s.camSize = clamp(Number(s.camSize) || DEFAULTS.camSize, 0.1, 0.4);
  s.camU = clamp(Number(s.camU) || DEFAULTS.camU, 0, 1);
  s.camV = clamp(Number(s.camV) || DEFAULTS.camV, 0, 1);
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

const settings = loadSettings();
const FPS = () => Number(settings.fps) || 30;
const BITRATE = () => Number(settings.quality) || 8_000_000;

/* ---------- Formats ---------- */
const MP4_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4'
];
const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

// The chosen format first; the other as a fallback for older Chrome versions.
function pickMime(pref) {
  const list = pref === 'webm' ? [...WEBM_TYPES, ...MP4_TYPES] : [...MP4_TYPES, ...WEBM_TYPES];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}
function pickMimeFor(ext) {
  const list = ext === 'mp4' ? [...MP4_TYPES, ...WEBM_TYPES] : [...WEBM_TYPES, ...MP4_TYPES];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/* ---------- State ---------- */
let state = 'setup';           // setup | ready | countdown | recording | paused | result
let mode = 'full';             // full | region
let displayStream = null, micStream = null, camStream = null, outStream = null, audioCtx = null;
let recorder = null, mimeType = '', parts = [];
let worker = null, crop = null, drag = null, camDrag = null;
let elapsed = 0, runningSince = 0, tickId = 0, cdTimer = 0;
let outUrl = '', outBlob = null, outExt = 'mp4';
let origResult = null;         // untouched recording, kept while the user trims
let session = null;            // crash-recovery record for the current recording
let writeQ = Promise.resolve(), storeOK = true;
let trimBusy = false, trimAbort = false, previewEnd = null;

/* ---------- UI helpers ---------- */
const STATUS = {
  setup: ['Ready', ''], ready: ['Ready', 'ready'], countdown: ['Get ready', 'ready'],
  recording: ['Recording', 'rec'], paused: ['Paused', 'paused'], result: ['Done', 'done']
};

function setView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

function setState(s) {
  state = s;
  const [text, cls] = STATUS[s];
  $('statusText').textContent = text;
  $('status').className = 'status ' + cls;
  $('btnPlay').disabled = !(s === 'ready' || s === 'paused');
  $('btnPause').disabled = s !== 'recording';
  $('btnStop').disabled = !(s === 'recording' || s === 'paused');
  $('lblPlay').textContent = s === 'paused' ? 'Resume' : 'Record';
  $('btnCancel').classList.toggle('hidden', !(s === 'ready' || s === 'countdown'));
  $('btnCancel').textContent = s === 'countdown' ? 'Cancel countdown' : 'Choose a different source';
  stage.classList.toggle('selectable', mode === 'region' && s === 'ready');
  sel.classList.toggle('locked', s === 'recording' || s === 'paused' || s === 'countdown');
  updateHint();
  if (s !== 'recording' && s !== 'paused' && s !== 'countdown') document.title = 'Clipora';
}

function updateHint() {
  hint.classList.toggle('hidden', !(mode === 'region' && state === 'ready' && !crop));
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s % 60);
}
function fmtSec(sec) { return fmt(sec * 1000) + '.' + Math.floor((sec % 1) * 10); }
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/* ---------- Timer ---------- */
function currentMs() { return elapsed + (state === 'recording' ? performance.now() - runningSince : 0); }
function updateTimer() {
  const t = fmt(currentMs());
  $('timer').textContent = t;
  if (state === 'recording') document.title = '● ' + t + ' Recording';
  else if (state === 'paused') document.title = '❚❚ ' + t + ' Paused';
}
function startTick() { stopTick(); tickId = setInterval(updateTimer, 250); updateTimer(); }
function stopTick() { clearInterval(tickId); }

/* ---------- Crash-safe storage (IndexedDB) ----------
 * Every second of video is written to IndexedDB while recording. If Chrome or
 * the computer crashes, the next launch offers to recover it.
 */
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('screen-recorder', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('sessions', { keyPath: 'id' });
        r.result.createObjectStore('chunks', { keyPath: ['sid', 'seq'] });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
function dbTx(stores, mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
const dbPut = (store, value) => dbTx([store], 'readwrite', (t) => t.objectStore(store).put(value));
const chunkRange = (sid) => IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
const dbChunks = (sid) => dbTx(['chunks'], 'readonly', (t) => t.objectStore('chunks').getAll(chunkRange(sid)));
const dbChunkCount = (sid) => dbTx(['chunks'], 'readonly', (t) => t.objectStore('chunks').count(chunkRange(sid)));
const dbSessions = () => dbTx(['sessions'], 'readonly', (t) => t.objectStore('sessions').getAll());
function dbDeleteSession(sid) {
  return dbTx(['sessions', 'chunks'], 'readwrite', (t) => {
    t.objectStore('chunks').delete(chunkRange(sid));
    return t.objectStore('sessions').delete(sid);
  });
}
async function dbClearAll() {
  for (const s of await dbSessions()) await dbDeleteSession(s.id);
}

async function checkRecovery() {
  const box = $('recover');
  box.classList.add('hidden');
  try {
    const all = (await dbSessions()).filter((s) => !s.saved).sort((a, b) => b.startedAt - a.startedAt);
    for (const s of all.slice(1)) await dbDeleteSession(s.id);       // keep only the newest
    const s = all[0];
    if (!s) return;
    if (!(await dbChunkCount(s.id))) { await dbDeleteSession(s.id); return; }
    $('recoverTitle').textContent = s.complete ? 'You have an unsaved recording' : 'A recording was interrupted';
    $('recoverInfo').textContent = new Date(s.startedAt).toLocaleString() + ' • ' + fmt(s.durationMs || 0) +
      ' • starting a new recording discards it';
    box.dataset.sid = s.id;
    box.classList.remove('hidden');
  } catch { /* storage unavailable: no recovery offered */ }
}

async function recoverSession() {
  const sid = $('recover').dataset.sid;
  try {
    const s = (await dbSessions()).find((x) => x.id === sid);
    const rows = await dbChunks(sid);
    if (!s || !rows.length) { toast('Nothing to recover.'); return checkRecovery(); }
    const type = (s.mime || 'video/webm').split(';')[0];
    let blob = new Blob(rows.map((r) => r.blob), { type });
    blob = await fixWebmDuration(blob, s.durationMs);
    session = s;
    showResult(blob, type.includes('mp4') ? 'mp4' : 'webm', s.durationMs || 0, { recovered: true });
  } catch (err) {
    toast('Could not recover the recording: ' + err.message);
  }
}

async function discardRecovery() {
  try { await dbDeleteSession($('recover').dataset.sid); } catch { /* ignore */ }
  $('recover').classList.add('hidden');
  toast('Discarded.');
}

/* ---------- Audio meters ---------- */
let meterCtx = null, meterTimer = 0, meters = [];

function setupMeters() {
  teardownMeters();
  $('meters').classList.toggle('hidden', !settings.system && !settings.mic);
  const build = (rowId, stream, wanted, warning) => {
    const row = $(rowId), fill = row.querySelector('.mfill'), note = row.querySelector('.mnote');
    row.classList.toggle('hidden', !wanted);
    if (!wanted) return;
    const tracks = stream ? stream.getAudioTracks() : [];
    row.classList.toggle('warn', !tracks.length);
    note.textContent = tracks.length ? '' : warning;
    fill.style.transform = 'scaleX(0)';
    if (!tracks.length) return;
    if (!meterCtx) meterCtx = new AudioContext();
    meterCtx.resume().catch(() => {});
    const an = meterCtx.createAnalyser();
    an.fftSize = 1024;
    meterCtx.createMediaStreamSource(new MediaStream(tracks)).connect(an);
    meters.push({ an, fill, buf: new Uint8Array(an.fftSize), level: 0 });
  };
  build('mSys', displayStream, settings.system, 'No audio was shared. Tick “Share audio” in Chrome’s picker (not offered for every source).');
  build('mMic', micStream, settings.mic, 'Microphone unavailable.');
  if (!meters.length) return;
  meterTimer = setInterval(() => {
    for (const m of meters) {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) { const x = (m.buf[i] - 128) / 128; sum += x * x; }
      const db = 20 * Math.log10(Math.sqrt(sum / m.buf.length) || 1e-5);
      m.level = Math.max(clamp((db + 60) / 60, 0, 1), m.level * 0.85);
      m.fill.style.transform = 'scaleX(' + m.level.toFixed(3) + ')';
    }
  }, 80);
}

function teardownMeters() {
  clearInterval(meterTimer);
  meterTimer = 0;
  meters = [];
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
}

/* ---------- Capture ---------- */
async function pickSource(m) {
  mode = m;
  crop = null;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: FPS() } },
      audio: settings.system
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Could not start capture: ' + err.message);
    return;
  }
  if (settings.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Microphone unavailable. Recording without it.');
    }
  }
  if (settings.cam) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false
      });
      camEl.srcObject = camStream;
      await camEl.play().catch(() => {});
    } catch {
      camStream = null;
      toast('Camera unavailable. Recording without it.');
    }
  }
  live.srcObject = displayStream;
  await live.play().catch(() => {});
  displayStream.getVideoTracks()[0].addEventListener('ended', onSourceEnded, { once: true });
  elapsed = 0;
  $('timer').textContent = '00:00';
  $('camOpts').classList.toggle('hidden', !camStream);
  $('camSize').value = Math.round(settings.camSize * 100);
  setView('stage');
  setState('ready');
  setupMeters();
  drawSelection();
}

function onSourceEnded() {
  // User clicked Chrome's "Stop sharing" bar.
  if (state === 'recording' || state === 'paused') stop();
  else if (state === 'countdown') { cancelCountdown(); resetToSetup(); }
  else if (state === 'ready') resetToSetup();
}

/* The recorded output: the raw screen track, or a canvas when we need to crop and/or add the camera. */
function drawCam(ctx, W, H) {
  if (!camStream || !camEl.videoWidth) return;
  const d = Math.round(settings.camSize * Math.min(W, H));
  const cx = clamp(settings.camU * W, d / 2, W - d / 2), cy = clamp(settings.camV * H, d / 2, H - d / 2);
  const s = Math.max(d / camEl.videoWidth, d / camEl.videoHeight);
  const dw = camEl.videoWidth * s, dh = camEl.videoHeight * s;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(camEl, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();
  ctx.lineWidth = Math.max(2, d * 0.025);
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.stroke();
}

function buildOutputStream() {
  let videoTracks;
  const useCrop = mode === 'region' && crop;
  if (useCrop || camStream) {
    const vw0 = live.videoWidth || 1280, vh0 = live.videoHeight || 720;
    const W = even(useCrop ? crop.w : vw0), H = even(useCrop ? crop.h : vh0);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const c = useCrop ? { ...crop } : null;
    const draw = () => {
      const vw = live.videoWidth, vh = live.videoHeight;
      if (!vw) return;
      if (c) {
        ctx.drawImage(live, c.x, c.y, c.w, c.h, 0, 0, W, H);
      } else {
        // Keep the picture undistorted even if a shared window is resized mid-recording.
        const s = Math.min(W / vw, H / vh), dw = vw * s, dh = vh * s;
        if (dw < W || dh < H) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
        ctx.drawImage(live, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
      drawCam(ctx, W, H);
    };
    worker = new Worker('timer-worker.js');
    worker.onmessage = draw;
    worker.postMessage({ interval: 1000 / FPS() });
    draw();
    videoTracks = canvas.captureStream(FPS()).getVideoTracks();
  } else {
    videoTracks = displayStream.getVideoTracks();
  }

  const sources = [displayStream, micStream].filter((s) => s && s.getAudioTracks().length);
  let audioTracks = [];
  if (sources.length === 1) {
    audioTracks = sources[0].getAudioTracks();
  } else if (sources.length > 1) {
    audioCtx = new AudioContext();
    audioCtx.resume().catch(() => {});
    const dest = audioCtx.createMediaStreamDestination();
    sources.forEach((s) => audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest));
    audioTracks = dest.stream.getAudioTracks();
  }
  return new MediaStream([...videoTracks, ...audioTracks]);
}

/* ---------- Recording controls ---------- */
function start() {
  if (state === 'paused') return resume();
  if (state !== 'ready') return;
  if (mode === 'region' && !crop) { toast('Drag on the preview to select an area first.'); return; }
  startWithCountdown();
}

function startWithCountdown() {
  if (!settings.countdown) return beginRecording();
  const cd = $('countdown');
  let n = 3;
  setState('countdown');
  const show = () => {
    cd.textContent = n;
    cd.classList.remove('hidden', 'pop');
    void cd.offsetWidth;                      // restart the animation
    cd.classList.add('pop');
    document.title = 'Starting in ' + n + '…';
  };
  show();
  cdTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(cdTimer); cdTimer = 0;
      cd.classList.add('hidden');
      beginRecording();
    } else show();
  }, 1000);
}

function cancelCountdown() {
  if (!cdTimer) return;
  clearInterval(cdTimer); cdTimer = 0;
  $('countdown').classList.add('hidden');
  setState('ready');
}

async function beginRecording() {
  outStream = buildOutputStream();
  mimeType = pickMime(settings.format);
  try {
    recorder = new MediaRecorder(outStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: BITRATE(),
      audioBitsPerSecond: 128_000
    });
  } catch (err) {
    toast('Could not start recording: ' + err.message);
    if (worker) { worker.terminate(); worker = null; }
    setState('ready');
    return;
  }

  // Set up the crash-recovery record (best effort: recording works without it).
  parts = [];
  writeQ = Promise.resolve();
  storeOK = true;
  session = { id: crypto.randomUUID(), startedAt: Date.now(), mime: mimeType || 'video/webm', durationMs: 0, complete: false, saved: false };
  try { await dbClearAll(); await dbPut('sessions', session); } catch { storeOK = false; }

  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const i = parts.push(e.data) - 1;
    if (!storeOK) return;
    const sid = session.id, blob = e.data;
    writeQ = writeQ.then(async () => {
      await dbPut('chunks', { sid, seq: i, blob });
      parts[i] = null;                         // safely on disk: free the in-memory reference
      session.durationMs = Math.round(currentMs());
      await dbPut('sessions', session);
    }).catch(() => { storeOK = false; });
  };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  elapsed = 0;
  runningSince = performance.now();
  setState('recording');
  startTick();
}

function pause() {
  if (state !== 'recording') return;
  recorder.pause();
  elapsed += performance.now() - runningSince;
  stopTick();
  setState('paused');
  updateTimer();
}

function resume() {
  if (state !== 'paused') return;
  recorder.resume();
  runningSince = performance.now();
  setState('recording');
  startTick();
}

function stop() {
  if (state !== 'recording' && state !== 'paused') return;
  if (state === 'recording') elapsed += performance.now() - runningSince;
  stopTick();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function finishRecording() {
  await writeQ.catch(() => {});
  const type = (mimeType || 'video/webm').split(';')[0];
  const duration = elapsed;
  let list = parts.slice();
  if (list.some((b) => b === null)) {          // pull the stored pieces back from disk
    try { (await dbChunks(session.id)).forEach((r) => { list[r.seq] = r.blob; }); }
    catch { toast('Some of the recording could not be read back.'); }
  }
  list = list.filter(Boolean);
  parts = [];
  releaseCapture();

  if (session) {
    session.complete = true;
    session.durationMs = Math.round(duration);
    dbPut('sessions', session).catch(() => {});
  }
  let blob = new Blob(list, { type });
  blob = await fixWebmDuration(blob, duration);
  showResult(blob, type.includes('mp4') ? 'mp4' : 'webm', duration);
  if (!type.includes('mp4') && settings.format === 'mp4') {
    toast('This Chrome version cannot record MP4 directly, so the file is WebM. Update Chrome to 126+ for MP4.');
  }
}

function releaseCapture() {
  teardownMeters();
  cancelCountdown();
  [displayStream, micStream, camStream, outStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  displayStream = micStream = camStream = outStream = null;
  if (worker) { worker.terminate(); worker = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  live.srcObject = null;
  camEl.srcObject = null;
  camEl.classList.add('hidden');
  $('camOpts').classList.add('hidden');
  recorder = null;
  crop = null;
  drawSelection();
}

function resetToSetup() {
  releaseCapture();
  if (outUrl) { URL.revokeObjectURL(outUrl); outUrl = ''; }
  outBlob = null; origResult = null; session = null;
  $('result').removeAttribute('src');
  $('timer').textContent = '00:00';
  elapsed = 0;
  setView('setup');
  setState('setup');
  checkRecovery();
}

/* ---------- Result: preview, name, save ---------- */
const stamp = () => {
  const d = new Date();
  return `recording-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function showResult(blob, ext, ms, opts = {}) {
  if (outUrl) URL.revokeObjectURL(outUrl);
  outBlob = blob; outExt = ext;
  outUrl = URL.createObjectURL(blob);
  if (!opts.trimmed) origResult = { blob, ext, ms };
  $('result').src = outUrl;
  $('btnSave').textContent = 'Save as ' + ext.toUpperCase();
  $('fileExt').textContent = '.' + ext;
  if (!$('fileName').value || !(opts.trimmed || opts.restored)) $('fileName').value = stamp();
  $('meta').textContent = fmt(ms) + ' • ' + (blob.size / 1048576).toFixed(1) + ' MB • ' + ext.toUpperCase() +
    (opts.trimmed ? ' • trimmed' : '') + (opts.recovered ? ' • recovered' : '');
  $('btnTrimRestore').classList.toggle('hidden', !opts.trimmed);
  setupTrim(ms);
  setView('result');
  setState('result');
}

function cleanFileName() {
  let n = $('fileName').value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  n = n.replace(/\.(mp4|webm)$/i, '').replace(/[. ]+$/, '');
  return (n || stamp()) + '.' + outExt;
}

async function save() {
  if (!outBlob || trimBusy) return;
  const name = cleanFileName();
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: outExt.toUpperCase() + ' video', accept: { [outBlob.type]: ['.' + outExt] } }]
      });
      const w = await handle.createWritable();
      await w.write(outBlob);
      await w.close();
      toast('Saved ' + handle.name);
      markSaved(true);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;     // user closed the dialog
      /* anything else: fall back to a normal download */
    }
  }
  const a = document.createElement('a');
  a.href = outUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Saved ' + name + ' to your Downloads folder');
  markSaved(false);
}

// Once the file is safely saved, the recovery copy is no longer needed.
function markSaved(certain) {
  if (!session) return;
  const s = session;
  if (certain) { dbDeleteSession(s.id).catch(() => {}); session = null; }
  else { s.saved = true; dbPut('sessions', s).catch(() => {}); }
}

/* ---------- Trim ---------- */
const tStart = $('trimStart'), tEnd = $('trimEnd');
const MIN_KEEP = 0.5;

function setupTrim(ms) {
  const max = Math.max(MIN_KEEP, ms / 1000);
  [tStart, tEnd].forEach((r) => { r.min = 0; r.max = max.toFixed(2); r.step = 0.05; });
  tStart.value = 0; tEnd.value = max.toFixed(2);
  $('trim').open = false;
  updateTrimInfo();
}

function trimRange() { return [Number(tStart.value), Number(tEnd.value)]; }
function trimIsFull() { const [a, b] = trimRange(); return a <= 0.05 && b >= Number(tEnd.max) - 0.05; }

function updateTrimInfo() {
  const [a, b] = trimRange();
  $('trimInfo').textContent = `Keep ${fmtSec(a)} – ${fmtSec(b)}  (${(b - a).toFixed(1)} s)`;
  $('btnTrimApply').disabled = trimBusy || trimIsFull();
  $('btnTrimPreview').disabled = trimBusy;
}

tStart.addEventListener('input', () => {
  if (Number(tStart.value) > Number(tEnd.value) - MIN_KEEP) tStart.value = Math.max(0, Number(tEnd.value) - MIN_KEEP);
  $('result').currentTime = Number(tStart.value);
  updateTrimInfo();
});
tEnd.addEventListener('input', () => {
  if (Number(tEnd.value) < Number(tStart.value) + MIN_KEEP) tEnd.value = Number(tStart.value) + MIN_KEEP;
  $('result').currentTime = Math.max(0, Number(tEnd.value) - 0.3);
  updateTrimInfo();
});

$('btnTrimPreview').addEventListener('click', () => {
  const [a, b] = trimRange(), v = $('result');
  previewEnd = b;
  v.currentTime = a;
  v.play().catch(() => {});
});
$('result').addEventListener('timeupdate', () => {
  const v = $('result');
  if (previewEnd !== null && v.currentTime >= previewEnd) { v.pause(); previewEnd = null; }
});
$('result').addEventListener('pause', () => { previewEnd = null; });

function setTrimUI(busy) {
  trimBusy = busy;
  $('btnTrimCancel').classList.toggle('hidden', !busy);
  $('btnTrimPreview').classList.toggle('hidden', busy);
  $('btnTrimApply').classList.toggle('hidden', busy);
  $('btnTrimRestore').disabled = busy;
  $('btnSave').disabled = busy;
  $('btnNew').disabled = busy;
  tStart.disabled = tEnd.disabled = busy;
  if (!busy) $('trimInfo').textContent = '';
  updateTrimInfo();
}

const once = (el, ev) => new Promise((res, rej) => {
  el.addEventListener(ev, res, { once: true });
  el.addEventListener('error', () => rej(new Error('video could not be read')), { once: true });
});

async function applyTrim() {
  if (trimBusy || trimIsFull()) return;
  const [start, end] = trimRange();
  if (end - start < MIN_KEEP) { toast('Keep at least half a second.'); return; }
  $('result').pause();
  trimAbort = false;
  setTrimUI(true);
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  let ac = null, ok = false, blob = null;
  try {
    v.src = outUrl;
    await once(v, 'loadedmetadata');
    v.currentTime = start;
    await once(v, 'seeked');
    const cap = v.captureStream ? v.captureStream() : null;
    if (!cap) throw new Error('this Chrome cannot capture video elements');
    ac = new AudioContext();
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    ac.createMediaElementSource(v).connect(dest);   // audio goes to the recorder, not the speakers
    const stream = new MediaStream([...cap.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mt = pickMimeFor(outExt);
    const rec = new MediaRecorder(stream, { ...(mt ? { mimeType: mt } : {}), videoBitsPerSecond: BITRATE(), audioBitsPerSecond: 128_000 });
    const out = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) out.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);
    await v.play();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        const pct = Math.min(100, Math.round(((v.currentTime - start) / (end - start)) * 100));
        $('trimInfo').textContent = 'Trimming… ' + pct + '%';
        if (v.currentTime >= end - 0.03 || v.ended || trimAbort) { clearInterval(iv); resolve(); }
      }, 100);
    });
    v.pause();
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    if (trimAbort) { toast('Trim cancelled.'); return; }
    const type = (rec.mimeType || mt || outBlob.type).split(';')[0];
    const ms = Math.round((end - start) * 1000);
    blob = await fixWebmDuration(new Blob(out, { type }), ms);
    ok = true;
    showResult(blob, type.includes('mp4') ? 'mp4' : 'webm', ms, { trimmed: true });
    toast('Trimmed to ' + fmt(ms));
  } catch (err) {
    toast('Trim failed: ' + err.message);
  } finally {
    v.pause(); v.removeAttribute('src'); v.load();
    if (ac) ac.close().catch(() => {});
    setTrimUI(false);
    if (!ok && outBlob) $('result').src = outUrl;
  }
}

$('btnTrimApply').addEventListener('click', applyTrim);
$('btnTrimCancel').addEventListener('click', () => { trimAbort = true; });
$('btnTrimRestore').addEventListener('click', () => {
  if (!origResult || trimBusy) return;
  showResult(origResult.blob, origResult.ext, origResult.ms, { restored: true });
});

/* ---------- Region selection: draw, move, resize ---------- */
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
  const i = document.createElement('i');
  i.dataset.h = h;
  sel.appendChild(i);
});

function contentRect() {
  const cw = stage.clientWidth, ch = stage.clientHeight;
  const vw = live.videoWidth || 1, vh = live.videoHeight || 1;
  const s = Math.min(cw / vw, ch / vh);
  return { s, x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
}

// Where the recorded picture sits inside the preview (the whole source, or the selected area).
function outputRect() {
  const c = contentRect();
  if (mode === 'region') {
    if (!crop) return null;
    return { x: c.x + crop.x * c.s, y: c.y + crop.y * c.s, w: crop.w * c.s, h: crop.h * c.s };
  }
  return { x: c.x, y: c.y, w: c.w, h: c.h };
}

function drawSelection() {
  if (!crop) sel.classList.add('hidden');
  else {
    const c = contentRect();
    sel.style.left = c.x + crop.x * c.s + 'px';
    sel.style.top = c.y + crop.y * c.s + 'px';
    sel.style.width = crop.w * c.s + 'px';
    sel.style.height = crop.h * c.s + 'px';
    sel.dataset.size = `${even(crop.w)} × ${even(crop.h)}`;
    sel.classList.remove('hidden');
  }
  updateHint();
  layoutCam();
}

// Pointer position in source-video pixels.
function toSource(e) {
  const r = stage.getBoundingClientRect(), c = contentRect();
  const vw = live.videoWidth || 1, vh = live.videoHeight || 1;
  return {
    x: clamp(Math.round((e.clientX - r.left - c.x) / c.s), 0, vw),
    y: clamp(Math.round((e.clientY - r.top - c.y) / c.s), 0, vh)
  };
}

const MIN_CROP = 32;

stage.addEventListener('pointerdown', (e) => {
  if (mode !== 'region' || state !== 'ready' || e.target === camEl) return;
  const p = toSource(e), h = e.target.dataset ? e.target.dataset.h : '';
  if (crop && h) drag = { type: 'resize', h, orig: { ...crop } };
  else if (crop && e.target === sel) drag = { type: 'move', orig: { ...crop }, p0: p };
  else drag = { type: 'new', p0: p };
  stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});

stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = toSource(e), vw = live.videoWidth, vh = live.videoHeight;
  if (drag.type === 'new') {
    const x = Math.min(drag.p0.x, p.x), y = Math.min(drag.p0.y, p.y);
    crop = { x: clamp(x, 0, vw - 2), y: clamp(y, 0, vh - 2), w: Math.abs(p.x - drag.p0.x), h: Math.abs(p.y - drag.p0.y) };
    crop.w = Math.min(crop.w, vw - crop.x); crop.h = Math.min(crop.h, vh - crop.y);
  } else if (drag.type === 'move') {
    const o = drag.orig;
    crop = { ...o, x: clamp(o.x + p.x - drag.p0.x, 0, vw - o.w), y: clamp(o.y + p.y - drag.p0.y, 0, vh - o.h) };
  } else {
    const o = drag.orig;
    let l = o.x, r = o.x + o.w, t = o.y, b = o.y + o.h;
    if (drag.h.includes('w')) l = p.x;
    if (drag.h.includes('e')) r = p.x;
    if (drag.h.includes('n')) t = p.y;
    if (drag.h.includes('s')) b = p.y;
    if (r - l < MIN_CROP) { if (drag.h.includes('w')) l = r - MIN_CROP; else r = l + MIN_CROP; }
    if (b - t < MIN_CROP) { if (drag.h.includes('n')) t = b - MIN_CROP; else b = t + MIN_CROP; }
    l = clamp(l, 0, vw - MIN_CROP); t = clamp(t, 0, vh - MIN_CROP);
    r = clamp(r, l + MIN_CROP, vw); b = clamp(b, t + MIN_CROP, vh);
    crop = { x: l, y: t, w: r - l, h: b - t };
  }
  drawSelection();
});

function endDrag() {
  if (!drag) return;
  drag = null;
  if (crop && (crop.w < MIN_CROP || crop.h < MIN_CROP)) { crop = null; drawSelection(); }
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', drawSelection);

/* ---------- Webcam bubble: preview, drag, size ---------- */
function layoutCam() {
  const r = camStream ? outputRect() : null;
  if (!r || r.w < 4) { camEl.classList.add('hidden'); return; }
  const d = settings.camSize * Math.min(r.w, r.h);
  const cx = clamp(settings.camU * r.w, d / 2, r.w - d / 2), cy = clamp(settings.camV * r.h, d / 2, r.h - d / 2);
  camEl.style.width = camEl.style.height = d + 'px';
  camEl.style.left = r.x + cx - d / 2 + 'px';
  camEl.style.top = r.y + cy - d / 2 + 'px';
  camEl.classList.remove('hidden');
}

camEl.addEventListener('pointerdown', (e) => {
  if (!camStream) return;
  camDrag = true;
  camEl.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
});
camEl.addEventListener('pointermove', (e) => {
  if (!camDrag) return;
  const r = outputRect(), sr = stage.getBoundingClientRect();
  if (!r) return;
  settings.camU = clamp((e.clientX - sr.left - r.x) / r.w, 0, 1);
  settings.camV = clamp((e.clientY - sr.top - r.y) / r.h, 0, 1);
  layoutCam();
});
const endCamDrag = () => { if (camDrag) { camDrag = false; saveSettings(); } };
camEl.addEventListener('pointerup', endCamDrag);
camEl.addEventListener('pointercancel', endCamDrag);

$('camSize').addEventListener('input', (e) => {
  settings.camSize = clamp(Number(e.target.value) / 100, 0.1, 0.4);
  saveSettings();
  layoutCam();
});

/* ---------- Keyboard shortcuts ---------- */
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target, tag = (t.tagName || '').toLowerCase();
  if (tag === 'select' || tag === 'textarea' || (tag === 'input' && t.type === 'text') || t.isContentEditable) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  const key = e.key.toLowerCase();

  if (e.code === 'Space') {
    if (state === 'recording' || state === 'paused' || state === 'ready') {
      e.preventDefault();
      if (e.repeat) return;
      if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
      if (state === 'recording') pause(); else start();
    }
    return;                                                  // in other states Space keeps its normal job
  }
  if (e.key === 'Escape') {
    if (trimBusy) trimAbort = true;
    else if (state === 'countdown' && cdTimer) cancelCountdown();
    else if (state === 'ready') resetToSetup();
    return;
  }
  if (key === 's' && state === 'result' && !trimBusy) { e.preventDefault(); save(); }
  else if (key === 'n' && (state === 'result' || state === 'ready') && !trimBusy) { e.preventDefault(); resetToSetup(); }
});

/* ---------- Settings UI ---------- */
function bindSetting(id, key, isCheck) {
  const el = $(id);
  if (isCheck) el.checked = settings[key]; else el.value = String(settings[key]);
  el.addEventListener('change', () => {
    settings[key] = isCheck ? el.checked : el.value;
    saveSettings();
  });
}
bindSetting('optSystem', 'system', true);
bindSetting('optMic', 'mic', true);
bindSetting('optCam', 'cam', true);
bindSetting('optCountdown', 'countdown', true);
bindSetting('optQuality', 'quality', false);
bindSetting('optFps', 'fps', false);
bindSetting('optFormat', 'format', false);

/* ---------- Wiring ---------- */
$('btnFull').addEventListener('click', () => pickSource('full'));
$('btnRegion').addEventListener('click', () => pickSource('region'));
$('btnPlay').addEventListener('click', start);
$('btnPause').addEventListener('click', pause);
$('btnStop').addEventListener('click', stop);
$('btnCancel').addEventListener('click', () => { if (state === 'countdown') cancelCountdown(); else resetToSetup(); });
$('btnSave').addEventListener('click', save);
$('btnNew').addEventListener('click', resetToSetup);
$('btnRecover').addEventListener('click', recoverSession);
$('btnDiscard').addEventListener('click', discardRecovery);

window.addEventListener('beforeunload', (e) => {
  if (state === 'recording' || state === 'paused' || state === 'countdown' || trimBusy) { e.preventDefault(); e.returnValue = ''; }
});

setState('setup');
checkRecovery();
