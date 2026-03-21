/**
 * BauDiktat Backend – ASKA
 *
 * Routes:
 *   POST /transcribe-chunk   – Rolling chunk → Whisper → Text (Fallback)
 *   POST /transcribe-azure   – Datei-Transkription via Azure Speech
 *   POST /finalize           – Ganze Session → Timestamps sync → DOCX generieren
 *   GET  /download/:id       – Fertiges DOCX herunterladen
 *   WS   /ws                 – Azure Speech Echtzeit-Streaming
 *
 * Azure Speech ist primär, Whisper ist Fallback.
 */

// .env im Projekt-Root laden (lokal), auf Azure kommen die Werte aus App Settings
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config(); // Fallback: .env im cwd (Azure)

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const { exec }   = require('child_process');
const { promisify } = require('util');
const execAsync  = promisify(exec);
const fs         = require('fs');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const { createDocx } = require('./docx-generator');
const nodemailer = require('nodemailer');
const http       = require('http');
const WebSocket  = require('ws');

// Azure Speech SDK – optional, Whisper als Fallback
let sdk;
try {
  sdk = require('microsoft-cognitiveservices-speech-sdk');
} catch (e) {
  console.warn('[Azure] Speech SDK nicht installiert – nur Whisper verfügbar');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  WHISPER_CMD: process.env.WHISPER_CMD || 'whisper',
  WHISPER_MODEL_REALTIME: process.env.WHISPER_MODEL_RT  || 'small',
  WHISPER_MODEL_FINAL:    process.env.WHISPER_MODEL_FIN || 'large-v3',
  WHISPER_LANG: 'de',

  AZURE_SPEECH_KEY:    process.env.AZURE_SPEECH_KEY    || '',
  AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION || 'westeurope',

  // E-Mail (SMTP)
  SMTP_HOST:   process.env.SMTP_HOST   || '',
  SMTP_PORT:   parseInt(process.env.SMTP_PORT || '587'),
  SMTP_USER:   process.env.SMTP_USER   || '',
  SMTP_PASS:   process.env.SMTP_PASS   || '',
  SMTP_FROM:   process.env.SMTP_FROM   || process.env.SMTP_USER || 'baudiktat@aska.de',

  UPLOAD_DIR: path.join(__dirname, 'uploads'),
  OUTPUT_DIR: path.join(__dirname, 'output'),
  PORT: process.env.PORT || 3001,
};

const useAzure = !!(sdk && CONFIG.AZURE_SPEECH_KEY);

// Ordner anlegen
[CONFIG.UPLOAD_DIR, CONFIG.OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// PWA-Dateien aus ../pwa servieren
app.use(express.static(path.join(__dirname, '..', 'pwa')));

const storage = multer.diskStorage({
  destination: CONFIG.UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── Status-Route ────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    azure: useAzure,
    whisper: !useAzure,
    region: useAzure ? CONFIG.AZURE_SPEECH_REGION : null,
  });
});

// ── Whisper Helpers ──────────────────────────────────────────────────────────

async function runWhisper(audioPath, model = CONFIG.WHISPER_MODEL_REALTIME) {
  const outDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));

  const cmd = [
    CONFIG.WHISPER_CMD,
    `"${audioPath}"`,
    `--model ${model}`,
    `--language ${CONFIG.WHISPER_LANG}`,
    `--word_timestamps True`,
    `--output_format json`,
    `--output_dir "${outDir}"`,
    '--device cuda',
  ].join(' ');

  console.log(`[Whisper] Running: ${cmd}`);

  try {
    await execAsync(cmd, { timeout: 120000 });
    console.log('[Whisper] Done');

    const jsonPath = path.join(outDir, `${baseName}.json`);
    if (!fs.existsSync(jsonPath)) {
      throw new Error('Whisper JSON output not found: ' + jsonPath);
    }
    const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fs.unlinkSync(jsonPath);
    return result;
  } catch (err) {
    console.error('[Whisper] Error:', err.message);
    throw err;
  }
}

// ── Azure Speech: Datei-Transkription ────────────────────────────────────────

