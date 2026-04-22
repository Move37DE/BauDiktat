/**
 * BauDiktat PWA – app.js
 * Azure Speech Echtzeit-Streaming via WebSocket + Webcam-Fotos
 * Fallback: Rolling Chunks über HTTP wenn Azure nicht verfügbar
 */
(function() {
'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const VERSION  = '0.3.0';
const BACKEND = window.location.origin;
const WS_URL  = BACKEND.replace(/^http/, 'ws') + '/ws';

const CHUNK_INTERVAL_MS = 7000;   // Fallback: Rolling Chunks alle 7s

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  isRec:           false,
  useAzure:        false,       // wird beim Start vom Backend abgefragt
  // Audio
  mediaRecorder:   null,
  audioChunks:     [],
  allChunks:       [],
  chunkInterval:   null,
  // Azure Streaming
  ws:              null,
  audioContext:     null,
  scriptProcessor: null,
  azureReady:      false,
  partialText:     '',          // Aktuelles Azure-Teilergebnis
  // Timing
  sessionStart:    null,
  elapsed:         0,
  timerInterval:   null,
  // Segments & Photos
  segCount:        0,
  photoCount:      0,
  currentSegId:    null,
  currentSegText:  '',
  sessionId:       crypto.randomUUID(),
  markers:         [],
  photos:          [],
  words:           [],   // Word-Level Timestamps aus Azure Echtzeit-Streaming
  blocks:          [],   // Geordnete Blöcke: [{type:'text',text}, {type:'photo',photo}]
  pendingPhoto:    null,
  stream:          null,
  cameraStream:    null,
  projectName:     'Baustelle',
  lastSessionId:   null,        // für E-Mail-Versand
  mailAvailable:   false,       // SMTP konfiguriert?
};

// ── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    // Alten SW deregistrieren und neuen aktivieren
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.update());
    });
    navigator.serviceWorker.register('/sw.js').catch(console.warn);
  }
  // Version anzeigen
  const verEl = $('app-version');
  if (verEl) verEl.textContent = 'v' + VERSION;
  updateClock();
  setInterval(updateClock, 10000);
  updateMeta();

  // Backend-Status abfragen: Azure oder Whisper?
  try {
    const resp = await fetch(`${BACKEND}/api/status`, { cache: 'no-store' });
    const status = await resp.json();
    state.useAzure = status.azure;
    console.log('[Init] v' + VERSION + ' Speech Engine:', state.useAzure ? 'Azure' : 'Whisper');
  } catch (e) {
    console.warn('[Init] Backend nicht erreichbar, Demo-Modus');
  }

  // Mail-Status abfragen
  try {
    const mailResp = await fetch(`${BACKEND}/api/mail-status`, { cache: 'no-store' });
    const mailStatus = await mailResp.json();
    state.mailAvailable = mailStatus.available;
    console.log('[Init] E-Mail:', state.mailAvailable ? 'verfügbar' : 'nicht konfiguriert');
  } catch (e) {
    console.warn('[Init] Mail-Status nicht abrufbar');
  }

  // Letzte E-Mail aus localStorage laden
  const savedEmail = localStorage.getItem('baudiktat-email');
  if (savedEmail) {
    const emailInput = $('email-to');
    if (emailInput) emailInput.value = savedEmail;
  }
});

// ── Mikrofon ─────────────────────────────────────────────────────────────────
async function getMicStream() {
  if (state.stream) return state.stream;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Alle Browser-DSP-Filter AUS — wir nehmen roh auf, was ans Mic kommt.
        // noiseSuppression frisst erfahrungsgemäß Wortanfänge/Atempausen → "zerhackt"-Effekt.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 16000,
      }
    });
    return state.stream;
  } catch (err) {
    showError('Mikrofon-Zugriff verweigert. Bitte Berechtigung erteilen.');
    throw err;
  }
}

