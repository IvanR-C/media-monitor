# Fix Anime

Open **Fix Anime…** in a movie or episode's **⋯** menu, or choose the full-show
or full-season action from a group header's menu. The selection toolbar also
supports multiple files. Group actions resolve the whole show or season on the
server, including episodes hidden by library search or filters.

The dialog loads the last saved settings. **Save settings** persists them without
starting a job. **Save & queue** saves the settings and queues each eligible file.
Each queued job retains its own settings snapshot, even if the defaults change.

## Subtitle workflows

- **Fix target language:** prefer an existing full-dialogue subtitle in that
  language. If missing, extract another subtitle and translate it through the
  configured OpenAI or local AI provider, then produce ASS. English text is
  preferred as a translation source. Regional style, custom instructions, and
  model preferences come from Settings → AI translation and are saved with each
  queued job. No dialect is assumed.
- **Convert kept subtitles to ASS:** convert every subtitle in the kept language
  list in its original language. This mode never calls the translation provider.

Text subtitles are extracted with ffmpeg. PGS subtitles use the existing
Tesseract OCR pipeline. Language-tagged sidecars belonging to the movie or episode
are also supported; neighboring episodes' sidecars are excluded. Files without a
readable source are skipped; this feature does not search subtitle websites.

## Language filters and styles

Choose a target subtitle language before using target mode. The dialog can inherit
your explicit language choice from AI translation settings; no target language is
selected by the repository. Converting kept tracks does not require a target.

Audio defaults to Japanese, English, and Spanish. Subtitles default to English and
Spanish. Both lists are editable; target mode always also keeps its target
language. Other embedded tracks are removed during remuxing. Add
**Unknown / unassigned** to retain untagged tracks. A file is skipped if its
audio would all be removed.

Customize font, size, text/outline/shadow colors, outline width, shadow depth,
vertical margin, centered position, bold, and italic. Measurements use a
1920×1080 ASS script coordinate system and scale with playback resolution.
The sample preview is rendered with ffmpeg/libass using server-installed fonts.
The Docker image includes Noto fonts; unavailable custom fonts fall back to an
installed font. Players need the selected font for matching playback.

**Preserve original placement (PGS)** is enabled by default. PGS OCR retains
source canvas dimensions, visible object bounds, separate text regions, and
successive position changes. These become timed ASS positioning overrides,
scaled to the 1920×1080 script canvas. Reused bitmaps survive display-set changes;
all objects in a display are handled. Repeated moving text is OCR'd and translated
once per identical bitmap/text where possible, then restored at every source
position and time. Placement metadata stays separate from the text sent to AI.
Sparse OCR region boxes are mapped back after image preprocessing and resizing.

Disable this setting to place PGS at the configured position and margin. Those
controls continue to apply to text subtitle sources. The preview includes top,
bottom, and right-side PGS examples for comparing the setting; these are sample
positions, not extracted frames from your media.

Converted tracks use the configured dialogue style. Exact source fonts, graphics,
rotation, karaoke, and fitting translated text into the original space remain
approximate or flattened. PGS movement is preserved as successive timed placements,
without inferring smooth motion between them. Timing and basic bold/italic/
underline markup are retained. Converted embedded tracks replace their sources;
other subtitles in the kept language list remain. Sidecar originals are left alone.

## Execution

All library video formats are accepted: MKV, MP4, AVI, MOV, M4V, M2TS, MTS,
MPG, MPEG, VOB, WebM, WMV, FLV, and 3GP. Non-MKV inputs are automatically remuxed
to a sibling `.mkv` filename because ASS needs a compatible container. Existing
MKVs keep their path. Video and retained audio are stream-copied, with attachments,
metadata, and chapters mapped from the original. Transport-stream data packets are
not carried into the MKV. Retained MP4/MOV text subtitle tracks are also converted
to ASS, in their original languages, for container compatibility. Disc images must
first be ripped to a video file with the existing Rip action.

The review shows the output filename for container conversions. An existing output
file or library record is never overwritten, and jobs targeting the same output
are not queued together. Output publication reserves the new filename exclusively
and updates the existing library record and job paths, preserving the media ID,
poster, and history. The source container is removed only after output verification
and the library update succeed. If source cleanup fails, both files remain and the
queue detail reports the retained original.

The review shows eligible/skipped files, AI translation requirements, new ASS
tracks, and unwanted track removal counts. Jobs appear as **Fix Anime · ASS** in
the subtitle queue, with extraction/OCR/translation/styling/muxing progress.
Normal queue pause and cancellation apply. Cancellation during an external
process takes effect before the next stage or before replacing the media file.

The worker re-reads tracks before processing, writes to a temporary directory on
the same volume, verifies the output track counts/codecs, and atomically replaces
the media file — or, with **Settings → Output files → Write separate output**,
writes a new `<name><suffix>.mkv` and leaves the source untouched. With **Back up
originals**, the replaced file (or the pre-conversion container) is kept as `.bak`.
Fix Anime's language filters are its own; Settings → Tracks & languages applies to
encoding and disc rips. Encoding and subtitle jobs for the same file share a lock.
Failures or cancellation before replacement leave the original intact. Interrupted
subtitle jobs recover on application restart. Language removal is permanent after
a successful remux.

The isolated UI preview on port 5001 saves its own settings and can queue fictional
jobs, but it intentionally runs no media workers. Tests create short disposable
videos in each supported container to verify actual remuxing, stream-copy codecs,
registry updates, filename collisions, and failure/cancellation paths.
