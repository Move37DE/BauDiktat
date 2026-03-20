# ASKA BauDiktat

Digitales Diktat mit Foto-Dokumentation für die Baustelle.
Architekten sprechen, fotografieren, und bekommen ein fertiges DOCX.

---

## Voraussetzungen

- Node.js 18+
- **Azure Speech Account** (Key + Region) – primäre Spracherkennung
- Optional: Whisper als Fallback (`pip install openai-whisper`)
- Optional: `pip install faster-whisper` (4-6x schneller auf GPU)

---

## Projektstruktur

```
baudiktat/
  backend/
    server.js          – Express, Azure Speech Streaming, Whisper-Fallback
    docx-generator.js  – DOCX-Export mit Foto-Einbettung, Header/Footer
    package.json
  pwa/
    index.html         – Komplette App-UI (4 Screens)
    app.js             – Azure Echtzeit-Streaming, Kamera, Segmente
    sw.js              – Service Worker
    manifest.json
  .env.example         – Konfiguration (Azure Key, Region, etc.)
  README.md
```

---

## Installation & Start

### 1. .env anlegen

```bash
cp .env.example .env
# Dann .env bearbeiten und Azure-Schlüssel eintragen:
#   AZURE_SPEECH_KEY=dein-key-hier
#   AZURE_SPEECH_REGION=westeurope
```

### 2. Backend starten

```bash
cd backend
npm install
node server.js
# → läuft auf http://localhost:3001
# → PWA wird automatisch aus ../pwa/ ausgeliefert
```

### 3. Auf dem Handy öffnen

```
Handy und Workstation im gleichen WLAN:
→ http://192.168.x.x:3001

Auf dem Handy (Chrome/Safari):
→ "Zum Homescreen hinzufügen" → läuft wie eine native App
```

### HTTPS für Mikrofon/Kamera (wichtig!)

Mikrofon + Kamera im Browser benötigen **HTTPS** oder `localhost`.
Für LAN-Betrieb die einfachste Lösung:

```bash
# ngrok installieren: https://ngrok.com
ngrok http 3001
# → gibt eine https-URL die auf dem Handy funktioniert
```

Alternative: Selbst-signiertes Zertifikat mit `mkcert`:
```bash
mkcert -install
mkcert 192.168.x.x localhost
# → .pem Dateien in server.js als HTTPS einbinden
```

---

## Architektur

```
Handy (PWA)                    ASKA Workstation
───────────────                ─────────────────────────────
Mikrofon (AudioContext 16kHz)  Node.js Backend (port 3001)
  ↓ PCM via WebSocket              ↓
  WS stream-start/audio  →    Azure Speech Echtzeit-Streaming
  ← partial (wortweise)           ↓ Text erscheint sofort
  ← final + Word-Timestamps       ↓ Wort-für-Wort im Segment

Foto (getUserMedia)
  ↓ nach Review
  POST /finalize          →    Azure Speech (oder Whisper Fallback)
  + Fotos (multipart)          ↓ Timestamp-Synchronisierung
  ← Download-URL               ↓ DOCX generieren
                               ↓ /output/session-id.docx
  GET /download/:id       ←    DOCX mit Fotos an richtiger Stelle
```

**Fallback:** Wenn `AZURE_SPEECH_KEY` nicht gesetzt ist, wechselt das System
automatisch zu Whisper Rolling Chunks (alle 7s, lokale GPU).

---

## Timestamp-Synchronisierung (Kernlogik)

```
Audio:   [Riss(11.8s)] [Außenwand(12.2s)] | [hier(12.9s)] [dokumentiert(13.4s)]
                                           ↑
                                    Foto-Marker bei 12.4s

→ DOCX:  "…Riss an der Außenwand [Foto img_001.jpg] hier dokumentiert…"
```

Azure/Whisper gibt Word-Level Timestamps zurück → jedes Wort hat Start/End-Zeit.
Der Foto-Marker bei t=12.4s liegt zwischen "Außenwand" und "hier".
→ Foto wird genau dort eingefügt.

---

## Datenschutz

- Azure Speech: Audio wird an Microsoft Azure gesendet (Region konfigurierbar)
- Whisper-Fallback läuft **lokal** – Audio verlässt das Firmennetz nicht
- Fotos werden nach DOCX-Generierung vom Server gelöscht
- Für extra Sicherheit: Backend nur im lokalen WLAN erreichbar

---

## Nächste Schritte

- [ ] E-Mail-Versand (nodemailer)
- [ ] Benutzer-Login (mehrere Architekten)
- [ ] Projektverwaltung (mehrere Baustellen)
- [ ] Dragon Medical One Integration
- [ ] React Native App (App Store)
