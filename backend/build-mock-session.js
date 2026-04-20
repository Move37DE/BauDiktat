/**
 * Mock Session Builder — erzeugt eine Fake-Session mit perfektem Text
 * fuer Demo-Screenshots.
 *
 * Liest aus C:\Users\TiloSchlumberger\Desktop\mock-session.txt
 * und legt eine komplette Session im output/ Ordner ab.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createDocx } = require('./docx-generator');

const MOCK_FILE = 'C:\\Users\\TiloSchlumberger\\Desktop\\mock-session.txt';
const OUTPUT_DIR = path.join(__dirname, 'output');

function parseMockFile(content) {
  const lines = content.split(/\r?\n/);
  const result = { projectName: 'Baustelle', sections: [] };
  let current = null;
  let bildData = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PROJEKT:')) {
      result.projectName = trimmed.substring('PROJEKT:'.length).trim();
      continue;
    }
    const m = trimmed.match(/^\[(TEXT\d+|BILD\d+)\]$/);
    if (m) {
      if (current) result.sections.push(current);
      if (m[1].startsWith('TEXT')) {
        current = { type: 'text', text: '' };
      } else {
        current = { type: 'photo', path: '', caption: '' };
      }
      continue;
    }
    if (!current) continue;
    if (current.type === 'text') {
      if (trimmed) current.text += (current.text ? ' ' : '') + trimmed;
    } else if (current.type === 'photo') {
      if (trimmed.toLowerCase().startsWith('bildunterschrift:')) {
        current.caption = trimmed.substring('bildunterschrift:'.length).trim();
      } else if (trimmed && !current.path) {
        current.path = trimmed;
      }
    }
  }
  if (current) result.sections.push(current);
  return result;
}

async function build() {
  const raw = fs.readFileSync(MOCK_FILE, 'utf8');
  const parsed = parseMockFile(raw);
  console.log(`[Mock] Projekt: ${parsed.projectName}`);
  console.log(`[Mock] ${parsed.sections.length} Sektionen`);

  const sessionId = uuidv4();
  const photosDir = path.join(OUTPUT_DIR, `${sessionId}-photos`);
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

  // Fotos kopieren (als img_001.jpg, img_002.jpg, ...)
  const blocks = [];
  const blocksWithPaths = [];
  let photoIdx = 0;
  let runningTime = 0;

  for (const section of parsed.sections) {
    if (section.type === 'text') {
      // Geschaetzte Dauer: ~2.5 Sek pro Wort bei Diktat-Tempo
      const wordCount = section.text.split(/\s+/).length;
      runningTime += wordCount * 0.5;
      blocks.push({ type: 'text', text: section.text });
      blocksWithPaths.push({ type: 'text', text: section.text });
    } else if (section.type === 'photo') {
      photoIdx++;
      const destName = `img_${String(photoIdx).padStart(3, '0')}.jpg`;
      const destPath = path.join(photosDir, destName);
      fs.copyFileSync(section.path, destPath);
      console.log(`[Mock] Foto kopiert: ${section.path} -> ${destName}`);

      const photoBlock = {
        type: 'photo',
        photo: destName,
        timestamp: runningTime,
        caption: section.caption || '',
      };
      blocks.push(photoBlock);
      blocksWithPaths.push({ ...photoBlock, localPath: destPath });
      runningTime += 2;
    }
  }

  // Text fuer Session
  const fullText = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');

  // Session JSON
  const now = new Date();
  const timeFmt = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const dateFmt = now.toLocaleDateString('de-DE');
  const projectNameWithDate = `${parsed.projectName} (${dateFmt} ${timeFmt})`;

  const sessionJson = {
    sessionId,
    projectName: projectNameWithDate,
    date: now.toISOString(),
    dateFormatted: dateFmt,
    text: fullText,
    words: [],  // keine Timestamps -> keine Wort-Highlighting beim Mock
    blocks,
    photoFiles: Array.from({ length: photoIdx }, (_, i) => `img_${String(i + 1).padStart(3, '0')}.jpg`),
  };
  const sessionJsonPath = path.join(OUTPUT_DIR, `${sessionId}.json`);
  fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionJson, null, 2));
  console.log(`[Mock] Session-JSON: ${sessionJsonPath}`);

  // DOCX
  const docxPath = path.join(OUTPUT_DIR, `${sessionId}.docx`);
  await createDocx({
    blocks: blocksWithPaths,
    projectName: projectNameWithDate,
    date: dateFmt,
    sessionId,
    outputPath: docxPath,
  });
  console.log(`[Mock] DOCX: ${docxPath}`);

  console.log(`\n[Mock] FERTIG! Session-ID: ${sessionId}`);
  console.log(`[Mock] Korrekturplatz: http://localhost:3001/korrektur/${sessionId}`);
}

build().catch(err => {
  console.error('[Mock] Fehler:', err);
  process.exit(1);
});