// ── Recording ────────────────────────────────────────────────────────────────
async function startRec() {
  console.log('[Rec] Starte Aufnahme, useAzure:', state.useAzure);
  const stream = await getMicStream();
  console.log('[Rec] Mikrofon bereit');
  state.isRec = true;
  state.sessionStart = Date.now();
  state.segCount++;

  // Beim ersten Segment: Datum+Uhrzeit fixieren
  if (state.segCount === 1 && !state.projectNameStamp) {
    state.projectNameStamp = getDateTimeStamp();
    updateProjectNameDisplay();
  }

  // Korrekturplatz-Link ausblenden während Aufnahme/Session aktiv
  const korrekturBtn = $('btn-korrektur');
  if (korrekturBtn) korrekturBtn.style.display = 'none';
  state.currentSegId = `seg-${state.segCount}`;
  state.currentSegText = '';
  state.partialText = '';

  // MediaRecorder: sammelt webm/opus für allChunks (Finalize braucht es)
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  state.mediaRecorder = new MediaRecorder(stream, { mimeType });
  state.audioChunks = [];

  state.mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) {
      state.audioChunks.push(e.data);
      state.allChunks.push(e.data);
    }
  };

  state.mediaRecorder.start(100);

  // Timer
  state.timerInterval = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
    updateTimerDisplay();
  }, 500);

  // Echtzeit-Transkription starten
  if (state.useAzure) {
    startAzureStream(stream);
  } else {
    // Whisper-Fallback: Rolling Chunks
    state.chunkInterval = setInterval(() => sendChunkToWhisper(), CHUNK_INTERVAL_MS);
  }

  // UI
  createSegCard(state.segCount);
  updateRecUI(true);
  updateMeta();
}

async function stopRec() {
  state.isRec = false;
  clearInterval(state.chunkInterval);
  clearInterval(state.timerInterval);

  // Azure Stream stoppen
  stopAzureStream();

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
    await delay(300);
    if (!state.useAzure && state.audioChunks.length > 0) {
      await sendChunkToWhisper(true);
    }
  }

  finalizeSegCard(state.currentSegId);
  updateRecUI(false);
  updateMeta();
}

// ── Azure Speech: Echtzeit-Streaming via WebSocket ──────────────────────────

function startAzureStream(micStream) {
  console.log('[Azure] WebSocket verbinden:', WS_URL);
  state.ws = new WebSocket(WS_URL);

  state.ws.onopen = () => {
    console.log('[Azure] WS offen, sende stream-start');
    state.ws.send(JSON.stringify({ type: 'stream-start' }));
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[Azure] Nachricht:', msg.type, msg.text?.substring(0, 50) || msg.message || '');

      if (msg.type === 'ready') {
        state.azureReady = true;
        startPcmCapture(micStream);
        console.log('[Azure] Streaming aktiv, PCM-Capture gestartet');
      }

      if (msg.type === 'partial') {
        // Teilergebnis – zeigt aktuellen Erkennungsstand
        state.partialText = msg.text;
        updateLiveTranscript();
      }

      if (msg.type === 'final') {
        // Endergebnis – Text festschreiben
        state.partialText = '';
        if (msg.text) {
          appendTextToCurrentSeg(msg.text, msg.words || []);
        }
      }

      if (msg.type === 'fallback') {
        // Azure nicht verfügbar → Whisper Rolling Chunks
        console.warn('[Azure]', msg.message);
        state.useAzure = false;
        state.chunkInterval = setInterval(() => sendChunkToWhisper(), CHUNK_INTERVAL_MS);
      }

      if (msg.type === 'error') {
        console.error('[Azure]', msg.message);
      }
    } catch (e) {
      console.warn('[WS] Parse error:', e);
    }
  };

  state.ws.onerror = (err) => {
    console.error('[WS] Error:', err.message || err);
    // Fallback zu Rolling Chunks
    state.useAzure = false;
    state.chunkInterval = setInterval(() => sendChunkToWhisper(), CHUNK_INTERVAL_MS);
  };

  state.ws.onclose = (ev) => {
    state.azureReady = false;
    console.log('[WS] Verbindung geschlossen, code:', ev.code, 'reason:', ev.reason);
  };
}

function startPcmCapture(micStream) {
  // AudioContext mit 16kHz für Azure Speech
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000,
  });

  const source = state.audioContext.createMediaStreamSource(micStream);

  // ScriptProcessorNode: Float32 → Int16 PCM → WebSocket
  state.scriptProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);

  state.scriptProcessor.onaudioprocess = (e) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.azureReady) return;

    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    state.ws.send(int16.buffer);
  };

  source.connect(state.scriptProcessor);
  // ScriptProcessorNode muss mit destination verbunden sein um zu feuern
  state.scriptProcessor.connect(state.audioContext.destination);
}

