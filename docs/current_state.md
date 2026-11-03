# Project Current State: Media Monitor

Last reviewed: June 30, 2026
Review posture: strict. Claims below should be treated as working assumptions unless backed by tests, recent manual verification, or code references.

## Executive Summary

Media Monitor is a self-hosted media library manager for watching a media directory, analyzing files, classifying them, queuing encode/remux work, translating subtitles, and surfacing that state in a Next.js web UI.

The codebase has meaningful functionality in place, but the project is not in a clean "done" state. Several areas are partially implemented, under-documented, or operationally risky: config/secret handling, inconsistent documentation encoding, and limited proof that the main workflows have been recently verified end to end.

## Verified Architecture

### Backend

- Python Flask app in `app.py`.
- SQLite database at `/config/processed.db` by default, mounted from `./config` in Docker.
- Watchdog-based filesystem monitoring for the configured watch directory.
- FFprobe-based media metadata extraction.
- FFmpeg-based encode, remux, and subtitle mux operations.
- Sequential encode queue backed by `encode_jobs`.
- Sequential translation queue backed by `translation_jobs`.
- Waitress production WSGI serving is already implemented when the dependency is installed; Flask dev server is only the fallback.
- Notifications support Ntfy and Discord, with optional TVDB poster lookup.

### Frontend

- Next.js App Router application under `frontend/`.
- React 19, Tailwind CSS, Radix/shadcn-style UI components.
- Main UI areas include a Library-first landing view, a secondary Settings view, encode/translation queues, and logs.
- The frontend currently uses client-side hooks and in-memory filtering/sorting for much of the UI behavior.
- Recent frontend updates moved branding and view switching into a slim sticky header, renamed the previous config view to Settings, and condensed library totals into inline text beside the Movies/Shows control.

### Data Model

- `media_files`: analyzed media file metadata and current classification state.
- `processed_files`: watcher audit/deduplication records.
- `encode_jobs`: encode, remux, and mux-sub job records.
- `translation_jobs`: subtitle extraction/OCR/translation/mux job records.

## Implemented Functionality

- Directory watching, stabilization checks, and media analysis.
- File classification using statuses such as `OK`, `REMUX`, `RE-ENCODE`, and `MISSING LANG`.
- Configurable size threshold for `RE-ENCODE`.
- Configurable required subtitle languages for `MISSING LANG`.
- Video encoding through FFmpeg with configurable encoder (NVENC by default; Quick Sync, AMF, and CPU when detected), quality profile, preset, and maximum resolution.
- Configurable track retention, audio selection, output policy (replace with optional backups, or separate output), notification events/priorities, copy-stability timing, OCR fallback/mode, and library folder rules — see `docs/processing-settings.md`.
- Remuxing to apply track/language changes.
- External subtitle muxing.
- Configurable subtitle translation through OpenAI or a local compatible AI server, including PGS OCR, optional regional style, and saved job preferences.
- Job queue progress endpoints and UI monitoring.
- Movie/show grouping in the media library.
- Ntfy and Discord notifications.
- Optional TVDB poster lookup.
- Waitress-based serving path for the backend.

## Partially Implemented Or Ambiguous

- Language configuration has two deliberately separate settings: Required subtitles (library status) and Tracks & languages (what encoding/ripping keeps). Both are configurable.
- Quick Sync, AMF, and CPU encoder command lines are covered by unit tests and a synthetic self-test, but have not been verified on full-length real encodes.
- Batch actions exist in the UI/API surface, but need verification against real multi-file encode and translation workflows before calling them complete.
- "Production ready" is not proven. Waitress is present, but authentication, secret handling, deployment hardening, and operational runbooks are still weak.
- OCR supports PGS/image-based subtitles, but VOBSUB/DVD subtitle support remains unproven.
- Metadata enrichment is limited mostly to poster lookup; richer TMDB/TVDB metadata is not implemented.
- The documentation set has mojibake/encoding damage in multiple Markdown files, not just this one.

## Known Risks And Gaps

- Secrets and runtime state are not cleanly protected by repository hygiene yet. `config/config.json` can contain Discord webhooks, TVDB keys, Ntfy topics, and OpenAI keys; `config/processed.db` is runtime state. These must stay out of source control.
- There is no authentication layer for the web UI.
- Non-NVENC encoders are selectable only after a self-test passes; long real-world encodes on those backends are unverified.
- Translation requires an explicit target language in Settings; there is no default language or dialect.
- The repo still has scaffold residue in frontend metadata unless cleaned up.
- Current documentation overstates certainty in places and does not consistently distinguish implemented, partial, planned, and verified behavior.
- Test coverage exists, but this document does not yet include a current pass/fail test run and coverage summary.

## Immediate Priorities

1. Protect secrets and runtime state with `.gitignore` rules and document secret rotation expectations.
2. Fix documentation encoding across README and docs.
3. Run and record backend test status.
4. Verify core workflows manually with representative media:
   - initial scan
   - re-scan
   - encode
   - remux
   - subtitle translation
   - external subtitle mux
   - queue cancellation/recovery
5. Make language configuration honest and coherent:
   - translation target and regional style are now configurable
   - audio/subtitle retention languages are now configurable (Tracks & languages)
   - required subtitle languages are configurable, and an empty selection means none
6. Add authentication or explicitly document that the app must only be exposed on a trusted network.
7. Verify non-NVENC encoders on real hardware and full-length files.

## Roadmap

### Short Term

- Fix README/docs encoding damage.
- Add or verify `.gitignore` protection for config, database, caches, and frontend dependency output.
- Record test commands and latest results in the docs.
- Rename leftover scaffold metadata to Media Monitor.
- Maintain configurable translation target, regional style, and saved job preferences.

### Medium Term

- Add user authentication.
- Add CPU `libx265` fallback.
- Expand metadata enrichment beyond posters.
- Improve OCR and subtitle format support, including VOBSUB if feasible.
- Add deployment documentation for reverse proxy, storage mounts, GPU runtime, and secret management.

### Long Term

- Multi-node encoding.
- PWA or mobile-friendly monitoring experience.
- Advanced filtering by codec, bitrate, language, missing tracks, and job state.

## Acceptance Bar For Future State Claims

A feature should not be listed as complete unless at least one of the following is true:

- It has automated test coverage and the latest test run passed.
- It has been manually verified and the verification date/media type is documented.
- It is directly obvious from code inspection and has no external runtime dependency.

Anything else belongs under "Partially Implemented", "Known Risks And Gaps", or "Roadmap".
