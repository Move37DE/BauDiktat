/**
 * BauDiktat Classic – app.js
 * Reine Audio-Aufnahme mit Foto-Integration, ohne Spracherkennung.
 * Dictaphone-Workflow: Aufnehmen, Cue-Back zum Nachhoeren, Weiter-Aufnehmen.
 */
(function() {
'use strict';

const VERSION = '0.3.0-classic';
const BACKEND = window.location.origin;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  isRec:           false,
  isPaused:        false,
  // Audio
  mediaRecorder:   null,
  audioChunks:     [],          // Chunks des aktuellen Segments
  allChunks:       [],          // Alle Chunks aller Segmente (fuer finalize)
  segmentChunks:   {},          // { [segNum]: [Blob, ...] } pro Segment
  mimeType:        'audio/webm',
  // Timing
  sessionStart:    null,
  segmentStart:    null,
  elapsed:         0,
  timerInterval:   null,
  // Segments & Photos
  segCount:        0,
  photoCount:      0,
  currentSegId:    null,
  sessionId:       crypto.randomUUID(),
  markers:         [],
  photos:          [],
  blocks:          [],          // [{type:'text',text:''}, {type:'photo',photo:'img_001.jpg', timestamp}]
  pendingPhoto:    null,
  stream:          null,
  cameraStream:    null,
  projectName:     'Baustelle',
  projectNameCustom: '',
  projectNameStamp: '',
  lastSessionId:   null,
  mailAvailable:   false,
  // Cue-Back
  cueAudio:        null,
  listeningSegId:  null,        // aktiv abgespieltes Segment (fuer UI)
  listenAudio:     null,
};

// ── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.update()));
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  updateClock();
  setInterval(updateClock, 10000);
  updateProjectNameDisplay();

  // Mail-Status
  try {
    const mailResp = await fetch(`${BACKEND}/api/mail-status`, { cache: 'no-store' });
    const mailStatus = await mailResp.json();
    state.mailAvailable = mailStatus.available;
  } catch (e) {}

  const savedEmail = localStorage.getItem('baudiktat-email');
  if (savedEmail) {
    const emailInput = $('email-to');
    if (emailInput) emailInput.value = savedEmail;
  }
});

// ── Mikrofon ────────────────────────────────────────────────────────────────
async function getMicStream() {
  if (state.stream) return state.stream;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
    });
    return state.stream;
  } catch (err) {
    showError('Mikrofon-Zugriff verweigert. Bitte Berechtigung erteilen.');
    throw err;
  }
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// ── Recording ───────────────────────────────────────────────────────────────
async function startRec() {
  const stream = await getMicStream();
  state.isRec = true;
  state.isPaused = false;
  state.sessionStart = state.sessionStart || Date.now();
  state.segmentStart = Date.now();
  state.segCount++;

  if (state.segCount === 1 && !state.projectNameStamp) {
    state.projectNameStamp = getDateTimeStamp();
    updateProjectNameDisplay();
  }

  const korrekturBtn = $('btn-korrektur');
  if (korrekturBtn) korrekturBtn.style.display = 'none';

  state.currentSegId = `seg-${state.segCount}`;
  state.audioChunks = [];
  state.segmentChunks[state.segCount] = state.audioChunks;

  state.mimeType = pickMimeType() || 'audio/webm';
  state.mediaRecorder = new MediaRecorder(stream, state.mimeType ? { mimeType: state.mimeType } : undefined);
  state.mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) {
      state.audioChunks.push(e.data);
      state.allChunks.push(e.data);
    }
  };
  state.mediaRecorder.start(250);

  state.timerInterval = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
    updateTimerDisplay();
  }, 500);

  createSegCard(state.segCount);
  updateRecUI('rec');
  updateMeta();
}

async function pauseRec() {
  if (!state.isRec) return;
  state.isRec = false;
  state.isPaused = true;
  clearInterval(state.timerInterval);
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.pause();
  }
  updateRecUI('paused');
  updateSegCardState();
}

async function finalizeCurrentSegment() {
  if (!state.isRec && !state.isPaused) return;
  state.isRec = false;
  state.isPaused = false;
  clearInterval(state.timerInterval);

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
    await delay(300);
  }

  finalizeSegCard(state.currentSegId);
  state.blocks.push({ type: 'text', text: '', segment: state.segCount });
}

