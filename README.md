# 🎬 Media Monitor

A self-hosted media library manager with automatic file watching, rich notifications, GPU-accelerated encoding, and AI-powered subtitle translation — all wrapped in a modern web UI.

Built for Plex, Jellyfin, and any folder-based media server.

---

## 📸 Screenshots

<!-- Screenshot: Library view showing the compact toolbar, filters, scan action, queue, and logs -->
![Library](docs/screenshots/library.png)

<!-- Screenshot: Settings view showing notifications, poster lookup, OpenAI, and file-status rules -->
![Settings](docs/screenshots/settings.png)

### Local UI preview with fictional media

Build the dashboard with `cd frontend` and `pnpm build`, then run `python scripts/preview.py`
from the repository root. Open [the local preview](http://127.0.0.1:5001) to browse 14 fictional
movies and 24 episodes across four shows. Preview state is isolated under `config/settings-preview/`;
the script uses a temporary demo sign-in, creates no media files, and starts no media workers.
Demo operations can be queued but do not execute. Run this loopback-only preview for local UI work.

Track language pickers search the [Library of Congress ISO 639-2 catalog](https://www.loc.gov/standards/iso639-2/php/code_list.php)
by name, three-letter code, or two-letter/bibliographic alias. Existing unlisted codes remain visible.
See the [Library UX review](docs/ux/library/review.md) for captured findings and follow-up ideas.

---

## ✨ Features

### 📡 File Watching & Notifications
- Monitors a directory (recursively) for new `.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`, `.m2ts`, `.mts`, `.mpg`, `.mpeg`, `.vob`, `.webm`, `.wmv`, `.flv`, and `.3gp` files
- Waits for file stability before processing (configurable checks to detect when a copy finishes)
- Sends rich notifications via **Ntfy** and/or **Discord** (with poster art, codec details, and status)
- Classifies every file as `OK`, `REMUX` (missing language tags), or `RE-ENCODE` (above size threshold)
- SQLite-backed deduplication — no duplicate notifications on restart

### 🖥️ Media Library Browser
- Opens by default when you load the app
- Browse your entire library in a sortable, filterable table
- **Movies** view — one row per movie folder
- **Shows** view — grouped by show → season → episode tree
- Compact library totals show total files and size beside the Movies/Shows switch
- Filter by status: All · Needs Encoding · Needs Remux · Missing Language · Queued · Done · Alerts
- Per-file details: resolution, video codec, audio tracks with language tags, subtitle tracks, file size
- Inline estimated post-encode size for files that haven't been encoded yet
- **Re-scan folder** button per movie/show to refresh metadata on demand
- Empty library shows a prominent **Scan Library** button to get started quickly

### ⚡ GPU-Accelerated Encoding
- One-click queue to re-encode any file to HEVC (H.265) using NVIDIA NVENC
- In-place encoding: the original file is replaced on success
- Live progress: percentage, encoding speed, and estimated time remaining
- Automatic detection of stuck jobs with timeout recovery
- Cancel any queued or in-progress job
- Shows file size savings after completion

> **Requires an NVIDIA GPU and the NVIDIA Container Toolkit.** CPU encoding is not currently supported but is planned for a future release.

See [docs/encoding.md](docs/encoding.md) for full details.

### 💬 Subtitle Translation
- Translate any subtitle track to **Cuban Spanish** using the OpenAI API
- **Text subtitles** (SRT, ASS, SSA): extracted directly and sent to the model
- **Image subtitles** (PGS / Blu-ray): OCR'd first with Tesseract (using the track's language tag to pick the right language pack), then translated
- Output is saved as a `.es.srt` file alongside the video **and** muxed into the MKV as a new track
- Job queue with live progress and per-step status (`extracting` → `ocr` → `translating` → `muxing`)
- Requires an OpenAI API key (uses `gpt-4o-mini` by default, configurable)

> The target translation language is currently hardcoded to **Cuban Spanish**. Support for configuring the target language from the UI is planned for a future release.

See [docs/subtitle-translation.md](docs/subtitle-translation.md) for full details.

### ✨ Fix Anime
- Movie, episode, full-season, full-show, and selected-file actions
- Saved ASS styles with a live ffmpeg/libass preview
- Preserve PGS text regions, source placement, and timed position changes through OCR and translation
- Keep selected audio/subtitle languages; remux away unwanted tracks
- Translate a missing target language with the configured AI provider, or convert kept subtitles to ASS without translation
- All library video formats accepted; automatic MKV remuxing for ASS with output verification and queue progress

See [docs/fix-anime.md](docs/fix-anime.md) for behavior and requirements.

### 📎 External Subtitle Muxing
- Movies with no subtitle tracks get a **Mux Subtitle File** action in their ··· menu
- Scans the movie's directory for `.srt`, `.ass`, `.ssa`, `.vtt`, or `.sub` files
- Select the file and language from a dialog — job is queued immediately and runs through the same encode worker
- In-place operation: video and audio are never re-encoded, only the container is rewritten
- New subtitle track is reflected in the library as soon as the job completes

See [docs/media-library.md](docs/media-library.md) for full details.

### 🔤 Language Filtering (Encoding)
During encoding, only tracks in the approved language sets are kept in the output file:

| Track type | Kept languages |
|---|---|
| Audio | English · Spanish · Japanese |
| Subtitles | English · Spanish |

For audio, only the **highest-quality** track per language is kept (e.g. TrueHD is kept over AC-3 for the same language). All other tracks are dropped from the encoded output.

> These language lists are currently hardcoded. Per-user configuration from the UI is planned for a future release.

### 📊 Real-Time Logs
- In-app log viewer streamed from the backend
- Level filtering (info / warn / error)
- Collapsible panel in the Library view

---

## 🖥️ Requirements

| Requirement | Notes |
|---|---|
| Docker + Docker Compose | Any recent version |
| NVIDIA GPU | Required for encoding (NVENC). GTX 10xx or newer recommended |
| NVIDIA Container Toolkit | Required for GPU access inside Docker — [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) |
| OpenAI API key | Required only for subtitle translation |
| Ntfy / Discord webhook | Required only for notifications |

> If you do not intend to use encoding, an NVIDIA GPU is not required — the rest of the application (file watching, notifications, library browser, subtitle translation) works on any machine.

---

## 🚀 Quick Start

Media Monitor ships as a single image — the Next.js dashboard is built as
static files and served directly by the Flask backend, so there's one
container and one port.

### Option A — Docker Hub (recommended)

No build step required. Pull the pre-built image and start.

**1. Create a `docker-compose.yml`** (or download the one from this repo):

```yaml
services:
  media-monitor:
    image: ivanchelo/media-monitor:latest
    container_name: media-monitor
    restart: unless-stopped
    ports:
      - "5000:5000"
    volumes:
      - /path/to/your/media:/watch        # read/write — needed for in-place encoding
      - ./config:/config                   # persistent config, database, and auth state
    environment:
      - WATCH_DIR=/watch
      - PORT=5000
      - MAX_WORKERS=4
      - STABILIZE_INTERVAL=10
      - STABILIZE_CHECKS=3
      - REENCODE_SIZE_GB=20               # files larger than this are flagged RE-ENCODE

      # Set these here or through the web UI after first launch:
      # - NTFY_SERVER=https://ntfy.sh
      # - NTFY_TOPIC=my-media-notifications
      # - DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
      # - OPENAI_API_KEY=sk-...
      # - OPENAI_MODEL=gpt-4o-mini
      # - TVDB_API_KEY=your-tvdb-key

      # Auth — see "Authentication" below
      # - COOKIE_SECURE=true               # set this if served over HTTPS
      # - WEBAUTHN_RP_ID=media.example.com # only needed if you use more than one hostname

    deploy:
      resources:
        reservations:
          devices:
            - count: all
              capabilities: [gpu, video]   # remove if no NVIDIA GPU
```

**2. Start the stack:**

```bash
docker compose up -d
```

**3. Open the UI at [http://localhost:5000](http://localhost:5000)** and create the admin account on first launch.

---

### Option B — Build from Source

```bash
# Clone the repository
git clone https://github.com/your-username/media-monitor.git
cd media-monitor

# Build, then start with the image you just built
docker build -t ivanchelo/media-monitor:latest .
docker compose up -d
```

> **Note on build time:** The image installs `tesseract-ocr-all` (all language packs for OCR, ~1 GB) and builds the frontend in its own Node stage. First builds will take several minutes depending on your connection.
>
> On every push to `main`, a GitHub Actions workflow builds and publishes this image to Docker Hub automatically — Option A pulls that, so you only need this if you're testing local changes before they're pushed.

---

## ⚙️ Configuration

### Web UI

All settings can be configured from the **Settings** view after first launch:

Use the section navigation for **AI translation**, **Notifications**, **Library**, and **Account & security**.
Configuration toggles and selections apply immediately; text and number fields save after a short typing pause.
The save indicator shows pending changes, successful saves, and failures with a retry action. Invalid fields
show an inline message and are not submitted. Changing library rules automatically refreshes file statuses.
Password changes and passkey actions use their own explicit buttons.

| Setting | Description |
|---|---|
| **Ntfy server + topic** | Push notifications to your phone via the ntfy app |
| **Discord webhook** | Rich embed notifications to a Discord channel |
| **OpenAI API key** | Required for subtitle translation |
| **OpenAI model** | Default: `gpt-4o-mini`. Use `gpt-4o` for higher accuracy |
| **TVDB API key** | Optional — fetch poster art for notification embeds |

Settings are persisted to `/config/config.json` inside the container and survive restarts.

### Environment Variables

All environment variables can also be set directly in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `WATCH_DIR` | `/watch` | Directory to monitor for new files |
| `PORT` | `5000` | Backend API port (internal) |
| `MAX_WORKERS` | `4` | Parallel file processing threads |
| `STABILIZE_INTERVAL` | `10` | Seconds between file size checks |
| `STABILIZE_CHECKS` | `3` | Consecutive stable checks before processing |
| `REENCODE_SIZE_GB` | `20` | Files above this size (GB) are flagged RE-ENCODE |
| `NTFY_SERVER` | — | e.g. `https://ntfy.sh` |
| `NTFY_TOPIC` | — | Your ntfy topic name |
| `DISCORD_WEBHOOK` | — | Full Discord webhook URL |
| `OPENAI_API_KEY` | — | OpenAI API key for subtitle translation |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model to use |
| `TVDB_API_KEY` | — | TheTVDB API key for poster art |
| `DB_FILE` | `/config/processed.db` | SQLite database path |
| `CONFIG_FILE` | `/config/config.json` | Config file path |
| `AUTH_FILE` | `/config/auth.json` | Admin username/password hash + MFA setting |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS so session cookies get the `Secure` flag |
| `WEBAUTHN_RP_ID` | _(auto)_ | Passkey relying-party ID. Auto-detected from the request's hostname — set this only if you access the dashboard under more than one hostname |

---

## 🔐 Authentication

The dashboard requires sign-in. On first launch you'll be asked to create a single admin
username/password — there's no multi-user support, this is a single-household tool.

From **Settings → Account & Security** you can:
- Change the admin password
- Register one or more **passkeys** (a hardware security key, your phone, or your OS's
  biometrics/PIN) via WebAuthn
- Require a passkey as a second factor after your password, once at least one is registered

> Passkeys are bound to the hostname you register them under — a Tailscale IP one day and a
> hostname the next will not share a passkey. Register from the same hostname you'll sign in
> from, and use `WEBAUTHN_RP_ID` if you need one passkey to work across equivalent hostnames.
> WebAuthn also requires a secure context (HTTPS, or `localhost`) — plain HTTP over a LAN IP
> won't be able to complete the passkey step.

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────┐
│  Media Monitor  (port 5000)                        │
│  Python 3.11 · Flask · waitress                    │
│                                                     │
│  ┌─ Static dashboard (Next.js SPA, pre-built)      │
│  ├─ Auth (password + optional passkey/WebAuthn MFA)│
│  ├─ File watcher (watchdog)                        │
│  ├─ Media analyzer (ffprobe)                       │
│  ├─ Encode worker (ffmpeg/NVENC)                    │
│  ├─ Translate worker (OpenAI / local AI)            │
│  ├─ OCR engine (Tesseract)                          │
│  └─ SQLite database                                 │
└───────────────────────────────────────────────────┘
                       │
              /watch volume
        (your media directory)
```

**Backend workers run in separate threads:**
- **File watcher** — detects new files, waits for stability, runs ffprobe
- **Encode worker** — sequential GPU encoding queue
- **Translation worker** — sequential OCR + translation queue

**Data flow for a new file:**
1. Watchdog detects the file
2. Stability check (waits for copy to finish)
3. ffprobe extracts full media metadata
4. Status determined: `OK` / `REMUX` / `RE-ENCODE`
5. Notification sent to Ntfy and/or Discord
6. Record written to SQLite

---

## 🔔 Setting Up Notifications

### Ntfy

1. Install the [ntfy app](https://ntfy.sh) on your phone
2. Choose a unique topic name (e.g. `my-library-abc123`)
3. Subscribe to the topic in the app
4. Enter the server URL and topic in **Settings**

### Discord

1. Open your Discord server settings → Integrations → Webhooks
2. Click **New Webhook**, choose a channel, copy the URL
3. Paste it in **Settings**

### TVDB (optional — poster art in notifications)

1. Create a free account at [thetvdb.com](https://thetvdb.com)
2. Go to [API Information](https://thetvdb.com/api-information) and get your API key
3. Enter it in **Settings**

---

## 📁 File Structure

```
.
├── app.py                    # Flask API, auth, file watcher, workers — serves the built frontend too
├── requirements.txt          # Python dependencies
├── Dockerfile                # Multi-stage: builds frontend/ (Node), then the Python runtime image
├── docker-compose.yml        # Production stack (single image, Docker Hub)
├── entrypoint.sh             # Container entrypoint
├── frontend/
│   ├── app/
│   │   └── page.tsx          # Main page (Library + Settings views)
│   ├── components/
│   │   └── media-monitor/    # All UI components (incl. auth-gate, account-security-card)
│   ├── next.config.mjs       # output: 'export' — static SPA, no Node needed at runtime
│   └── package.json
├── config/                   # Created automatically on first run
│   ├── config.json           # Saved settings
│   ├── auth.json             # Admin credentials (hashed) + MFA setting
│   └── processed.db          # SQLite database (incl. registered passkeys)
└── docs/
    ├── current_state.md      # Project state and known gaps
    ├── encoding.md           # Encoding feature walkthrough
    ├── subtitle-translation.md  # Subtitle translation + OCR walkthrough
    └── media-library.md      # Library browser guide
```

---

## 🗺️ Roadmap

- [ ] Configurable target translation language (currently hardcoded to Cuban Spanish)
- [ ] Configurable approved audio/subtitle language lists in the UI
- [ ] CPU encoding fallback (software HEVC via libx265)
- [ ] VOBSUB (DVD subtitle) OCR support
- [ ] Batch encode/translate from the UI
- [ ] Multi-user accounts (currently a single admin account)
- [ ] Retry logic for failed notifications
- [ ] File logging (complement in-memory log buffer)

---

## 🐛 Troubleshooting

**Files not detected:**
- Verify the volume mount in `docker-compose.yml` (`/path/to/your/media:/watch`)
- Check that the file extension is supported (`.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`, `.m2ts`, `.mts`, `.mpg`, `.mpeg`, `.vob`, `.webm`, `.wmv`, `.flv`, `.3gp`)
- Check container logs: `docker logs media-monitor`

**Encoding fails immediately:**
- Confirm your NVIDIA driver is installed on the host: `nvidia-smi`
- Confirm the NVIDIA Container Toolkit is installed and configured
- Check that the `deploy.resources` block is present in `docker-compose.yml`
- Encoding logs appear in the in-app log viewer (Library → Logs)

**Translation not starting:**
- Verify your OpenAI API key is saved in **Settings**
- Check your OpenAI account has available credits
- For PGS OCR jobs: the `ocr` phase runs before translation — progress will show "OCR frame N/N" first

**Locked out / passkey won't verify at login:**
- Passkeys only validate under the hostname they were registered with (see "Authentication"
  above) — if you changed how you access the dashboard, sign in with your password and register
  a new passkey from the new hostname
- If you're fully locked out, stop the container and remove the `require_passkey_mfa` setting
  from `config/auth.json`, or delete `config/auth.json` entirely to redo first-run setup
  (you'll lose the saved admin account, but not your library data)

**Container logs:**
```bash
docker logs media-monitor -f
```

---

## 🤝 Contributing

Issues and pull requests are welcome. For significant changes please open an issue first to discuss what you'd like to change.

---

## 📝 License

MIT License — Copyright (c) 2025 Ivan Ramirez Comas. See [LICENSE](LICENSE) for details.

---

*Made with ❤️ for media enthusiasts*
