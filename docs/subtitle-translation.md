# Subtitle Translation

Media Monitor can translate subtitle tracks to **Cuban Spanish** using the OpenAI API. Both text-based and image-based (Blu-ray PGS) subtitles are supported through a unified workflow that auto-detects the track type.

---

## Requirements

| Requirement | Notes |
|---|---|
| OpenAI API key | Set in Settings or via `OPENAI_API_KEY` env var |
| OpenAI model | Default `gpt-4o-mini`; configurable in Settings |
| Tesseract OCR | Pre-installed in the Docker image (`tesseract-ocr-all`) — no action needed |

> The target translation language is currently hardcoded to **Cuban Spanish**. Configurable target language support is planned for a future release.

---

## Supported Subtitle Types

| Type | Codecs | Method |
|---|---|---|
| Text subtitles | SRT, ASS, SSA, WebVTT | Extracted directly → sent to OpenAI |
| Image subtitles | PGS (`hdmv_pgs_subtitle`) | OCR'd with Tesseract → then translated |

---

## How to Translate a Subtitle

1. Open the **Library** view
2. Find the file — files with `RE-ENCODE` or `OK` status often have multiple subtitle tracks
3. Click the **···** menu on the row
4. You will see one entry per translatable subtitle track:
   - Text tracks show **"Translate #N (ENG)"**
   - PGS/image tracks show **"OCR + Translate #N (ENG)"**
5. Click the entry to queue the job
6. Progress appears in the **Translation Queue** section of the Encode Queue panel

---

## The Translation Pipeline

### Text Subtitles

```
Extract SRT via ffmpeg
        ↓
Chunk into blocks of ≤ 350 subtitles
        ↓
Send each chunk to OpenAI (with source language context)
        ↓
Assemble translated SRT
        ↓
Save .es.srt alongside the video
        ↓
Mux into MKV as a new subtitle track (original preserved)
```

### Image Subtitles (PGS OCR)

```
Extract .sup (raw PGS stream) via ffmpeg
        ↓
Parse PGS binary format
  • PCS: display timestamps
  • PDS: palette (YCbCr → RGBA)
  • ODS: RLE-encoded bitmap
        ↓
Decode each frame to a PIL RGBA image
        ↓
Smart pre-processing (only when needed):
  • Composite RGBA on black background
  • Invert if background is dark (common for Blu-ray PGS)
  • Autocontrast if dynamic range is narrow (std-dev < 55)
  • 2× upscale if text height < 50 px
        ↓
Tesseract OCR using the track's MKV language tag
  (e.g. English PGS → tesseract eng, Spanish PGS → tesseract spa)
        ↓
Build SRT from OCR text + display timestamps
        ↓
Translate SRT via OpenAI (same as text path above)
        ↓
Save .es.srt alongside the video
        ↓
Mux into MKV as a new subtitle track (original PGS preserved)
```

---

## Job Statuses

| Status | Meaning |
|---|---|
| `pending` | Waiting in queue |
| `extracting` | ffmpeg extracting the subtitle stream |
| `ocr` | Tesseract OCR in progress (image tracks only) |
| `translating` | Sending chunks to OpenAI |
| `muxing` | ffmpeg adding the new track to the MKV |
| `done` | Complete — `.es.srt` saved and track muxed |
| `failed` | Error — see the in-app logs for details |

---

## Output Files

For a file named `Movie.mkv`, translation produces:
- **`Movie.es.srt`** — standalone Spanish SRT file in the same folder
- The MKV is updated to include the new Spanish SRT as an additional subtitle track

The original subtitle track (whether text or PGS) is **always preserved** — the new track is added alongside it.

---

## Language Detection for OCR

Tesseract needs to know the source language to use the correct character set. Media Monitor reads the language tag from the MKV subtitle stream (`eng`, `spa`, `jpn`, etc.) and maps it to the corresponding Tesseract language pack.

All language packs are pre-installed via `tesseract-ocr-all`. If the MKV stream has no language tag or an unrecognised code, Tesseract falls back to English (`eng`).

---

## Chunking

Large subtitle files are automatically split into chunks of up to **350 blocks** before being sent to the OpenAI API. This keeps each API call within the model's context window and allows progress to be reported per chunk. The translated chunks are reassembled in order before being saved.

---

## Troubleshooting

**"OpenAI API key not configured":**
Set it in Settings or via the `OPENAI_API_KEY` environment variable.

**Translation job stuck on `ocr`:**
The OCR phase processes one frame at a time. A 2-hour movie with 2000 subtitle frames may take several minutes. Watch the progress detail in the queue panel — it shows "OCR frame N/N".

**Garbled OCR output:**
This can happen if the PGS track has unusual colours or very small text. The preprocessing pipeline handles the most common cases automatically. Check the in-app logs for any OCR warnings on specific frames.

**"OCR produced no readable text":**
The PGS track may be a forced subtitle track with very few frames, or the frames may be graphics (chapter cards, studio logos) rather than dialogue. If the track has actual dialogue and OCR is failing, check the logs for per-frame errors.

**Mux step fails:**
The mux writes a temporary file alongside the original. Ensure the `/watch` volume is mounted **read/write** (not read-only) in `docker-compose.yml`.