function toggleRec() {
  if (state.isRec) return pauseRec();
  if (state.isPaused) return resumeRec();
  return startRec();
}

function newSegment() {
  if (!state.isRec && !state.isPaused) return;
  finalizeCurrentSegment().then(() => {
    updateRecUI('idle');
    updateMeta();
    startRec();
  });
}

// ── Cue-Back ────────────────────────────────────────────────────────────────
async function cueBack(seconds) {
  if (!state.isRec && !state.isPaused && state.audioChunks.length === 0) return;

  // MediaRecorder pausieren, User-Intent merken
  state._cueResumeTo = state.isPaused ? 'paused' : (state.isRec ? 'rec' : 'idle');
  if (state.isRec && state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.pause();
    clearInterval(state.timerInterval);
  }
  state.isRec = false;
  state.isPaused = false;

  // Alle Chunks des aktuellen Segments zusammenbauen
  const chunks = state.audioChunks.slice();
  if (chunks.length === 0) return;

  const blob = new Blob(chunks, { type: state.mimeType || 'audio/webm' });
  const url = URL.createObjectURL(blob);

  // Overlay anzeigen
  const overlay = $('cue-overlay');
  const sub = $('cue-sub');
  const wave = $('cue-wave');
  if (sub) sub.textContent = `Letzte ${seconds} Sekunden aus Segment ${state.segCount}…`;
  if (wave) wave.innerHTML = genCueWave();
  if (overlay) overlay.classList.add('active');

  // Audio laden
  const audio = new Audio(url);
  state.cueAudio = audio;
  audio.addEventListener('loadedmetadata', () => {
    const start = Math.max(0, (audio.duration || seconds) - seconds);
    try { audio.currentTime = start; } catch (e) {}
    audio.play().catch(() => {});
  });
  audio.addEventListener('ended', () => {
    if (sub) sub.textContent = 'Wiedergabe beendet. Weiter aufnehmen oder Stopp?';
  });
}

function cueBackStop() {
  if (state.cueAudio) {
    state.cueAudio.pause();
    state.cueAudio = null;
  }
  const overlay = $('cue-overlay');
  if (overlay) overlay.classList.remove('active');

  // MediaRecorder war pausiert — wir beenden die Aufnahme komplett
  if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
    state.mediaRecorder.stop();
  }
  state.isRec = false;
  state.isPaused = false;
  state._cueResumeTo = null;
  finalizeSegCard(state.currentSegId);
  state.blocks.push({ type: 'text', text: '', segment: state.segCount });
  updateRecUI('idle');
  updateMeta();
}

function cueBackResume() {
  if (state.cueAudio) {
    state.cueAudio.pause();
    state.cueAudio = null;
  }
  const overlay = $('cue-overlay');
  if (overlay) overlay.classList.remove('active');

  const target = state._cueResumeTo || 'rec';
  state._cueResumeTo = null;

  if (target === 'paused') {
    // Benutzer war im Pause-Zustand — dorthin zurückkehren, nicht resumen
    state.isRec = false;
    state.isPaused = true;
    updateRecUI('paused');
    updateSegCardState();
    return;
  }

  if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
    state.mediaRecorder.resume();
    state.isRec = true;
    state.isPaused = false;
    state.timerInterval = setInterval(() => {
      state.elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
      updateTimerDisplay();
    }, 500);
    updateRecUI('rec');
    updateSegCardState();
  } else {
    // Falls MediaRecorder schon gestoppt war → neue Aufnahme als selbes Segment fortsetzen
    startRec();
  }
}

// "Anhoeren" vom Hauptbildschirm aus → ruft cueBack mit "bis zum Anfang"
function listenLast() {
  // Wenn gerade eine Aufnahme laeuft, nehmen wir das aktuelle Segment komplett
  const segNum = state.segCount;
  const chunks = state.segmentChunks[segNum];
  if (!chunks || chunks.length === 0) return;

  // Stoppen, dann komplettes Segment abspielen (via cueBack mit grossem seconds-Wert)
  cueBack(999);
}

