# Project Current State: Media Monitor

Last reviewed: April 27, 2026
Review posture: strict. Claims below should be treated as working assumptions unless backed by tests, recent manual verification, or code references.

## Executive Summary

Media Monitor is a self-hosted media library manager for watching a media directory, analyzing files, classifying them, queuing encode/remux work, translating subtitles, and surfacing that state in a Next.js web UI.

The codebase has meaningful functionality in place, but the project is not in a clean "done" state. Several areas are partially implemented, under-documented, or operationally risky: config/secret handling, hardcoded language rules, GPU-only encoding, inconsistent documentation encoding, and limited proof that the main workflows have been recently verified end to end.

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
- Main UI areas include dashboard/config, media library, encode/translation queues, and logs.
- The frontend currently uses client-side hooks and in-memory filtering/sorting for much of the UI behavior.

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
- NVENC H.265 encoding through FFmpeg.
- Remuxing to apply track/language changes.
- External subtitle muxing.
- Subtitle translation to Cuban Spanish through OpenAI, including OCR path for PGS/image subtitles.
- Job queue progress endpoints and UI monitoring.
- Movie/show grouping in the media library.
- Ntfy and Discord notifications.
- Optional TVDB poster lookup.
- Waitress-based serving path for the backend.

## Partially Implemented Or Ambiguous

- Language configuration is split and easy to misunderstand:
  - Required subtitle languages are configurable.
  - Approved audio/subtitle retention languages are still hardcoded in `app.py`.
- Batch actions exist in the UI/API surface, but need verification against real multi-file encode and translation workflows before calling them complete.
- "Production ready" is not proven. Waitress is present, but authentication, secret handling, deployment hardening, and operational runbooks are still weak.
- OCR supports PGS/image-based subtitles, but VOBSUB/DVD subtitle support remains unproven.
- Metadata enrichment is limited mostly to poster lookup; richer TMDB/TVDB metadata is not implemented.
- The documentation set has mojibake/encoding damage in multiple Markdown files, not just this one.

## Known Risks And Gaps

- Secrets and runtime state are not cleanly protected by repository hygiene yet. `config/config.json` can contain Discord webhooks, TVDB keys, Ntfy topics, and OpenAI keys; `config/processed.db` is runtime state. These must stay out of source control.
- There is no authentication layer for the web UI.
- Encoding requires NVIDIA/NVENC. There is no CPU fallback.
- Translation target is hardcoded to Cuban Spanish.
- Approved language retention rules are hardcoded.
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
   - configurable translation target
   - configurable approved audio languages
   - configurable approved subtitle languages
   - configurable required subtitle languages
6. Add authentication or explicitly document that the app must only be exposed on a trusted network.
7. Add CPU encoding fallback or clearly mark NVENC as a hard requirement in UI and docs.

## Roadmap

### Short Term

- Fix README/docs encoding damage.
- Add or verify `.gitignore` protection for config, database, caches, and frontend dependency output.
- Record test commands and latest results in the docs.
- Rename leftover scaffold metadata to Media Monitor.
- Clarify Dashboard language settings so required languages are not confused with approved retention languages.
- Add configurable translation target.

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
