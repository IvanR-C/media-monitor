# Media Library Browser

The Library view is the default screen when Media Monitor loads. It gives you a full view of every video file in your watch directory, with filtering, sorting, per-file actions, and live job queues.

---

## Layout Overview

```
┌──────────────────────────────────────────────────┐
│  App header: Media Monitor logo + Library/Settings │
├──────────────────────────────────────────────────┤
│  Toolbar: Movies/Shows toggle · files/size totals │
│           Search · filters · Scan · bulk actions  │
├──────────────────────────────────────────────────┤
│                                                  │
│  Media Table                                     │
│  (sortable columns, per-row action menus)        │
│                                                  │
├──────────────────────────────────────────────────┤
│  Encode & Translation Queue (collapsible)        │
├──────────────────────────────────────────────────┤
│  Logs (collapsible)                              │
└──────────────────────────────────────────────────┘
```

---

## Movies vs Shows

Use the **Movies / Shows** toggle in the toolbar to switch views. Compact totals next to the toggle show the file count and total size for the currently selected media type.

**Movies view:**
- One row per movie folder
- Title is derived from the folder name
- A small 🔄 icon on the title cell re-scans that specific folder

**Shows view:**
- Files are grouped into a tree: **Show → Season → Episodes**
- Show and season header rows are collapsible
- Each header row has a 🔄 re-scan button for that show or season folder
- Episode rows are indented and show the `SxxExx` identifier

---

## Status Badges

Every file has a status badge derived from its media analysis:

| Badge | Meaning |
|---|---|
| `OK` | File is fine — no action needed |
| `REMUX` | One or more audio/subtitle tracks are missing language tags |
| `RE-ENCODE` | File exceeds the size threshold (default 20 GB, configurable) |
| `QUEUED` | An encode or translation job is pending or in progress |
| `ENCODED` | File has been successfully re-encoded |

---

## Filtering

Click a filter pill in the toolbar to narrow the list:

| Filter | Shows |
|---|---|
| All | Every file |
| Needs Encoding | Files with `RE-ENCODE` status |
| Needs Remux | Files with `REMUX` status |
| Missing Lang | Files with audio tracks that have no language tag |
| Queued | Files with an active or pending encode/translate job |
| Done | Files that have been successfully encoded |
| Alerts | Files with sibling-video conflicts or unprocessable analysis results |

---

## Sorting

Click any column header to sort. Click again to reverse. Sortable columns:

- Title (folder / episode name)
- File size
- Resolution
- Video codec

---

## Per-File Actions (··· menu)

| Action | Description |
|---|---|
| **Queue Encode** | Add this file to the HEVC encoding queue |
| **Assign Languages** | Open a dialog to manually set language tags on audio/subtitle tracks (used before remuxing) |
| **OCR + Translate #N** | Queue an OCR + translation job for a PGS image subtitle track |
| **Translate #N** | Queue a translation job for a text subtitle track |
| **Mux Subtitle File** | Mux an external subtitle file from the same directory into the MKV (only shown when the movie has no subtitle tracks) |
| **Re-scan Folder** | Re-run ffprobe on this file's folder to pick up changes (e.g. after external encoding) |

---

## Bulk Actions

Select multiple files using the checkboxes, then use the toolbar buttons:

| Button | Description |
|---|---|
| **Queue Encode** | Queue all selected files for encoding |
| **Deselect** | Clear selection |

The toolbar shows how many files are selected and how many of those have translatable subtitle tracks.

---

## Re-scanning

**Full library scan:** Click the **Scan** button in the toolbar. This walks the entire watch directory, runs ffprobe on every video file, and updates the database. Useful after major library reorganisation. If the library is empty, a large **Scan Library** button is shown in the centre of the table as a shortcut.

**Folder re-scan:** Click the 🔄 icon next to any movie title, show header, or season header. Only files in that specific directory are re-analysed. Use this after encoding a file externally (e.g. HandBrake) so the UI reflects the new codec and file size.

---

## Muxing an External Subtitle File

If a movie has no subtitle tracks, a **Mux Subtitle File** option appears in its ··· menu. This lets you inject an existing subtitle file (`.srt`, `.ass`, `.ssa`, `.vtt`, `.sub`) from the same directory into the MKV without re-encoding.

**How it works:**

1. Click **··· → Mux Subtitle File** on a movie with no subtitle tracks
2. The dialog scans the movie's directory and lists any subtitle files it finds
3. Select the file and choose the subtitle language
4. Click **Queue Mux** — the dialog closes and a mux job is queued
5. The job runs through the encode worker queue (visible in the Encode Queue panel)
6. When complete the movie record is refreshed — the new subtitle track appears immediately

The original movie file is replaced in-place; no re-encoding of video or audio takes place. The operation is fast (typically a few seconds regardless of file size).

> **Subtitle files must be in the same directory as the movie.** Files in subdirectories or elsewhere on the system are not listed for security reasons.

---

## Encode Queue

The encode queue panel (bottom of the page) shows all encoding jobs:

| Column | Description |
|---|---|
| File | Folder / filename |
| Status | Queued · Encoding · Done · Failed · Cancelled |
| Progress | Live percentage bar with speed (fps) and ETA |
| Size | Original size → encoded size with savings % |

Active jobs update in real time. Completed jobs stay visible for reference until dismissed.

**Cancel a job:** Click the ✕ button. In-progress jobs are killed immediately and the temp file is deleted.

---

## Translation Queue

Shown alongside the encode queue. Each job displays:

- File name and subtitle track number
- Current phase: `extracting` → `ocr` → `translating` → `muxing`
- Progress bar with per-chunk detail (e.g. "Translating part 2/5…" or "OCR frame 340/1200…")

---

## Log Viewer

The collapsible **Logs** panel at the bottom streams live log output from the backend. Entries are colour-coded by level:

- White — `INFO`
- Yellow — `WARN`
- Red — `ERROR`

Logs are kept in a 500-entry ring buffer. They reset on container restart. For persistent logs, mount a volume and redirect stdout, or check `docker logs media-monitor-backend`.

---

## Mobile / Responsive View

On narrow screens the table switches to a **card layout**:

- Each file is shown as a card with title, size, codec, resolution, and status badge
- Shows/seasons use collapsible section headers
- The ··· action menu moves inside each card