// ── Segment-Playback ────────────────────────────────────────────────────────
function playSegment(segId, btn) {
  const segNum = parseInt(segId.replace('seg-', ''), 10);
  const chunks = state.segmentChunks[segNum];
  if (!chunks || chunks.length === 0) return;

  // Laufende Wiedergabe stoppen
  if (state.listenAudio) {
    state.listenAudio.pause();
    state.listenAudio = null;
  }
  document.querySelectorAll('.seg-card.playing').forEach(c => {
    c.classList.remove('playing');
    const b = c.querySelector('.seg-action');
    if (b) b.textContent = '\u25B6 Abspielen';
  });

  const card = $(segId);
  const wasPlaying = card?.classList.contains('playing');
  if (wasPlaying) return;  // war aktive Karte → jetzt gestoppt

  if (card) card.classList.add('playing');
  if (btn) btn.textContent = '\u23F9 Stop';

  const blob = new Blob(chunks, { type: state.mimeType || 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  state.listenAudio = audio;
  audio.play().catch(() => {});
  audio.addEventListener('ended', () => {
    if (card) card.classList.remove('playing');
    if (btn) btn.textContent = '\u25B6 Abspielen';
    URL.revokeObjectURL(url);
    state.listenAudio = null;
  });
}

function deleteSegment(segId) {
  const card = $(segId);
  if (!card) return;
  const segNum = parseInt(segId.replace('seg-', ''), 10);
  card.style.cssText += 'opacity:0;transform:translateX(20px);transition:all 0.2s';
  setTimeout(() => {
    card.remove();
    // Segment-Chunks entfernen (aber allChunks lassen wir in Ruhe — zu komplex)
    delete state.segmentChunks[segNum];
    // Blocks dieses Segments entfernen
    state.blocks = state.blocks.filter(b => b.segment !== segNum);
    // Photos dieses Segments entfernen
    state.photos = state.photos.filter(p => p.segNum !== segNum);
    state.markers = state.markers.filter(m => m.segNum !== segNum);
    updateMeta();
  }, 200);
}

// ── Foto aufnehmen ──────────────────────────────────────────────────────────
async function openCamera() {
  if (state.segCount === 0) return;

  if (state.isRec && state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.pause();
    clearInterval(state.timerInterval);
  }

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      }
    });
    const video = $('camera-preview');
    if (video) {
      video.srcObject = state.cameraStream;
      await video.play();
    }
    showScreen('camera');
  } catch (err) {
    console.warn('[Camera]', err.message);
    showScreen('camera');
  }
}

async function capturePhoto() {
  const video = $('camera-preview');
  const canvas = document.createElement('canvas');

  if (video && video.srcObject) {
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 960;
    canvas.getContext('2d').drawImage(video, 0, 0);
  } else {
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a16'; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#e09a1a'; ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Foto ' + (state.photoCount + 1), 320, 220);
    ctx.fillStyle = '#555'; ctx.font = '16px sans-serif';
    ctx.fillText(new Date().toLocaleTimeString('de-DE'), 320, 260);
  }

  canvas.toBlob(blob => {
    state.photoCount++;
    const photoName = `img_${String(state.photoCount).padStart(3,'0')}.jpg`;
    const t = state.elapsed;
    const photo = {
      id: `photo-${state.photoCount}`,
      blob, name: photoName,
      url: URL.createObjectURL(blob),
      timestamp: t,
      segId: state.currentSegId,
      segNum: state.segCount,
      caption: '',
    };
    state.photos.push(photo);
    state.pendingPhoto = photo;
    state.markers.push({ t, photo: photoName, segNum: state.segCount });
    state.blocks.push({ type: 'photo', photo: photoName, timestamp: t, segment: state.segCount });

    state.cameraStream?.getTracks().forEach(tr => tr.stop());
    state.cameraStream = null;

    addPhotoThumbToSeg(state.currentSegId, state.photoCount, photo.url);
    showPhotoReview(photo);
    updateMeta();
  }, 'image/jpeg', 0.92);
}

function showPhotoReview(photo) {
  const img = $('photo-preview-img');
  if (img) { img.src = photo.url; img.style.display = 'block'; }
  const emoji = $('photo-preview-emoji');
  if (emoji) emoji.style.display = 'none';

  $('photo-title').textContent     = `Foto ${photo.timestamp ? formatTime(photo.timestamp) : ''}`;
  $('photo-time-sub').textContent  = `Aufgenommen bei ${formatTime(photo.timestamp)}`;
  $('photo-review-meta').textContent = `Segment ${state.segCount}`;

  showScreen('photo');
}