function stopAzureStream() {
  if (state.scriptProcessor) {
    state.scriptProcessor.disconnect();
    state.scriptProcessor = null;
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
    state.audioContext = null;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'stream-stop' }));
    state.ws.close();
  }
  state.ws = null;
  state.azureReady = false;
  state.partialText = '';
}

function updateLiveTranscript() {
  if (!state.currentSegId) return;
  const el = $(`${state.currentSegId}-text`);
  if (!el) return;

  // Finalisierten Text + aktuelles Teilergebnis anzeigen
  const display = state.currentSegText
    ? state.currentSegText + ' ' + state.partialText
    : state.partialText || 'Aufnahme läuft…';
  el.textContent = display;
  el.className = 'seg-transcript live';

  const dur = $(`${state.currentSegId}-dur`);
  if (dur) dur.textContent = formatTime(state.elapsed);
  $('seg-list').scrollTop = $('seg-list').scrollHeight;
}

// ── Rolling Chunk → Whisper (Fallback) ──────────────────────────────────────
async function sendChunkToWhisper(isFinal = false) {
  if (state.audioChunks.length === 0) return;

  const chunks = [...state.audioChunks];
  state.audioChunks = [];

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const offset = Math.max(0, state.elapsed - (chunks.length * 100 / 1000));

  const formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');
  formData.append('segId', state.currentSegId);
  formData.append('offset', offset.toString());

  try {
    const resp = await fetch(`${BACKEND}/transcribe-chunk`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.text) {
      appendTextToCurrentSeg(data.text, data.words || []);
    }
  } catch (err) {
    console.warn('[Chunk] Backend nicht erreichbar:', err.message);
    simulateTranscription();
  }
}

// ── Segment erstellen ─────────────────────────────────────────────────────────
function newSegment() {
  if (!state.isRec) return;
  finalizeSegCard(state.currentSegId);
  state.segCount++;
  state.currentSegId = `seg-${state.segCount}`;
  state.currentSegText = '';
  state.partialText = '';
  createSegCard(state.segCount);
  updateMeta();
}

// ── Foto aufnehmen (Webcam) ───────────────────────────────────────────────────
async function openCamera() {
  if (state.segCount === 0) return; // Erst diktieren, dann fotografieren

  // Aufnahme pausieren falls aktiv
  if (state.isRec) {
    clearInterval(state.chunkInterval);
    clearInterval(state.timerInterval);
    state.mediaRecorder?.pause?.();

    // Azure PCM-Capture pausieren (aber WS offen lassen)
    if (state.scriptProcessor) {
      state.scriptProcessor.disconnect();
    }
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
    $('camera-fallback')?.style && ($('camera-fallback').style.display = 'flex');
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
    ctx.fillStyle = '#1a1a16';
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#e09a1a';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Foto ' + (state.photoCount + 1), 320, 220);
    ctx.fillStyle = '#555';
    ctx.font = '16px sans-serif';
    ctx.fillText(new Date().toLocaleTimeString('de-DE'), 320, 260);
  }

  canvas.toBlob(blob => {
    state.photoCount++;
    const photoName = `img_${String(state.photoCount).padStart(3,'0')}.jpg`;
    const t = state.elapsed;

    const photo = {
      id: `photo-${state.photoCount}`,
      blob,
      name: photoName,
      url:  URL.createObjectURL(blob),
      timestamp: t,
      segId: state.currentSegId,
      caption: '',
    };

    state.photos.push(photo);
    state.pendingPhoto = photo;
    state.markers.push({ t, photo: photoName });
    // Foto als Block in die Reihenfolge einfügen
    state.blocks.push({ type: 'photo', photo: photoName, timestamp: t });

    state.cameraStream?.getTracks().forEach(t => t.stop());
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
  $('photo-context-text').textContent = `"…${state.currentSegText.slice(-100)}…"`;

  showScreen('photo');
}

function keepPhoto() {
  state.pendingPhoto = null;
  $('dot-photo').className = 'state-dot';
  $('dot-photo-label').textContent = 'Kein Foto ausstehend';
  showScreen('main');
  if (state.isRec) resumeRec();
}

function retakePhoto() {
  if (state.pendingPhoto) {
    state.photos.pop();
    state.markers.pop();
    const thumb = $(`thumb-photo-${state.photoCount}`);
    if (thumb) { thumb.style.opacity = '0'; setTimeout(() => thumb.remove(), 200); }
    state.photoCount--;
    updateMeta();
  }
  showScreen('camera');
  openCamera();
}

function cancelCamera() {
  state.cameraStream?.getTracks().forEach(t => t.stop());
  state.cameraStream = null;
  showScreen('main');
  if (state.isRec) resumeRec();
}

function resumeRec() {
  if (!state.isRec) return;
  state.mediaRecorder?.resume?.();

  if (state.useAzure && state.audioContext && state.scriptProcessor) {
    // PCM-Capture wieder verbinden
    const source = state.audioContext.createMediaStreamSource(state.stream);
    source.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.audioContext.destination);
  } else if (!state.useAzure) {
    state.chunkInterval = setInterval(() => sendChunkToWhisper(), CHUNK_INTERVAL_MS);
  }

  state.timerInterval = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
    updateTimerDisplay();
  }, 500);
}

