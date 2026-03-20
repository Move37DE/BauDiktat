/**
 * DOCX Generator – BauDiktat
 * Erzeugt ein professionelles Word-Dokument mit Text-Blöcken und Fotos
 * an den synchronisierten Stellen.
 */

const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  HeadingLevel, AlignmentType, BorderStyle,
  Table, TableRow, TableCell, WidthType,
  Header, Footer, PageNumber, NumberFormat,
} = require('docx');
const fs   = require('fs');
const path = require('path');

/**
 * Erstellt das DOCX-Dokument.
 * 
 * @param {Object} opts
 * @param {Array}  opts.blocks       – [{type:'text',text:...}, {type:'photo',localPath:...,caption:...}]
 * @param {string} opts.projectName  – Projektname für Header
 * @param {string} opts.date         – Datum
 * @param {string} opts.sessionId    – Session-ID für Footer
 * @param {string} opts.outputPath   – Zieldatei (.docx)
 */
async function createDocx({ blocks, projectName, date, sessionId, outputPath }) {

  const children = [];

  // ── Titelseite / Header-Block ──────────────────────────────────────────────
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Baudokumentation',
          bold: true,
          size: 36,
          color: '1a1a1a',
        }),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Projekt: ${projectName}`,
          size: 24,
          color: '444444',
        }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Datum: ${date}`,
          size: 22,
          color: '666666',
        }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Session: ${sessionId}`,
          size: 18,
          color: '999999',
        }),
      ],
      spacing: { after: 400 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'dddddd' },
      },
    }),
  );

  // ── Diktat-Blöcke mit Fotos ────────────────────────────────────────────────
  for (const block of blocks) {

    if (block.type === 'text') {
      // Text-Absatz
      // Lange Texte in Sätze aufteilen für bessere Lesbarkeit
      const sentences = block.text
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0);

      for (const sentence of sentences) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: sentence,
                size: 24,          // 12pt
                font: 'Calibri',
                color: '1a1a1a',
              }),
            ],
            spacing: { after: 120, line: 320 },
          }),
        );
      }

    } else if (block.type === 'photo') {
      // Foto einfügen
      children.push(...buildPhotoBlock(block));
    }
  }

  // ── Dokument zusammenbauen ─────────────────────────────────────────────────
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1800, right: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: `ASKA BauDiktat  |  ${projectName}  |  ${date}`,
                  size: 16,
                  color: '999999',
                }),
              ],
              border: {
                bottom: { style: BorderStyle.SINGLE, size: 1, color: 'eeeeee' },
              },
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: 'Seite ', size: 16, color: '999999' }),
                new TextRun({
                  children: [PageNumber.CURRENT],
                  size: 16, color: '999999',
                }),
                new TextRun({ text: ' von ', size: 16, color: '999999' }),
                new TextRun({
                  children: [PageNumber.TOTAL_PAGES],
                  size: 16, color: '999999',
                }),
                new TextRun({
                  text: `   |   ASKA Automation · aska.de`,
                  size: 16, color: 'bbbbbb',
                }),
              ],
              alignment: AlignmentType.RIGHT,
            }),
          ],
        }),
      },
      children,
    }],
  });

  // ── Speichern ──────────────────────────────────────────────────────────────
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`[DOCX] Gespeichert: ${outputPath} (${Math.round(buffer.length/1024)} KB)`);
  return outputPath;
}

/**
 * Baut den Foto-Block auf:
 * Bild in voller Breite + Zeitstempel-Caption + Trennlinie
 */
function buildPhotoBlock(block) {
  const paragraphs = [];

  // Abstand vor Foto
  paragraphs.push(new Paragraph({ spacing: { before: 200 } }));

  // Foto-Label
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `📷  Foto – ${block.photo}  [${formatTime(block.timestamp)}]`,
          bold: true,
          size: 20,
          color: 'b06010',
        }),
      ],
      spacing: { after: 80 },
    }),
  );

  // Bild einfügen (falls Datei vorhanden)
  if (block.localPath && fs.existsSync(block.localPath)) {
    try {
      const imgBuffer = fs.readFileSync(block.localPath);
      const ext = path.extname(block.localPath).toLowerCase().replace('.', '');
      const mediaType = ext === 'jpg' ? 'jpeg' : ext;

      paragraphs.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: imgBuffer,
              transformation: {
                width:  560,   // ~15cm bei 96dpi
                height: 420,   // 4:3 Verhältnis
              },
              type: mediaType,
            }),
          ],
          spacing: { after: 100 },
        }),
      );
    } catch (err) {
      console.warn('[DOCX] Bild konnte nicht eingebettet werden:', block.localPath, err.message);
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[Bild nicht verfügbar: ${block.photo}]`,
              size: 18, color: 'cc4444', italics: true,
            }),
          ],
        }),
      );
    }
  }

  // Caption (falls vorhanden)
  if (block.caption) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: block.caption,
            size: 18,
            italics: true,
            color: '666666',
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
      }),
    );
  }

  // Trennlinie nach Foto
  paragraphs.push(
    new Paragraph({
      spacing: { after: 200 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'eeeeee' },
      },
    }),
  );

  return paragraphs;
}

function formatTime(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

module.exports = { createDocx };