function keepPhoto() {
  state.pendingPhoto = null;
  const dp = $('dot-photo'); if (dp) dp.className = 'state-dot';
  const dpl = $('dot-photo-label'); if (dpl) dpl.textContent = 'Kein Foto ausstehend';
  showScreen('main');
  if (state.isRec) resumeRec();
}

function retakePhoto() {
  if (state.pendingPhoto) {
    state.photos.pop();
    state.markers.pop();
    state.blocks.pop();
    const thumb = $(`thumb-photo-${state.photoCount}`);
    if (thumb) { thumb.style.opacity = '0'; setTimeout(() => thumb.remove(), 200); }
    state.photoCount--;
    updateMeta();
  }
  showScreen('camera');
  openCamera();
}

function cancelCamera() {
  state.cameraStream?.getTracks().forEach(tr => tr.stop());
  state.cameraStream = null;
  showScreen('main');
  if (state.isRec) resumeRec();
}

function resumeRec() {
  if (!state.isRec && !state.isPaused) return;
  state.isRec = true;
  state.isPaused = false;
  if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
    state.mediaRecorder.resume();
  }
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
    updateTimerDisplay();
  }, 500);
  updateRecUI('rec');
  updateSegCardState();
}

// ── Session finalisieren & senden ───────────────────────────────────────────
async function finalizeSession() {
  // Offenes oder pausiertes Segment vor dem Senden sauber beenden
  if (state.isRec || state.isPaused) {
    await finalizeCurrentSegment();
    updateRecUI('idle');
    updateMeta();
  }

  showScreen('send');

  try {
    const audioBlob = new Blob(state.allChunks, { type: state.mimeType || 'audio/webm' });

    const formData = new FormData();
    formData.append('audio', audioBlob, 'session.webm');
    formData.append('session', JSON.stringify({
      mode: 'classic',
      projectName: state.projectName,
      markers: state.markers,
      sessionId: state.sessionId,
      orderedBlocks: state.blocks.map(b => {
        if (b.type === 'photo') return { type: 'photo', photo: b.photo, timestamp: b.timestamp };
        return { type: 'text', text: b.text || '' };
      }),
    }));

    state.photos.forEach(photo => {
      formData.append('photos', photo.blob, photo.name);
    });

    updateSendStep('ss1', 'active', '\u27F3');

    const resp = await fetch(`${BACKEND}/finalize`, { method: 'POST', body: formData });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();

    updateSendStep('ss1', 'done', '\u2713');
    await delay(300);
    updateSendStep('ss2', 'done', '\u2713');
    await delay(300);
    updateSendStep('ss3', 'done', '\u2713');
    await delay(300);
    updateSendStep('ss4', 'done', '\u2713');

    $('send-badge').textContent = 'FERTIG';
    $('send-meta').textContent = 'Am Korrekturplatz bereit';

    showDownloadLink(result.downloadUrl, result);

  } catch (err) {
    console.error('[Finalize]', err);
    showError('Senden fehlgeschlagen: ' + err.message);
  }
}

function showDownloadLink(url, result) {
  state.lastSessionId = result.sessionId;

  const preview = $('output-preview');
  if (!preview) return;
  preview.style.display = 'block';

  const body = $('output-body');
  if (body) {
    body.innerHTML = `
      <div style="color:var(--green);font-weight:500;margin-bottom:8px">
        \u2713 ${result.blockCount} Blöcke · ${result.photoCount} Fotos übertragen
      </div>
      <div style="color:var(--text3);font-size:10px;margin-bottom:8px;font-family:'DM Mono',monospace">
        Sekretariat kann jetzt am Korrekturplatz das Audio abhören und den Text tippen.
      </div>
      ${result.correctionUrl ? `
      <a href="${BACKEND}${result.correctionUrl}" target="_blank"
         style="display:flex;align-items:center;gap:8px;background:var(--bdim);
                border:1px solid rgba(74,143,212,0.35);border-radius:8px;
                padding:10px 14px;color:var(--blue);text-decoration:none;
                font-family:'DM Mono',monospace;font-size:11px;">
        🎧 Am Korrekturplatz öffnen
      </a>` : ''}
      <a href="${BACKEND}${url}"
         style="display:flex;align-items:center;gap:8px;background:var(--gdim);
                border:1px solid rgba(82,176,106,0.35);border-radius:8px;
                padding:10px 14px;color:var(--green);text-decoration:none;
                font-family:'DM Mono',monospace;font-size:11px;margin-top:6px;"
         download>
        ↓ DOCX-Gerüst herunterladen
      </a>
    `;
  }

  $('btn-email').style.display = 'flex';
  $('btn-done').style.display = 'flex';

  const today = new Date().toLocaleDateString('de-DE');
  const subjectInput = $('email-subject');
  if (subjectInput && !subjectInput.value) {
    subjectInput.value = `BauDiktat Classic – Diktat ${today}`;
  }
}

