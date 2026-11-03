# Subtitle Translation

Media Monitor translates subtitle tracks to your selected language using OpenAI
or a local OpenAI-compatible server such as Ollama. Text subtitles and Blu-ray
PGS image subtitles share the same translation workflow.

---

## Requirements

| Requirement | Notes |
|---|---|
| Target language | Choose in Settings → AI translation; no default language |
| AI provider | OpenAI API key, or a reachable local AI server and installed model |
| OpenAI model | Default `gpt-4o-mini`; configurable in Settings |
| Tesseract OCR | Pre-installed in the Docker image (`tesseract-ocr-all`) — no action needed |

## Translation preferences

In **Settings → AI translation**, configure:

- **Target language:** choose from the searchable ISO language catalog. New
  installations and older configurations without an explicit choice start unset.
  Translation requests are rejected with an actionable message until a language
  is selected. Extraction/OCR downloads still work without a translation language.
- **Regional style or dialect:** optional free text, such as Cuban, Canadian,
  or Brazilian, where applicable to the selected language. Blank requests natural
  dialogue without a regional preference; there is no built-in Cuban style.
- **Translation instructions:** optional tone, terminology, names, and character
  context, up to 4000 characters. These are sent with every chunk, so keep them concise.
- **Provider and model:** OpenAI, or a local compatible server. A local server URL
  must be reachable from the NAS/container and end in `/v1`, for example
  `http://YOUR-PC-IP:11434/v1`. Test connection loads available model suggestions.
- **Blocks per request:** configurable separately for each backend.
- **Temperature:** 0–2, default 0.3, to control variation in wording. The selected
  model must support the temperature parameter.
- **Local thinking mode:** model default, off, low, medium, or high. Default sends
  no thinking parameter. Other choices send `reasoning_effort` to the compatible
  server; off sends `none`. Support depends on the model and server version, and
  unsupported levels may be ignored or rejected. This setting does not affect OpenAI.
- **Reuse completed chunks:** enable or disable the persistent 30-day cache.
  **Clear saved translations** removes existing entries; active requests can save
  new entries after clearing.

Use instruction-following models that can return the required JSON cue format.
Translation specialists such as TranslateGemma require a different prompt
contract and are not automatically adapted by these settings.

Language, style, provider, model, chunk size, temperature, thinking mode, and cache
preference are captured when each job is queued. Later settings changes apply to
new jobs. Credentials are read from the configured provider and are not copied
into job snapshots. Old jobs without a snapshot use the current explicit settings
when they start; jobs without a language fail clearly rather than assuming one.

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
Send cue IDs + dialogue to the configured AI backend (with source language context)
        ↓
Validate cue IDs and rebuild SRT using original numbers + timestamps
        ↓
Save .<language>.srt alongside the video
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
Save .<language>.srt alongside the video
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
| `done` | Complete — translated track muxed; temporary sidecar removed |
| `failed` | Error — see the in-app logs for details |

---

## Output Files

For `Movie.mkv` translated to French, the worker writes **`Movie.fra.srt`** and
adds it to the MKV with the `fra` language tag and a French track title. A chosen
regional style is included in the track title. After successful muxing, the
sidecar is removed unless **Settings → Output files → Keep translated sidecar
after muxing** is on. If muxing fails, the translated sidecar remains available.
With **Write separate output**, the track is added to a new copy of the video
and the original file is left untouched.
An existing sidecar at the output path is never overwritten; rename it before
creating a new translation.

The original subtitle track (whether text or PGS) is **always preserved** — the new track is added alongside it.

---

## Language Detection for OCR

Tesseract needs to know the source language to use the correct character set. Media Monitor reads the language tag from the MKV subtitle stream (`eng`, `spa`, `jpn`, etc.) and maps it to the corresponding Tesseract language pack.

All language packs are pre-installed via `tesseract-ocr-all`. If the MKV stream has no language tag or an unrecognised code, Tesseract uses the **Fallback OCR language** from Settings → AI translation (English by default). To fix a track whose tag is wrong, pass `ocr_lang` (for example `"jpn"`) when queueing a translation or extraction. That override is saved with the job.

**OCR mode** (Fast, Standard, or Accurate) controls how much small text is
enlarged before recognition. Accurate is slower but better for small or thin fonts.

---

## Chunking

Large subtitle files are automatically split into chunks of up to **350 blocks** before being sent to the OpenAI API. This keeps each API call within the model's context window and allows progress to be reported per chunk. The translated chunks are reassembled in order before being saved.

The chunk sizes are configurable in Settings: OpenAI defaults to **350 cues** per
request and Local AI defaults to **25 cues**. Only compact `[id, dialogue]` pairs
are sent to the model. Timestamps and original subtitle numbers stay local and
are restored after the response is validated. Missing, duplicate, or unexpected
IDs, empty translations, malformed JSON, and incomplete responses fail the chunk
instead of silently producing a broken subtitle file. Both backends use this
format, including local servers that support plain chat without JSON mode.

Completed chunks are saved in the persistent SQLite database for **30 days** by
default (Settings → AI translation → Keep saved translations for, 1–365 days).
Local AI requests time out after **600 seconds** by default (Request timeout,
30–7200 s). The timeout is saved with each queued job; retention applies to the whole cache.
Re-running an interrupted job reuses valid completed chunks even if the temporary
extraction path or job ID changes. Extraction/OCR still runs again; only completed
translation requests are reused. The cache is tied to the entire source subtitle,
chunk position and size, source and target language, backend endpoint, model,
prompt (including regional style and custom instructions), and generation settings
(including local thinking mode). Changing any of those inputs causes a new
translation; identical lines in different source contexts are not shared.

Expired entries are ignored and removed when a new successful chunk is saved.
Invalid cached results are translated again, and cache read/write failures do not
prevent translation. Logs report cache reuse and input/output token counts when
the backend provides usage data. Token savings depend on the subtitles; no fixed
percentage is assumed.

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
