# Configurable App Settings — TODOs

This backlog recorded the remaining hardcoded preferences identified in the
settings audit. Every item below is now implemented; behavior, defaults,
precedence rules, and upgrade notes are documented in
[processing-settings.md](processing-settings.md), and regression tests live in
`tests/test_processing_settings.py`.

Decisions made while implementing:

- Bit depth (10-bit) and NVENC lookahead are **advanced settings**, independent
  of the quality profile; profiles set only the quality value.
- Speed presets use one 1–7 scale (NVENC P1–P7) mapped to each backend.
- Backups are same-folder `.bak` renames (no extra copy), tracked in the
  database so retention only ever deletes Media Monitor's own backups.
- Notification test buttons save pending edits, then send with the saved
  provider configuration and report the provider's real error.
- Copy-stability edits apply to the next check, including waits in progress.
- Commentary audio is now dropped by default (previously not detected).

## High priority

### Language retention during encoding and ripping

Current behavior: approved audio languages are English, Spanish, and Japanese;
approved subtitle languages are English and Spanish. If no approved audio
languages remain, the selector keeps all non-dropped audio tracks. Required
subtitle languages affect library status separately from these retention rules.

- [x] Add searchable audio and subtitle language keep lists to Settings.
- [x] Offer an explicit **Keep all languages** option.
- [x] Define how unknown/untagged tracks and empty keep lists behave.
- [x] Make the fallback for files with no matching audio language explicit.
- [x] Keep retention rules distinct from **Required subtitles**, which controls
  library status rather than which tracks survive processing.
- [x] Apply the configured rules consistently to encode/rip commands, track
  previews, and output-size estimates.

### Empty required-subtitle selection

Current behavior: an empty required-language list falls back to English and
Spanish in the backend, even though the UI allows deselecting every language.

- [x] Treat an explicitly empty list as **No required subtitle languages**.
- [x] Distinguish missing configuration from a deliberately empty selection.
- [x] Verify library classification and file-details explanations agree with the
  selection, including after saving and reloading.

### Encoding profiles, quality, and resolution

Current behavior: encode and rip commands use `hevc_nvenc`, preset `p4`, CQ `20`,
profile `main10`, and rate-control lookahead `20`. Sources above 1080p are scaled
to 1080p.

- [x] Add named quality profiles and an advanced quality-value control.
- [x] Expose the encoder speed/quality preset.
- [x] Add a maximum-resolution setting with **Preserve original resolution**.
- [x] Decide whether bit depth/profile and lookahead belong in advanced settings
  or remain managed by the selected profile.
- [x] Use the same profile for ordinary encoding and disc ripping.
- [x] Update size estimates and processing previews to reflect the profile.

### Audio track selection

Current behavior: encoding keeps the highest-ranked codec per approved language.
The ranking is fixed in code and does not express a user's preferred track type.

- [x] Add **Keep all matching tracks** and **Best track per language** modes.
- [x] Allow preferred audio codecs or a configurable preference order.
- [x] Define commentary-track handling and preferred/default track behavior.
- [x] Document how channel count, codec, and explicit per-track Keep/Drop choices
  interact, so the selected output is predictable.
- [x] Show the resulting track selection before processing.

### Output files and original-file handling

Current behavior: successful ordinary encodes replace the original file.
Translated sidecars are removed after successful muxing and retained if muxing
fails. Fix Anime can also replace a source or convert its container to MKV.

- [x] Offer **Replace original** and **Write separate output** policies.
- [x] Add configurable output-directory and filename-suffix options.
- [x] Offer optional original-file backups and define their retention policy.
- [x] Add **Keep translated sidecar after muxing**.
- [x] Define behavior consistently for encoding, remuxing, translation, and Fix
  Anime, while making workflow-specific differences visible.
- [x] Preserve existing files on output-name collisions and retain verification
  before replacing any source.

## Medium priority

### Notification events and priorities

Current behavior: notification providers can be enabled or disabled, but event
selection and event priorities are defined in code.

- [x] Add event filters separately for each notification provider.
- [x] Cover new-media detection, attention-required files, job completion, job
  failure, and disc-image detection where those events apply.
- [x] Allow priority choices for providers that support priorities.
- [x] Make the notification test reflect the saved provider configuration.

### File detection and copy-stability timing

Current behavior: `STABILIZE_INTERVAL` defaults to 10 seconds and
`STABILIZE_CHECKS` to three unchanged checks. Both are environment settings rather
than editable app preferences.

- [x] Expose the interval and unchanged-check count under advanced monitoring
  settings, with a plain-language explanation of the copy-completion wait.
- [x] Validate practical ranges and document environment-variable precedence.
- [x] Specify whether edits affect new checks immediately or require a restart.
- [x] Verify files still being copied are not processed prematurely.

### Translation and OCR operation

Current behavior: cached translations expire after 30 days, local AI requests use
a 600-second timeout, and unknown/unrecognized OCR language tags fall back to
English.

- [x] Make translation-cache retention configurable.
- [x] Expose the local AI request timeout with units and validated limits.
- [x] Add an OCR language override for missing or incorrect track tags.
- [x] Consider user-facing OCR accuracy/layout presets rather than exposing raw
  Tesseract flags as ordinary settings.
- [x] Ensure translation-affecting changes invalidate cache entries and that
  queued jobs retain the intended preferences.

## Lower priority

### Library classification and folder rules

Current behavior: fixed folder names such as `movies`, `films`, `shows`, `series`,
and `anime`, plus filename patterns, influence movie/show classification.

- [x] Allow explicit movie and show roots within the mounted watch directory.
- [x] Add configurable folder exclusions and document their matching rules.
- [x] Define precedence between explicit roots, naming heuristics, and exclusions.
- [x] Explain how rule changes affect already-indexed files and rescanning.

### Additional encoders — implementation required

Current behavior: video encoding requires NVIDIA HEVC/NVENC. Other encoder
choices need implementation and capability detection before they can become
working settings.

- [x] Evaluate CPU, Intel, and AMD encoding backends and additional codecs such
  as H.264 and AV1.
- [x] Detect supported hardware/encoder combinations and expose only usable
  choices, with actionable explanations for unavailable options.
- [x] Define equivalent quality/preset controls and size estimates per backend.

## Shared implementation requirements

- [x] Provide validated, persisted settings and clear descriptions of defaults.
- [x] Snapshot processing preferences when jobs are queued, so later edits do
  not silently change pending work.
- [x] Document migration behavior for existing installations and restart needs.
- [x] Add focused regression tests for settings persistence, affected processing
  behavior, and file-preservation guarantees.
- [x] Update README and workflow documentation alongside each completed item.

Keep protocol constants, subtitle-format validation, and most internal timing
details in code unless a concrete user need justifies exposing them.