// ── UI Helpers ──────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${id}`)?.classList.add('active');
}

function updateRecUI(mode) {
  // Abwärtskompat: true → 'rec', false → 'idle'
  if (mode === true)  mode = 'rec';
  if (mode === false) mode = 'idle';

  const btn = $('btn-rec');
  if (!btn) return;
  const has = state.segCount > 0;

  if (mode === 'rec') {
    btn.className = 'btn btn-rec';
    btn.innerHTML = '\u23F8 Pause';
    $('btn-photo').disabled = false;
    $('btn-seg').disabled = false;
    $('btn-cue10').disabled = false;
    $('btn-cue5').disabled = false;
    $('btn-listen').disabled = false;
    $('btn-send').disabled = true;
    $('btn-send').className = 'btn btn-send';
    $('status-badge').className = 'header-badge rec';
    $('status-badge').innerHTML = '<span class="rdot"></span> REC';
    const dr = $('dot-rec'); if (dr) dr.className = 'state-dot on';
    $('seg-empty').style.display = 'none';
  } else if (mode === 'paused') {
    btn.className = 'btn btn-rec paused';
    btn.innerHTML = '\u23FA Weiter aufnehmen';
    $('btn-photo').disabled = false;
    $('btn-seg').disabled = false;
    $('btn-cue10').disabled = false;
    $('btn-cue5').disabled = false;
    $('btn-listen').disabled = false;
    $('btn-send').disabled = !has;
    $('btn-send').className = has ? 'btn btn-send ready' : 'btn btn-send';
    $('status-badge').className = 'header-badge';
    $('status-badge').textContent = 'PAUSE';
    const dr = $('dot-rec'); if (dr) dr.className = 'state-dot';
    const dry = $('dot-ready'); if (dry) dry.className = has ? 'state-dot ready' : 'state-dot';
  } else { // idle
    btn.className = 'btn btn-rec';
    btn.innerHTML = '\u23FA Aufnehmen';
    $('btn-photo').disabled = !has;
    $('btn-seg').disabled = true;
    $('btn-cue10').disabled = true;
    $('btn-cue5').disabled = true;
    $('btn-listen').disabled = !has;
    $('btn-send').disabled = !has;
    $('btn-send').className = has ? 'btn btn-send ready' : 'btn btn-send';
    $('status-badge').className = 'header-badge';
    $('status-badge').textContent = has ? 'BEREIT' : '';
    const dr = $('dot-rec'); if (dr) dr.className = 'state-dot';
    const dry = $('dot-ready'); if (dry) dry.className = has ? 'state-dot ready' : 'state-dot';
  }
}

function updateSegCardState() {
  const card = state.currentSegId && $(state.currentSegId);
  if (!card) return;
  card.classList.remove('recording-active', 'recording-paused');
  if (state.isRec) {
    card.classList.add('recording-active');
    card.setAttribute('data-toggle-hint', 'TAP = PAUSE');
  } else if (state.isPaused) {
    card.classList.add('recording-paused');
    card.setAttribute('data-toggle-hint', 'TAP = WEITER');
  } else {
    card.removeAttribute('data-toggle-hint');
  }
}

function updateTimerDisplay() {
  const badge = $('status-badge');
  if (badge && state.isRec) {
    badge.innerHTML = `<span class="rdot"></span> REC \u00B7 ${formatTime(state.elapsed)}`;
  }
  const dur = $(`${state.currentSegId}-dur`);
  if (dur && state.segmentStart) {
    dur.textContent = formatTime(Math.floor((Date.now() - state.segmentStart) / 1000));
  }
}

function updateMeta() {
  $('seg-count-meta').textContent = `${state.segCount} Segment${state.segCount!==1?'e':''}`;
  $('photo-count-meta').textContent = `${state.photoCount} Foto${state.photoCount!==1?'s':''}`;
  const isc = $('info-seg-count'); if (isc) isc.textContent = state.segCount;
  const ipt = $('info-photo-total'); if (ipt) ipt.textContent = state.photoCount;
}