async function transcribeWithAzure(audioPath) {
  if (!useAzure) throw new Error('Azure Speech nicht konfiguriert');

  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      CONFIG.AZURE_SPEECH_KEY, CONFIG.AZURE_SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = 'de-DE';
    speechConfig.requestWordLevelTimestamps();
    speechConfig.outputFormat = sdk.OutputFormat.Detailed;

    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      fs.readFileSync(audioPath)
    );

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const allWords = [];
    let fullText = '';

    recognizer.recognized = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        fullText += (fullText ? ' ' : '') + e.result.text;

        try {
          const detailed = JSON.parse(
            e.result.properties.getProperty(
              sdk.PropertyId.SpeechServiceResponse_JsonResult
            )
          );
          const words = (detailed.NBest?.[0]?.Words || []).map(w => ({
            word: w.Word,
            start: w.Offset / 10000000,
            end: (w.Offset + w.Duration) / 10000000,
          }));
          allWords.push(...words);
        } catch (parseErr) {
          console.warn('[Azure] Word-Timestamp Parse-Fehler:', parseErr.message);
        }
      }
    };

    recognizer.canceled = (s, e) => {
      recognizer.close();
      if (e.reason === sdk.CancellationReason.Error) {
        reject(new Error(`Azure Speech Error: ${e.errorDetails}`));
      } else {
        resolve({ text: fullText, words: allWords });
      }
    };

    recognizer.sessionStopped = () => {
      recognizer.close();
      resolve({ text: fullText, words: allWords });
    };

    recognizer.startContinuousRecognitionAsync(
      () => {},
      (err) => { recognizer.close(); reject(err); }
    );
  });
}

// ── Timestamp Synchronisierung ───────────────────────────────────────────────

function syncTimestamps(words, markers) {
  console.log(`[Sync] ${words?.length || 0} Wörter, ${markers?.length || 0} Marker`);
  if (words?.length > 0) {
    console.log(`[Sync] Wort-Zeitraum: ${words[0].start}s – ${words[words.length-1].end}s`);
  }
  markers?.forEach((m, i) => console.log(`[Sync] Marker ${i}: t=${m.t}s foto=${m.photo}`));

  if (!words || words.length === 0) return [];

  const sortedMarkers = [...markers].sort((a, b) => a.t - b.t);
  const result = [];
  let markerIdx = 0;
  let currentText = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordStart = word.start;

    while (markerIdx < sortedMarkers.length &&
           sortedMarkers[markerIdx].t <= wordStart) {
      if (currentText.trim()) {
        result.push({ type: 'text', text: currentText.trim() });
        currentText = '';
      }
      result.push({
        type: 'photo',
        photo: sortedMarkers[markerIdx].photo,
        timestamp: sortedMarkers[markerIdx].t,
        caption: sortedMarkers[markerIdx].caption || '',
      });
      markerIdx++;
    }

    currentText += (currentText ? ' ' : '') + word.word;
  }

  if (currentText.trim()) {
    result.push({ type: 'text', text: currentText.trim() });
  }

  while (markerIdx < sortedMarkers.length) {
    result.push({
      type: 'photo',
      photo: sortedMarkers[markerIdx].photo,
      timestamp: sortedMarkers[markerIdx].t,
      caption: sortedMarkers[markerIdx].caption || '',
    });
    markerIdx++;
  }

  console.log('[Sync] Ergebnis:');
  result.forEach((b, i) => {
    if (b.type === 'text') console.log(`  [${i}] TEXT: "${b.text.substring(0, 50)}..."`);
    if (b.type === 'photo') console.log(`  [${i}] FOTO: ${b.photo} @ ${b.timestamp}s`);
  });

  return result;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /transcribe-chunk  (Whisper-Fallback für Rolling Chunks)
 */
