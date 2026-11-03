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
  preferred as a translation source. Spanish retains the existing Cuban Spanish
  prompt; other target languages use their selected language.
- **Convert kept subtitles to ASS:** convert every subtitle in the kept language
  list in its original language. This mode never calls the translation provider.

Text subtitles are extracted with ffmpeg. PGS subtitles use the existing
Tesseract OCR pipeline. Language-tagged sidecars belonging to the movie or episode
are also supported; neighboring episodes' sidecars are excluded. Files without a
readable source are skipped; this feature does not search subtitle websites.

## Language filters and styles

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

Converted tracks use one uniform dialogue style. Their original typesetting,
karaoke, signs, and positioning are flattened. Timing and basic bold/italic/
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
the media file. Encoding and subtitle jobs for the same file share a lock.
Failures or cancellation before replacement leave the original intact. Interrupted
subtitle jobs recover on application restart. Language removal is permanent after
a successful remux.

The isolated UI preview on port 5001 saves its own settings and can queue fictional
jobs, but it intentionally runs no media workers. Tests create short disposable
videos in each supported container to verify actual remuxing, stream-copy codecs,
registry updates, filename collisions, and failure/cancellation paths.
