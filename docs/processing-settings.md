# Processing Settings

How the settings for tracks, encoding, output files, notifications, file
detection, translation/OCR, and folder rules behave. The definitions live in
`processing.py`, shared by the backend and the tests.

All settings are validated when saved, persisted to `/config/config.json`, and
take effect without a restart. Encode, remux, rip, subtitle-mux, translation,
and Fix Anime jobs **snapshot** these preferences when queued. Editing Settings
never changes jobs that are already waiting or running.

## Tracks & languages

These rules decide which audio and subtitle tracks survive **encoding and disc
rips**. They are separate from **Library → Required subtitles**, which only sets
the `MISSING LANG` status. Remux writes exactly what you choose in the track
editor, and Fix Anime uses its own language filters.

| Setting | Default | Behavior |
|---|---|---|
| Audio languages to keep | English, Japanese, Spanish | Audio in other languages is removed |
| Keep all audio languages | Off | Keeps every audio language, including untagged tracks |
| Keep untagged audio | Off | Keeps audio tracks with no language tag |
| When no audio matches | Keep all audio tracks | Or keep only the first audio track. A file never loses all its audio unless you drop every track yourself |
| Subtitle languages to keep | English, Spanish | An empty list keeps no subtitles |
| Keep all subtitle languages | Off | Keeps every subtitle track, including untagged |
| Keep untagged subtitles | Off | Keeps subtitle tracks with no language tag |
| Tracks per language | Best track per language | Or keep all matching tracks |
| Preferred codecs | TrueHD, FLAC, DTS, E-AC3, AC3, AAC, Opus, Vorbis, MP3, MP2 | Ranking for the best track. Ties go to more channels, then the earlier track. Unlisted codecs rank last |
| Commentary tracks | Drop | Detected by a title containing "commentary". Dropped commentary is never chosen as the best track |
| Default audio track | Keep source default | Marks the first kept track in this language as default |

Precedence, highest first:

1. **Track-editor choices.** A Keep or Drop you change in the track editor always
   wins. Older records without that marker keep their saved Drop for ordinary
   files. A disc image's stored actions are recommendations and are recomputed
   whenever these rules change.
2. Commentary handling.
3. Language lists, Keep all, and untagged-track switches.
4. Best track per language, or all matching tracks.
5. The audio fallback, used only when no audio track would otherwise remain.

Unknown or untagged tracks never match a language list. They are kept only
by the untagged switches or Keep all. In best-track mode, untagged audio counts
as one language group.

The file details drawer shows every track as Keep or Drop with its reason, plus
the encoder, quality, resolution, and output location, before you queue work.

## Encoding

| Setting | Default | Notes |
|---|---|---|
| Video encoder | HEVC · NVIDIA NVENC | Only encoders that pass a short test encode can be selected |
| Quality profile | Balanced | High quality, Balanced, Smaller files, or Custom. Each maps to the encoder's own scale. NVENC HEVC uses CQ 18 / 20 / 24 |
| Quality value | 20 | Custom profile only. Range 0–51 (0–63 for SVT-AV1, 0–255 for AMD AV1) |
| Speed preset | 4 | 1–7. NVENC P1–P7, mapped to the nearest x264/x265, SVT-AV1, Quick Sync, and AMF presets |
| Maximum resolution | 1080p | Or keep the original. Taller sources are scaled down; nothing is upscaled |
| 10-bit output | On | Advanced. H.264 is always 8-bit |
| Lookahead frames | 20 | Advanced, NVENC only, 0–32 |

Encoding and disc rips use the same encoder and profile. Size estimates use
the selected codec, quality, and output resolution. The defaults produce the
same ffmpeg command as earlier versions: `hevc_nvenc -preset p4 -cq 20
-profile main10 -rc-lookahead 20`, scaled to 1080p.

### Encoders

`GET /api/encoders` checks each candidate once an hour, and again when you
click **Check again**. An encoder must be compiled into the bundled ffmpeg and
complete a 5-frame synthetic encode on this machine.

| Backend | Encoders | Typical requirement |
|---|---|---|
| NVIDIA NVENC | `hevc_nvenc`, `h264_nvenc`, `av1_nvenc` | NVIDIA driver and `--gpus all` (AV1 needs RTX 40-series or newer) |
| Intel Quick Sync | `hevc_qsv`, `h264_qsv`, `av1_qsv` | `/dev/dri` passed through, with the Intel media driver |
| AMD AMF | `hevc_amf`, `h264_amf`, `av1_amf` | AMD driver with AMF. Rarely available inside Linux containers |
| CPU | `libx265`, `libx264`, `libsvtav1` | None, but much slower |

Unavailable encoders are disabled in Settings, with the reason ffmpeg
reported. If the selected encoder fails detection, new encodes and rips are
refused with that message until you pick a working one.

## Output files