app.post('/transcribe-chunk', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  const { segId = 'unknown', offset = '0' } = req.body;
  const offsetSec = parseFloat(offset);
  const audioPath = req.file.path;

  try {
    const result = await runWhisper(audioPath, CONFIG.WHISPER_MODEL_REALTIME);
    const words = (result.words || []).map(w => ({
      ...w,
      start: w.start + offsetSec,
      end:   w.end   + offsetSec,
    }));

    fs.unlinkSync(audioPath);

    res.json({
      text: result.text?.trim() || '',
      words,
      segId,
      offset: offsetSec,
    });
  } catch (err) {
    console.error('[/transcribe-chunk]', err);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /transcribe-azure  (Datei-basierte Azure-Transkription)
 */
app.post('/transcribe-azure', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  if (!useAzure) return res.status(503).json({ error: 'Azure Speech nicht konfiguriert' });

  const audioPath = req.file.path;

  try {
    const result = await transcribeWithAzure(audioPath);
    fs.unlinkSync(audioPath);

    res.json({
      text: result.text?.trim() || '',
      words: result.words || [],
    });
  } catch (err) {
    console.error('[/transcribe-azure]', err);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /finalize – Finale Verarbeitung der kompletten Session.
 * Nutzt Azure wenn verfügbar, sonst Whisper large-v3.
 */
app.post('/finalize', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'photos', maxCount: 50 },
]), async (req, res) => {

  const sessionData = JSON.parse(req.body.session || '{}');
  const audioFile   = req.files?.audio?.[0];
  const photoFiles  = req.files?.photos || [];

  if (!audioFile) return res.status(400).json({ error: 'No audio file' });

  const sessionId = uuidv4();
  console.log(`[/finalize] Session ${sessionId} – ${photoFiles.length} Fotos`);

  try {
    // 1. Transkription – Echtzeit-Daten bevorzugen (bereits via Azure Streaming erhalten)
    let transcriptionResult;

    if (sessionData.realtimeWords && sessionData.realtimeWords.length > 0) {
      // Echtzeit-Streaming hat bereits Word-Level Timestamps geliefert
      console.log(`[/finalize] Nutze Echtzeit-Transkription (${sessionData.realtimeWords.length} Wörter)`);
      transcriptionResult = {
        text: sessionData.realtimeText || '',
        words: sessionData.realtimeWords,
      };
    } else if (useAzure) {
      console.log('[/finalize] Transkribiere mit Azure Speech (Datei)');
      try {
        transcriptionResult = await transcribeWithAzure(audioFile.path);
      } catch (azureErr) {
        console.warn('[/finalize] Azure fehlgeschlagen, Whisper-Fallback:', azureErr.message);
        transcriptionResult = await runWhisper(audioFile.path, CONFIG.WHISPER_MODEL_FINAL);
      }
    } else {
      console.log('[/finalize] Transkribiere mit Whisper', CONFIG.WHISPER_MODEL_FINAL);
      transcriptionResult = await runWhisper(audioFile.path, CONFIG.WHISPER_MODEL_FINAL);
    }

    // 2. Foto-Map aufbauen
    const photoMap = {};
    photoFiles.forEach(f => { photoMap[f.originalname] = f.path; });

    // 3. Blöcke zusammenbauen – orderedBlocks (sequenziell) bevorzugen
    let blocksWithPaths;

    if (sessionData.orderedBlocks && sessionData.orderedBlocks.length > 0) {
      // Client hat die Reihenfolge bereits korrekt getrackt
      console.log(`[/finalize] Nutze orderedBlocks (${sessionData.orderedBlocks.length} Blöcke)`);
      blocksWithPaths = sessionData.orderedBlocks.map(block => {
        if (block.type === 'photo') {
          return { ...block, localPath: photoMap[block.photo] || null };
        }
        return block;
      });
    } else {
      // Fallback: Timestamp-basierte Synchronisation
      const syncedBlocks = syncTimestamps(
        transcriptionResult.words || [],
        sessionData.markers || [],
      );
      blocksWithPaths = syncedBlocks.map(block => {
        if (block.type === 'photo') {
          return { ...block, localPath: photoMap[block.photo] || null };
        }
        return block;
      });
    }

    // Aufeinanderfolgende Text-Blöcke zusammenfassen
    const mergedBlocks = [];
    for (const block of blocksWithPaths) {
      if (block.type === 'text' && mergedBlocks.length > 0 &&
          mergedBlocks[mergedBlocks.length - 1].type === 'text') {
        mergedBlocks[mergedBlocks.length - 1].text += ' ' + block.text;
      } else {
        mergedBlocks.push({ ...block });
      }
    }
    blocksWithPaths = mergedBlocks;

    console.log('[/finalize] Blöcke:');
    blocksWithPaths.forEach((b, i) => {
      if (b.type === 'text') console.log(`  [${i}] TEXT: "${b.text.substring(0, 60)}..."`);
      if (b.type === 'photo') console.log(`  [${i}] FOTO: ${b.photo}`);
    });

    // 5. DOCX generieren
    const docxPath = path.join(CONFIG.OUTPUT_DIR, `${sessionId}.docx`);
    await createDocx({
      blocks: blocksWithPaths,
      projectName: sessionData.projectName || 'Baustelle',
      date: new Date().toLocaleDateString('de-DE'),
      sessionId,
      outputPath: docxPath,
    });

    // 6. Aufräumen
    fs.unlinkSync(audioFile.path);
    photoFiles.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });

    console.log(`[/finalize] Fertig: ${docxPath}`);
    res.json({
      sessionId,
      downloadUrl: `/download/${sessionId}`,
      text: transcriptionResult.text?.trim(),
      blockCount: blocksWithPaths.length,
      photoCount: blocksWithPaths.filter(b => b.type === 'photo').length,
    });

  } catch (err) {
    console.error('[/finalize]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /download/:sessionId
 */
app.get('/download/:sessionId', (req, res) => {
  const docxPath = path.join(CONFIG.OUTPUT_DIR, `${req.params.sessionId}.docx`);
  if (!fs.existsSync(docxPath)) return res.status(404).json({ error: 'Not found' });
  res.download(docxPath, 'BauDiktat_Bericht.docx');
});

// ── E-Mail-Versand ──────────────────────────────────────────────────────────

let smtpTransport = null;
if (CONFIG.SMTP_HOST && CONFIG.SMTP_USER) {
  smtpTransport = nodemailer.createTransport({
    host: CONFIG.SMTP_HOST,
    port: CONFIG.SMTP_PORT,
    secure: CONFIG.SMTP_PORT === 465,
    auth: { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS },
  });
  console.log(`[Mail] SMTP konfiguriert: ${CONFIG.SMTP_USER} via ${CONFIG.SMTP_HOST}`);
} else {
  console.warn('[Mail] SMTP nicht konfiguriert – E-Mail-Versand deaktiviert');
}

app.get('/api/mail-status', (req, res) => {
  res.json({ available: !!smtpTransport });
});

app.post('/api/send-email', express.json(), async (req, res) => {
  const { sessionId, to, subject, message } = req.body;

  if (!to || !sessionId) {
    return res.status(400).json({ error: 'E-Mail-Adresse und Session-ID erforderlich' });
  }

  if (!smtpTransport) {
    return res.status(503).json({ error: 'SMTP nicht konfiguriert. Bitte SMTP_HOST, SMTP_USER, SMTP_PASS in .env setzen.' });
  }

  const docxPath = path.join(CONFIG.OUTPUT_DIR, `${sessionId}.docx`);
  if (!fs.existsSync(docxPath)) {
    return res.status(404).json({ error: 'DOCX nicht gefunden – bitte zuerst Transkription starten' });
  }

  const today = new Date().toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  try {
    await smtpTransport.sendMail({
      from: `"BauDiktat" <${CONFIG.SMTP_FROM}>`,
      to,
      subject: subject || `BauDiktat – Baustellenprotokoll ${today}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#333;max-width:600px">
          <h2 style="color:#e09a1a;margin-bottom:4px">BauDiktat – Baustellenprotokoll</h2>
          <p style="color:#888;font-size:13px;margin-top:0">${today}</p>
          ${message ? `<p>${message}</p>` : ''}
          <p>Im Anhang finden Sie das Baustellenprotokoll als Word-Dokument.</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
          <p style="font-size:11px;color:#999">
            Erstellt mit <strong>BauDiktat</strong> by ASKA<br>
            Sprache-zu-Dokument · Echtzeit-Diktat mit Fotos
          </p>
        </div>
      `,
      attachments: [{
        filename: `BauDiktat_Bericht_${today.replace(/\./g, '-')}.docx`,
        path: docxPath,
      }],
    });

    console.log(`[Mail] Gesendet an ${to}`);
    res.json({ success: true, to });

  } catch (err) {
    console.error('[Mail] Fehler:', err.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden: ' + err.message });
  }
});

// ── WebSocket: Azure Speech Echtzeit-Streaming ──────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] Client verbunden');
  let recognizer = null;
  let pushStream = null;

  ws.on('message', (data, isBinary) => {
    // Binärdaten = PCM-Audio an Azure weiterleiten
    // WICHTIG: Nur isBinary prüfen, nicht Buffer.isBuffer()
    // ws-Library liefert data IMMER als Buffer, auch für Text-Frames
    if (isBinary) {
      if (pushStream) {
        pushStream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return;
    }

    // JSON-Steuernachrichten
    try {
      const msg = JSON.parse(data.toString());
      console.log('[WS] Nachricht empfangen:', msg.type);

      if (msg.type === 'stream-start') {
        if (!useAzure) {
          ws.send(JSON.stringify({
            type: 'fallback',
            message: 'Azure nicht konfiguriert – Whisper Rolling Chunks aktiv',
          }));
          return;
        }

        try {
        // Azure PushStream erstellen (16kHz, 16-bit, Mono)
        const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        pushStream = sdk.AudioInputStream.createPushStream(format);
        const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

        const speechConfig = sdk.SpeechConfig.fromSubscription(
          CONFIG.AZURE_SPEECH_KEY, CONFIG.AZURE_SPEECH_REGION
        );
        speechConfig.speechRecognitionLanguage = 'de-DE';
        speechConfig.requestWordLevelTimestamps();
        speechConfig.outputFormat = sdk.OutputFormat.Detailed;

        recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

        // Teilergebnisse – Text erscheint wortweise
        recognizer.recognizing = (s, e) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'partial',
              text: e.result.text,
            }));
          }
        };

        // Endergebnis mit Word-Level Timestamps
        recognizer.recognized = (s, e) => {
          if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
            let words = [];
            try {
              const detailed = JSON.parse(
                e.result.properties.getProperty(
                  sdk.PropertyId.SpeechServiceResponse_JsonResult
                )
              );
              words = (detailed.NBest?.[0]?.Words || []).map(w => ({
                word: w.Word,
                start: w.Offset / 10000000,
                end: (w.Offset + w.Duration) / 10000000,
              }));
            } catch (parseErr) {
              console.warn('[Azure WS] Word parse error:', parseErr.message);
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'final',
                text: e.result.text,
                words,
              }));
            }
          }
        };

        recognizer.canceled = (s, e) => {
          if (e.reason === sdk.CancellationReason.Error) {
            console.error('[Azure WS] Error:', e.errorDetails);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: e.errorDetails }));
            }
          }
        };

        recognizer.startContinuousRecognitionAsync(
          () => {
            console.log('[Azure WS] Erkennung gestartet');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ready' }));
            }
          },
          (err) => {
            console.error('[Azure WS] Start-Fehler:', err);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: String(err) }));
            }
          }
        );

        } catch (azureErr) {
          console.error('[Azure WS] Setup-Fehler:', azureErr.message || azureErr);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Azure Setup fehlgeschlagen: ' + (azureErr.message || String(azureErr)),
            }));
          }
        }
      }

      if (msg.type === 'stream-stop') {
        if (pushStream) { pushStream.close(); pushStream = null; }
        if (recognizer) {
          recognizer.stopContinuousRecognitionAsync(
            () => {
              console.log('[Azure WS] Erkennung gestoppt');
              recognizer.close();
              recognizer = null;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'stopped' }));
              }
            },
            (err) => {
              console.error('[Azure WS] Stop-Fehler:', err);
              if (recognizer) { recognizer.close(); recognizer = null; }
            }
          );
        } else {
          ws.send(JSON.stringify({ type: 'stopped' }));
        }
      }

      // Whisper-Fallback: chunk per WebSocket (alt, ohne Azure)
      if (msg.type === 'chunk') {
        const audioBuffer = Buffer.from(msg.audio, 'base64');
        const chunkPath = path.join(CONFIG.UPLOAD_DIR, `ws-chunk-${uuidv4()}.wav`);
        fs.writeFileSync(chunkPath, audioBuffer);

        runWhisper(chunkPath, CONFIG.WHISPER_MODEL_REALTIME).then(result => {
          const words = (result.words || []).map(w => ({
            ...w,
            start: w.start + (msg.offset || 0),
            end:   w.end   + (msg.offset || 0),
          }));
          fs.unlinkSync(chunkPath);

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'final',
              text: result.text?.trim() || '',
              words,
            }));
          }
        }).catch(err => {
          console.error('[WS Whisper]', err);
          if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        });
      }

    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client getrennt');
    if (pushStream) { pushStream.close(); pushStream = null; }
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(
        () => recognizer.close(),
        () => recognizer.close()
      );
      recognizer = null;
    }
  });
});

// ── Server starten ───────────────────────────────────────────────────────────

server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  ASKA BauDiktat Backend                  ║
║  http://localhost:${CONFIG.PORT}                  ║
║                                          ║
║  Speech:  ${(useAzure ? 'Azure (' + CONFIG.AZURE_SPEECH_REGION + ')' : 'Whisper (lokal)').padEnd(30)}║
║  Fallback: ${(useAzure ? 'Whisper ' + CONFIG.WHISPER_MODEL_FINAL : '—').padEnd(29)}║
║  PWA:     ../pwa (statisch)              ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