// ── Session finalisieren & senden ─────────────────────────────────────────────
async function finalizeSession() {
  showScreen('send');

  try {
    const audioBlob = new Blob(state.allChunks, { type: 'audio/webm' });

    const formData = new FormData();
    formData.append('audio', audioBlob, 'session.webm');
    formData.append('session', JSON.stringify({
      projectName: state.projectName,
      markers: state.markers,
      sessionId: state.sessionId,
      // Echtzeit-Transkription mitsenden → kein Re-Transcribe nötig
      realtimeText: state.currentSegText,
      realtimeWords: state.words,
      // Geordnete Blöcke: Text und Fotos in der Reihenfolge wie sie entstanden sind
      orderedBlocks: state.blocks,
    }));

    state.photos.forEach(photo => {
      formData.append('photos', photo.blob, photo.name);
    });

    updateSendStep('ss1', 'active', '\u27F3');

    const resp = await fetch(`${BACKEND}/finalize`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();

    updateSendStep('ss1', 'done', '\u2713');
    await delay(400);
    updateSendStep('ss2', 'done', '\u2713');
    await delay(400);
    updateSendStep('ss3', 'done', '\u2713');
    await delay(400);
    updateSendStep('ss4', 'done', '\u2713');

    $('send-badge').textContent = 'FERTIG';
    $('send-meta').textContent = 'Dokument bereit';

    showDownloadLink(result.downloadUrl, result);

  } catch (err) {
    console.error('[Finalize]', err);
    simulateSend();
  }
}

function showDownloadLink(url, result) {
  // SessionId für E-Mail-Versand speichern
  state.lastSessionId = result.sessionId;

  const preview = $('output-preview');
  if (!preview) return;
  preview.style.display = 'block';

  const body = $('output-body');
  if (body) {
    body.innerHTML = `
      <div style="color:var(--green);font-weight:500;margin-bottom:8px">
        \u2713 ${result.blockCount} Blöcke · ${result.photoCount} Fotos synchronisiert
      </div>
      <a href="${BACKEND}${url}"
         style="display:flex;align-items:center;gap:8px;background:var(--gdim);
                border:1px solid rgba(82,176,106,0.35);border-radius:8px;
                padding:10px 14px;color:var(--green);text-decoration:none;
                font-family:'DM Mono',monospace;font-size:11px;"
         download>
        \u2193 BauDiktat_Bericht.docx herunterladen
      </a>
      ${result.correctionUrl ? `
      <a href="${BACKEND}${result.correctionUrl}" target="_blank"
         style="display:flex;align-items:center;gap:8px;background:var(--bdim, rgba(74,143,212,0.15));
                border:1px solid rgba(74,143,212,0.35);border-radius:8px;
                padding:10px 14px;color:var(--blue);text-decoration:none;
                font-family:'DM Mono',monospace;font-size:11px;margin-top:6px;">
        \uD83C\uDFA7 Am Korrekturplatz bearbeiten
      </a>` : ''}
    `;
  }

  // E-Mail-Button anzeigen (auch wenn SMTP nicht konfiguriert - Modal zeigt Hinweis)
  $('btn-email').style.display = 'flex';
  $('btn-done').style.display = 'flex';

  // Betreff automatisch setzen
  const today = new Date().toLocaleDateString('de-DE');
  const subjectInput = $('email-subject');
  if (subjectInput && !subjectInput.value) {
    subjectInput.value = `BauDiktat \u2013 Baustellenprotokoll ${today}`;
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${id}`)?.classList.add('active');
}

function updateRecUI(rec) {
  const btn = $('btn-rec');
  if (!btn) return;
  if (rec) {
    btn.className = 'btn btn-rec';
    btn.innerHTML = '\u23F9 Stop';
    $('btn-photo').disabled = false;
    $('btn-seg').disabled = false;
    $('btn-send').disabled = true;
    $('btn-send').className = 'btn btn-send';
    $('status-badge').className = 'header-badge rec';
    $('status-badge').innerHTML = '<span class="rdot"></span> REC';
    $('dot-rec').className = 'state-dot on';
    $('seg-empty').style.display = 'none';
  } else {
    btn.className = 'btn btn-rec paused';
    btn.innerHTML = '\u23FA Weiter aufnehmen';
    // Foto-Button bleibt aktiv nach Stop – Architekt diktiert, prüft Text, macht dann Fotos
    $('btn-photo').disabled = !(state.segCount > 0);
    $('btn-seg').disabled = true;
    const has = state.segCount > 0;
    $('btn-send').disabled = !has;
    $('btn-send').className = has ? 'btn btn-send ready' : 'btn btn-send';
    $('status-badge').className = 'header-badge';
    $('status-badge').textContent = 'PAUSE';
    $('dot-rec').className = 'state-dot';
    $('dot-ready').className = has ? 'state-dot ready' : 'state-dot';
  }
}

function updateTimerDisplay() {
  const badge = $('status-badge');
  if (badge && state.isRec) {
    badge.innerHTML = `<span class="rdot"></span> REC \u00B7 ${formatTime(state.elapsed)}`;
  }
}

function updateMeta() {
  $('seg-count-meta').textContent = `${state.segCount} Segment${state.segCount!==1?'e':''}`;
  $('photo-count-meta').textContent = `${state.photoCount} Foto${state.photoCount!==1?'s':''}`;
  $('info-seg-count').textContent = state.segCount;
  $('info-photo-total').textContent = state.photoCount;
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

function showError(msg) {
  alert(msg);
}

// ── Segment DOM ───────────────────────────────────────────────────────────────
function createSegCard(num) {
  const list = $('seg-list');
  $('seg-empty').style.display = 'none';
  const card = document.createElement('div');
  card.className = 'seg-card recording-active fadein';
  card.id = `seg-${num}`;
  card.innerHTML = `
    <div class="seg-card-header">
      <div class="seg-num active-num">${num}</div>
      <span style="font-family:'DM Mono',monospace;font-size:9px;color:var(--text2);flex:1;margin-left:4px">Segment ${num}</span>
      <span class="seg-dur" id="seg-${num}-dur">00:00</span>
    </div>
    <div class="seg-card-body">
      <div class="seg-photos" id="seg-${num}-photos"></div>
      <div class="seg-text-area">
        <div class="seg-waveform" id="seg-${num}-wave">${genWave()}</div>
        <div class="seg-transcript live" id="seg-${num}-text">Aufnahme l\u00E4uft\u2026</div>
      </div>
    </div>`;
  list.appendChild(card);
  list.scrollTop = list.scrollHeight;
}

function appendTextToCurrentSeg(text, words) {
  if (!state.currentSegId) return;
  if (words && words.length) state.words.push(...words);
  // Block-Reihenfolge tracken: Text kommt rein → als Block merken
  if (text.trim()) state.blocks.push({ type: 'text', text: text.trim() });
  state.currentSegText += (state.currentSegText ? ' ' : '') + text;
  const el = $(`${state.currentSegId}-text`);
  if (el) { el.textContent = state.currentSegText; el.className = 'seg-transcript live'; }
  const dur = $(`${state.currentSegId}-dur`);
  if (dur) dur.textContent = formatTime(state.elapsed);
  $('seg-list').scrollTop = $('seg-list').scrollHeight;
}

function finalizeSegCard(segId) {
  const card = $(segId);
  if (!card) return;
  card.classList.remove('recording-active');
  card.querySelector('.seg-num')?.classList.remove('active-num');
  const textEl = $(`${segId}-text`);
  if (textEl) textEl.className = 'seg-transcript';
  if (!card.querySelector('.seg-card-footer')) {
    const footer = document.createElement('div');
    footer.className = 'seg-card-footer';
    footer.innerHTML = `
      <button class="seg-action" onclick="playSegment('${segId}',this)">\u25B6 Abspielen</button>
      <button class="seg-action danger" onclick="deleteSegment('${segId}')">\u2715 L\u00F6schen</button>`;
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
    thumb.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:4px">
                       <div class="seg-thumb-badge">${num}</div>`;
  } else {
    thumb.innerHTML = `<div class="seg-thumb-badge">${num}</div>`;
  }
  container.appendChild(thumb);
}

function playSegment(segId, btn) {
  const card = $(segId);
  const isPlaying = card?.classList.contains('playing');
  document.querySelectorAll('.seg-card.playing').forEach(c => {
    c.classList.remove('playing');
    const b = c.querySelector('.seg-action');
    if (b) b.textContent = '\u25B6 Abspielen';
  });
  if (!isPlaying && card) {
    card.classList.add('playing');
    btn.textContent = '\u23F9 Stop';
    setTimeout(() => { card.classList.remove('playing'); btn.textContent = '\u25B6 Abspielen'; }, 3000);
  }
}

function deleteSegment(segId) {
  const card = $(segId);
  if (!card) return;
  card.style.cssText += 'opacity:0;transform:translateX(20px);transition:all 0.2s';
  setTimeout(() => { card.remove(); state.segCount = Math.max(0, state.segCount - 1); updateMeta(); }, 200);
}

function genWave() {
  return Array.from({length:18}, () =>
    `<div class="seg-wave-bar" style="height:${3+Math.random()*11}px"></div>`
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

// ── Fallback: Demo-Modus ohne Backend ─────────────────────────────────────────
const DEMO_TEXTS = [
  "Die Fassade im Nordbereich zeigt deutliche Risse im Putz, Tiefe ca. zwei Zentimeter.",
  "Fensterrahmen Achse drei weist erhebliche Feuchtigkeitssch\u00E4den auf.",
  "Bodenbelag Erdgeschoss Bereich B ist vollst\u00E4ndig zu erneuern, ca. achtzig Quadratmeter.",
  "Stahltr\u00E4ger T-vier im Kellergeschoss \u2013 Korrosionsschutz pr\u00FCfen.",
];
let demoIdx = 0;

function simulateTranscription() {
  if (!state.isRec) return;
  appendTextToCurrentSeg(DEMO_TEXTS[demoIdx % DEMO_TEXTS.length]);
  demoIdx++;
}

async function simulateSend() {
  const steps = [
    [0,    'ss1', '\u27F3', 'active'],
    [1200, 'ss1', '\u2713', 'done'],
    [1400, 'ss2', '\u27F3', 'active'],
    [2400, 'ss2', '\u2713', 'done'],
    [2600, 'ss3', '\u27F3', 'active'],
    [3600, 'ss3', '\u2713', 'done'],
    [3800, 'ss4', '\u27F3', 'active'],
    [4800, 'ss4', '\u2713', 'done'],
  ];
  for (const [ms, id, icon, status] of steps) {
    await delay(ms > 0 ? 200 : 0);
    updateSendStep(id, status, icon);
    await delay(ms);
  }
  $('send-badge').textContent = 'FERTIG';
  $('send-meta').textContent  = 'Demo-Modus (Backend offline)';
  $('output-preview').style.display = 'block';
  $('output-body').innerHTML = `
    <div style="color:var(--accent);font-size:10px;font-family:'DM Mono',monospace;margin-bottom:8px">
      \u26A0 Demo-Modus \u2013 Backend unter ${BACKEND} nicht erreichbar
    </div>
    <div style="color:var(--text2);font-size:11px;line-height:1.8">
      ${state.currentSegText.slice(0,120)}\u2026
      <span class="photo-inline">img_001.jpg</span>
    </div>`;
  $('btn-done').style.display = 'flex';
}

// ── E-Mail-Versand ──────────────────────────────────────────────────────────
function openEmailModal() {
  $('email-modal').classList.add('active');
  $('email-status').textContent = '';
  $('btn-email-send').disabled = false;

  if (!state.mailAvailable) {
    $('email-status').textContent = '\u26A0 SMTP nicht konfiguriert – bitte .env pr\u00FCfen';
    $('email-status').style.color = 'var(--accent)';
  }

  // Fokus auf E-Mail-Feld
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

  if (!to) {
    statusEl.textContent = 'Bitte E-Mail-Adresse eingeben';
    statusEl.style.color = 'var(--red)';
    $('email-to').focus();
    return;
  }

  // E-Mail validieren
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    statusEl.textContent = 'Ung\u00FCltige E-Mail-Adresse';
    statusEl.style.color = 'var(--red)';
    $('email-to').focus();
    return;
  }

  // E-Mail in localStorage speichern
  localStorage.setItem('baudiktat-email', to);

  // Senden
  $('btn-email-send').disabled = true;
  statusEl.textContent = '\u27F3 Wird gesendet\u2026';
  statusEl.style.color = 'var(--text2)';

  try {
    const resp = await fetch(`${BACKEND}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.lastSessionId,
        to,
        subject,
        message,
      }),
    });

    const result = await resp.json();

    if (!resp.ok) throw new Error(result.error || 'Fehler beim Senden');

    statusEl.textContent = `\u2713 Gesendet an ${to}`;
    statusEl.style.color = 'var(--green)';

    // Modal nach 2s schlie\u00DFen
    setTimeout(() => closeEmailModal(), 2000);

  } catch (err) {
    console.error('[Mail]', err);
    statusEl.textContent = '\u2717 ' + err.message;
    statusEl.style.color = 'var(--red)';
    $('btn-email-send').disabled = false;
  }
}

function resetApp() {
  stopAzureStream();

  Object.assign(state, {
    isRec:false, elapsed:0, segCount:0, photoCount:0,
    currentSegId:null, currentSegText:'', partialText:'', pendingPhoto:null,
    markers:[], photos:[], words:[], blocks:[], allChunks:[], audioChunks:[],
    sessionId: crypto.randomUUID(),
    azureReady: false,
  });
  state.projectNameCustom = '';
  state.projectNameStamp = '';
  updateProjectNameDisplay();
  clearInterval(state.chunkInterval);
  clearInterval(state.timerInterval);
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;

  $('seg-list').innerHTML = `
    <div class="seg-empty" id="seg-empty">
      <div class="seg-empty-icon">\uD83C\uDF99</div>
      <div>Aufnahme starten,<br>sprechen, Fotos machen.</div>
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
  $('send-badge').textContent = 'L\u00C4UFT';
  $('send-meta').textContent  = 'Wird verarbeitet\u2026';
  updateRecUI(false);
  updateMeta();

  // Korrekturplatz-Link wieder einblenden
  const korrekturBtn = $('btn-korrektur');
  if (korrekturBtn) korrekturBtn.style.display = '';

  showScreen('main');
}

function editProjectName() {
  // Nur den benutzerdefinierten Teil editieren (ohne Datum-Suffix)
  const currentCustom = state.projectNameCustom || '';
  const name = prompt('Projektname (Datum/Uhrzeit wird automatisch ergaenzt):', currentCustom);
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
    state.projectName = `Diktat ${stamp}`;
  }
  const label = $('project-name-label');
  if (label) label.textContent = state.projectName;
}

// Beim Start: Default-Name setzen
(function() {
  state.projectNameCustom = '';
  state.projectNameStamp = '';
  updateProjectNameDisplay();
})();

function toggleRec() { if (!state.isRec) startRec(); else stopRec(); }

// Globale Exports für onclick-Handler im HTML
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

})();