function updateClock() {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  document.querySelectorAll('.clock').forEach(el => el.textContent = t);
}

function formatTime(s) {
  if (!s && s !== 0) return '--:--';
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function showError(msg) { alert(msg); }

// ── Segment DOM ─────────────────────────────────────────────────────────────
function createSegCard(num) {
  const list = $('seg-list');
  $('seg-empty').style.display = 'none';
  const card = document.createElement('div');
  card.className = 'seg-card recording-active fadein';
  card.id = `seg-${num}`;
  card.setAttribute('data-toggle-hint', 'TAP = PAUSE');
  card.innerHTML = `
    <div class="seg-card-header">
      <div class="seg-num active-num">${num}</div>
      <span style="font-family:'DM Mono',monospace;font-size:9px;color:var(--text2);flex:1;margin-left:4px">Segment ${num}</span>
      <span class="seg-dur" id="seg-${num}-dur">00:00</span>
    </div>
    <div class="seg-card-body">
      <div class="seg-photos" id="seg-${num}-photos"></div>
      <div class="seg-audio-area">
        <div class="seg-waveform" id="seg-${num}-wave">${genWave()}</div>
      </div>
    </div>`;
  card.addEventListener('click', (e) => {
    // Buttons im Footer (Abspielen/Löschen) nicht abfangen
    if (e.target.closest('button')) return;
    if (card.classList.contains('recording-active') || card.classList.contains('recording-paused')) {
      toggleRec();
    }
  });
  list.appendChild(card);
  list.scrollTop = list.scrollHeight;
}

function finalizeSegCard(segId) {
  const card = $(segId);
  if (!card) return;
  card.classList.remove('recording-active', 'recording-paused');
  card.removeAttribute('data-toggle-hint');
  card.querySelector('.seg-num')?.classList.remove('active-num');
  if (!card.querySelector('.seg-card-footer')) {
    const footer = document.createElement('div');
    footer.className = 'seg-card-footer';
    footer.innerHTML = `
      <button class="seg-action" onclick="playSegment('${segId}',this)">\u25B6 Abspielen</button>
      <button class="seg-action danger" onclick="deleteSegment('${segId}')">\u2715 Löschen</button>`;
    card.appendChild(footer);
  }
}

function addPhotoThumbToSeg(segId, num, url) {
  const container = $(`${segId}-photos`);
  if (!container) return;
  const thumb = document.createElement('div');
  thumb.className = 'seg-thumb fadein';
  thumb.id = `thumb-photo-${num}`;
  if (url) {
    thumb.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:4px"><div class="seg-thumb-badge">${num}</div>`;
  } else {
    thumb.innerHTML = `<div class="seg-thumb-badge">${num}</div>`;
  }
  container.appendChild(thumb);
}

function genWave() {
  return Array.from({length:36}, () =>
    `<div class="seg-wave-bar" style="height:${20+Math.random()*70}%"></div>`
  ).join('');
}

function genCueWave() {
  return Array.from({length:40}, () =>
    `<div class="seg-wave-bar" style="height:${20+Math.random()*80}%"></div>`
  ).join('');
}

function updateSendStep(id, status, icon) {
  const el = $(id);
  if (!el) return;
  const iconEl = el.querySelector('.send-step-icon');
  if (iconEl) {
    iconEl.className = `send-step-icon ss-${status}`;
    iconEl.textContent = icon;
  }
}

// ── E-Mail-Versand ──────────────────────────────────────────────────────────
function openEmailModal() {
  $('email-modal').classList.add('active');
  $('email-status').textContent = '';
  $('btn-email-send').disabled = false;
  if (!state.mailAvailable) {
    $('email-status').textContent = '\u26A0 SMTP nicht konfiguriert';
    $('email-status').style.color = 'var(--accent)';
  }
  setTimeout(() => $('email-to').focus(), 200);
}

function closeEmailModal() {
  $('email-modal').classList.remove('active');
}

async function sendEmail() {
  const to = $('email-to').value.trim();
  const subject = $('email-subject').value.trim();
  const message = $('email-message').value.trim();
  const statusEl = $('email-status');

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    statusEl.textContent = 'Bitte gültige E-Mail eingeben';
    statusEl.style.color = 'var(--red)';
    return;
  }
  localStorage.setItem('baudiktat-email', to);

  $('btn-email-send').disabled = true;
  statusEl.textContent = '\u27F3 Wird gesendet…';
  statusEl.style.color = 'var(--text2)';

  try {
    const resp = await fetch(`${BACKEND}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.lastSessionId, to, subject, message }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || 'Fehler');
    statusEl.textContent = `\u2713 Gesendet an ${to}`;
    statusEl.style.color = 'var(--green)';
    setTimeout(() => closeEmailModal(), 2000);
  } catch (err) {
    statusEl.textContent = '\u2717 ' + err.message;
    statusEl.style.color = 'var(--red)';
    $('btn-email-send').disabled = false;
  }
}

function resetApp() {
  Object.assign(state, {
    isRec:false, isPaused:false, elapsed:0, segCount:0, photoCount:0,
    currentSegId:null, pendingPhoto:null,
    markers:[], photos:[], blocks:[], allChunks:[], audioChunks:[],
    segmentChunks: {},
    sessionId: crypto.randomUUID(),
    sessionStart: null, segmentStart: null,
  });
  state.projectNameCustom = '';
  state.projectNameStamp = '';
  updateProjectNameDisplay();
  clearInterval(state.timerInterval);
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  if (state.cueAudio) { state.cueAudio.pause(); state.cueAudio = null; }
  if (state.listenAudio) { state.listenAudio.pause(); state.listenAudio = null; }

  $('seg-list').innerHTML = `
    <div class="seg-empty" id="seg-empty">
      <div class="seg-empty-icon">\uD83C\uDF99</div>
      <div>Audio aufnehmen,<br>Fotos machen.</div>
    </div>`;

  ['ss1','ss2','ss3','ss4'].forEach((id,i) => {
    const el = $(id);
    if (!el) return;
    const iconEl = el.querySelector('.send-step-icon');
    if (iconEl) {
      iconEl.className = i===0 ? 'send-step-icon ss-active' : 'send-step-icon ss-wait';
      iconEl.textContent = i===0 ? '\u27F3' : String(i+1);
    }
  });

  $('output-preview').style.display = 'none';
  $('btn-email').style.display = 'none';
  $('btn-done').style.display = 'none';
  closeEmailModal();
  $('send-badge').textContent = 'LÄUFT';
  $('send-meta').textContent  = 'Wird hochgeladen…';
  updateRecUI(false);
  updateMeta();

  const korrekturBtn = $('btn-korrektur');
  if (korrekturBtn) korrekturBtn.style.display = '';

  showScreen('main');
}

function editProjectName() {
  const currentCustom = state.projectNameCustom || '';
  const name = prompt('Projektname (Datum/Uhrzeit wird automatisch ergänzt):', currentCustom);
  if (name !== null && name.trim()) {
    state.projectNameCustom = name.trim();
    updateProjectNameDisplay();
  }
}

function getDateTimeStamp() {
  const now = new Date();
  const d = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const t = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${d} ${t}`;
}

function updateProjectNameDisplay() {
  const stamp = state.projectNameStamp || getDateTimeStamp();
  if (state.projectNameCustom) {
    state.projectName = `${state.projectNameCustom} (${stamp})`;
  } else {
    state.projectName = `Classic-Diktat ${stamp}`;
  }
  const label = $('project-name-label');
  if (label) label.textContent = state.projectName;
}

// ── Globale Exports ─────────────────────────────────────────────────────────
window.startRec         = toggleRec;
window.openCamera       = openCamera;
window.capturePhoto     = capturePhoto;
window.keepPhoto        = keepPhoto;
window.retakePhoto      = retakePhoto;
window.cancelCamera     = cancelCamera;
window.newSegment       = newSegment;
window.finalizeSession  = finalizeSession;
window.playSegment      = playSegment;
window.deleteSegment    = deleteSegment;
window.resetApp         = resetApp;
window.openEmailModal   = openEmailModal;
window.closeEmailModal  = closeEmailModal;
window.sendEmail        = sendEmail;
window.editProjectName  = editProjectName;
window.cueBack          = cueBack;
window.cueBackStop      = cueBackStop;
window.cueBackResume    = cueBackResume;
window.listenLast       = listenLast;

})();