| Setting | Default | Behavior |
|---|---|---|
| Output | Replace original | Or **Write separate output**, which leaves the original untouched |
| Output folder | Next to the source | Separate output only. Must be inside the watch folder, and subfolders are mirrored |
| Filename suffix | `.encoded` | Separate output only, as in `Movie.encoded.mkv`. Required when no output folder is set |
| Back up originals | Off | Replace only. The original is renamed to `Movie.mkv.bak` in the same folder, so no extra copy is written |
| Keep backups for | 30 days | 0 keeps backups until deleted. Only backups recorded by Media Monitor are ever removed. Retention is checked hourly |
| Keep translated sidecar after muxing | Off | Keeps the `.xx.srt` after a successful mux. A failed mux always keeps it |

Guarantees for every workflow:

- Outputs are verified before anything is replaced: duration, video stream,
  and size for encodes and remuxes, the added track for subtitle muxes, and
  the full track list for Fix Anime.
- New files never overwrite existing ones. A free `name (2).mkv` is used instead.
- New output files are added to the library as their own entries, and the
  watcher doesn't announce them as new media.

| Workflow | Replace original | Write separate output |
|---|---|---|
| Encode, remux | Replaces after verification, with an optional `.bak` | New `Movie<suffix>.mkv`; source untouched |
| Subtitle translation, external subtitle mux | Adds the track in place, with an optional `.bak` | New file containing the added track |
| Fix Anime | Rewrites in place. MP4 and other containers become `.mkv`; with backups on, the old container is kept as `.bak` instead of deleted | New `Movie<suffix>.mkv`; source untouched |
| Disc rip | Always a new `.mkv` next to the image | Always a new `.mkv`, in the output folder when one is set |

## Notifications

Each provider has its own event list:

| Event | Sent when |
|---|---|
| New media | A new video file is analyzed |
| Needs attention | A new file is flagged RE-ENCODE, REMUX, or MISSING LANG, a folder holds several videos, or a disc image can't be read |
| Job completed | An encode, remux, rip, subtitle mux, translation, or Fix Anime job finishes |
| Job failed | Any of those jobs fails |
| Disc image found | A readable disc image is detected |

A flagged new file sends one notification: as *Needs attention* where that
event is enabled, otherwise as *New media*. Ntfy has a priority for each event
(defaults: High for attention and failures, Default otherwise). Discord has no
priorities. Discord defaults to New media, Needs attention, and Disc image
found, matching earlier versions. **Send test notification** saves pending
edits first, sends with the saved settings, and reports the provider's actual
error.

## New file detection

A file is processed once its size and modification time are unchanged for
**Unchanged checks** consecutive checks, taken **Check interval** seconds apart
(defaults 3 × 10 s, ranges 1–30 and 1–600 s). A file that is still being copied
keeps resetting the count. `STABILIZE_INTERVAL` and `STABILIZE_CHECKS` only
seed the defaults on a fresh install. Once saved in Settings, the saved values
win. Changes apply at the next check, including files already waiting, with
no restart.

## Translation and OCR

- **Keep saved translations for** (1–365 days, default 30) sets how long a
  saved chunk can be reused. The cache key already includes the source text,
  provider, model, language, style, instructions, and generation settings, so
  changing any of those translates again.
- **Request timeout** (Local AI, 30–7200 s, default 600) is saved with each
  queued job.
- **Fallback OCR language** (default English) is used for PGS tracks with a
  missing or unrecognized tag. A single job can override it with `ocr_lang`
  when translating or extracting a track.
- **OCR mode**: Fast, Standard, or Accurate. It controls how much small text is
  enlarged before Tesseract runs, and Accurate also uses the neural-network
  engine. Raw Tesseract flags are not exposed.

## Library folder rules

- **Movie folders** and **Show folders** are paths relative to the watch
  folder. The first folder inside a show folder is the show name.
- **Excluded folders**: a name such as `Extras` or `*sample*` matches a
  folder anywhere. A path such as `TV/*/Specials` matches from the watch
  folder. Case is ignored.
- Precedence: exclusions, then the deepest explicit folder, then folder names
  (`movies`, `films`, `shows`, `series`, `anime`…), then `SxxEyy` filenames.
- Saving reclassifies files already in the library without re-probing them.
  Newly excluded files leave the library index but stay on disk. After you
  remove an exclusion, rescan to add those files back.

## Upgrading

- Every new setting starts at a default that matches earlier behavior, except
  **Commentary tracks**: commentary is now dropped, and is never picked as a
  language's best track.
- **Required subtitles**: a saved empty list now means *no required
  languages*. Earlier versions treated it as English + Spanish. If you had
  cleared every language, reselect the ones you want.
- Jobs queued before the upgrade have no snapshot and use the current settings.
- No restart is needed after changing any setting. Environment variables are
  still read only at startup.
