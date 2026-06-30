# Fixes Proposal

This document proposes targeted fixes for the bugs and unintended behaviors identified in the review. Each section includes the affected file, approximate line numbers from the current tree, the issue, and a drop-in diff.

## 1. Fix `mux_sub` jobs failing on missing `encode_job_type` column

Affected file: [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)

Approximate lines:
- Table definition: 224-246
- `run_encode_job()`: 962-970
- `queue_mux_sub_job()`: 2403-2414

Problem:
- `media_files` does not define an `encode_job_type` column.
- The code updates that column in two places, which will raise `sqlite3.OperationalError: no such column: encode_job_type`.

Proposed fix:
- Add `encode_job_type` to the schema migration path and initial schema.

```diff
--- a/app.py
+++ b/app.py
@@
              CREATE TABLE IF NOT EXISTS media_files (
                  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                  filepath            TEXT UNIQUE NOT NULL,
                  folder_name         TEXT,
                  filename            TEXT,
                  size_bytes          INTEGER,
                  duration_seconds    REAL,
                  video_codec         TEXT,
                  video_width         INTEGER,
                  video_height        INTEGER,
                  video_bitrate       INTEGER,
                  audio_tracks        TEXT,
                  subtitle_tracks     TEXT,
                  format_name         TEXT,
                  status              TEXT,
                  encode_status       TEXT,
+                 encode_job_type     TEXT,
                  has_sibling_videos  INTEGER DEFAULT 0,
                  poster_url          TEXT,
                  media_type          TEXT DEFAULT 'movie',
                  show_name           TEXT,
                  season_episode      TEXT,
                  scanned_at          TEXT DEFAULT (datetime('now'))
              );
```

```diff
--- a/app.py
+++ b/app.py
@@
 def _migrate_db():
     """Add columns introduced after initial schema creation."""
     with db() as conn:
         for col, definition in [
             ('poster_url',     'TEXT'),
             ('media_type',     "TEXT DEFAULT 'movie'"),
             ('show_name',      'TEXT'),
             ('season_episode', 'TEXT'),
+            ('encode_job_type','TEXT'),
         ]:
             try:
                 conn.execute(f'ALTER TABLE media_files ADD COLUMN {col} {definition}')
             except Exception:
                 pass  # column already exists
```

## 2. Make translation cancellation actually stop work

Affected file: [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)

Approximate lines:
- Translation state setup: near 141-148
- `run_translation_job()`: 1756-1889
- `cancel_translation()`: 2648-2661

Problem:
- Cancelling a translation only updates DB state.
- Running OCR, ffmpeg extraction, or mux work continues and may still write files.

Proposed fix:
- Track cancelled translation job IDs in memory.
- Check cancellation between major stages and before writing outputs.
- Return early without saving/muxing when cancelled.

```diff
--- a/app.py
+++ b/app.py
@@
 # Translation job state
 translation_queue = Queue()
+cancelled_translation_jobs = set()
+translation_cancel_lock = threading.Lock()
```

```diff
--- a/app.py
+++ b/app.py
@@
 def _fail_translation_job(job_id, error):
@@
         send_ntfy_notification(
             f"Translation Failed: {folder_name}",
             f"File: {filename}\nError: {error}",
             tags='rotating_light,x',
             priority='high',
         )
+
+
+def _is_translation_cancelled(job_id):
+    with translation_cancel_lock:
+        return job_id in cancelled_translation_jobs
```

```diff
--- a/app.py
+++ b/app.py
@@
 def run_translation_job(job_id):
@@
     try:
+        if _is_translation_cancelled(job_id):
+            return
+
         # 1 —— Extract / OCR
         with db() as conn:
             conn.execute(
                 "UPDATE translation_jobs SET status='extracting', started_at=datetime('now') WHERE id=?",
                 (job_id,),
             )
@@
             with open(tmp_srt, 'w', encoding='utf-8') as fh:
                 fh.write(ocr_content)
             log('info', f"[translate] job {job_id} OCR complete — "
                         f"{len(ocr_content)} chars written to temp SRT")
         else:
@@
             log('info', f"[translate] job {job_id} subtitle extracted — "
                         f"{extracted_lines} lines, {extracted_size / 1024:.1f} KB")
+
+        if _is_translation_cancelled(job_id):
+            with db() as conn:
+                conn.execute(
+                    "UPDATE translation_jobs SET status='cancelled', completed_at=datetime('now') WHERE id=?",
+                    (job_id,),
+                )
+            return
@@
         translated = translate_subtitle_file(
             tmp_srt, source_lang,
             progress_cb=lambda pct, detail: set_progress(
                 translate_start + pct * ((87 - translate_start) / 100), detail
             ),
             job_id=job_id,
         )
+
+        if _is_translation_cancelled(job_id):
+            with db() as conn:
+                conn.execute(
+                    "UPDATE translation_jobs SET status='cancelled', completed_at=datetime('now') WHERE id=?",
+                    (job_id,),
+                )
+            return
@@
         with open(srt_path, 'w', encoding='utf-8') as f:
             f.write(translated)
@@
     finally:
+        with translation_cancel_lock:
+            cancelled_translation_jobs.discard(job_id)
         if os.path.exists(tmp_srt):
             try: os.remove(tmp_srt)
             except OSError: pass
```

```diff
--- a/app.py
+++ b/app.py
@@
 @app.route('/api/translate/cancel/<int:job_id>', methods=['POST'])
 def cancel_translation(job_id):
     with db() as conn:
         job = conn.execute(
             'SELECT * FROM translation_jobs WHERE id=?', (job_id,)
         ).fetchone()
         if not job:
             return jsonify({'error': 'Job not found'}), 404
         if job['status'] not in ('done', 'failed', 'cancelled'):
+            with translation_cancel_lock:
+                cancelled_translation_jobs.add(job_id)
             conn.execute(
                 "UPDATE translation_jobs SET status='cancelled', "
                 "completed_at=datetime('now') WHERE id=?",
                 (job_id,),
             )
     return jsonify({'status': 'cancelled'})
```

## 3. Recover interrupted translation jobs on startup

Affected file: [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)

Approximate lines:
- `_recover_queued_jobs()`: 2827-2843
- startup block: 2846-2852

Problem:
- Encode jobs are recovered after restart, but translation jobs are not.
- Interrupted translation rows can remain in active states forever and block new jobs.

Proposed fix:
- Reset in-progress translation jobs to `pending` and requeue them during startup.

```diff
--- a/app.py
+++ b/app.py
@@
 def _recover_queued_jobs():
@@
     if rows:
         log('warn', f"[startup] re-queued {len(rows)} interrupted encode job(s)")
+
+
+def _recover_translation_jobs():
+    """Re-enqueue translation jobs left active by a restart."""
+    with db() as conn:
+        conn.execute(
+            "UPDATE translation_jobs SET status='pending', progress=0, progress_detail=NULL "
+            "WHERE status IN ('extracting','ocr','translating','muxing')"
+        )
+        rows = conn.execute(
+            "SELECT id FROM translation_jobs WHERE status='pending' ORDER BY created_at"
+        ).fetchall()
+    for row in rows:
+        translation_queue.put(row['id'])
+    if rows:
+        log('warn', f"[startup] re-queued {len(rows)} interrupted translation job(s)")
@@
 if __name__ == '__main__':
@@
     _recover_queued_jobs()
+    _recover_translation_jobs()
```

## 4. Prevent duplicate remux jobs from repeated track assignment saves

Affected file: [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)

Approximate lines:
- `queue_remux_job()`: 2420-2438
- `assign_tracks()`: 2491-2499

Problem:
- Every save from the language assignment dialog creates another remux job.
- There is no duplicate check for existing queued/active remux jobs.

Proposed fix:
- Reuse the same duplicate-check pattern already used for encode and `mux_sub` jobs.

```diff
--- a/app.py
+++ b/app.py
@@
 def queue_remux_job(file_id, filepath):
     """Create an encode_job of type 'remux' and push it onto the encode queue."""
     try:
         size = os.path.getsize(filepath)
     except OSError:
         size = 0
     with db() as conn:
+        existing = conn.execute(
+            "SELECT id FROM encode_jobs "
+            "WHERE media_file_id=? AND job_type='remux' AND status IN ('queued','encoding')",
+            (file_id,),
+        ).fetchone()
+        if existing:
+            return existing['id']
         cursor = conn.execute(
             "INSERT INTO encode_jobs "
             "(media_file_id, filepath, status, original_size, job_type) "
             "VALUES (?,?,'queued',?,'remux')",
             (file_id, filepath, size),
         )
         job_id = cursor.lastrowid
         conn.execute(
             "UPDATE media_files SET encode_status='queued' WHERE id=?",
             (file_id,),
         )
     encode_queue.put(job_id)
     log('info', f"[remux] job {job_id} queued — {Path(filepath).name}")
     return job_id
```

Optional stricter variant:
- Return both `job_id` and a `created` flag, then have `assign_tracks()` tell the client whether it reused an existing remux job.

## 5. Align the `alerts` filter with documented behavior

Affected files:
- [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)
- [frontend/components/media-monitor/media-library-tab.tsx](C:\Users\Ivan\Docs\Projects\media-monitor\frontend\components\media-monitor\media-library-tab.tsx)

Approximate lines:
- backend filter query: 2214-2215
- frontend filter count: 152-156

Problem:
- Backend `alerts` means “multiple video files in a folder.”
- Frontend count means “missing language tags.”
- Docs describe alerts as actionable media issues.

Proposed fix:
- Make `alerts` consistently mean files needing attention: `RE-ENCODE`, `REMUX`, or `MISSING LANG`.

```diff
--- a/app.py
+++ b/app.py
@@
         'alerts': (
-            f"SELECT * FROM media_files WHERE has_sibling_videos=1{tc} ORDER BY folder_name"
+            f"SELECT * FROM media_files "
+            f"WHERE (status LIKE '%RE-ENCODE%' OR status LIKE '%REMUX%' OR status LIKE '%MISSING LANG%'){tc} "
+            f"ORDER BY folder_name, filename"
         ),
```

```diff
--- a/frontend/components/media-monitor/media-library-tab.tsx
+++ b/frontend/components/media-monitor/media-library-tab.tsx
@@
       alerts: all.filter(
-        (f) =>
-          f.audio_tracks.some((t) => !t.lang) ||
-          f.subtitle_tracks.some((t) => !t.lang),
+        (f) =>
+          f.status?.includes("RE-ENCODE") ||
+          f.status?.includes("REMUX") ||
+          f.status?.includes("MISSING LANG"),
       ).length,
```

If you want to keep the current sibling-video behavior, rename the filter to something like `duplicates` or `folder_conflicts` in both backend and UI instead.

## 6. Make config/test actions report actual HTTP success or failure

Affected files:
- [app.py](C:\Users\Ivan\Docs\Projects\media-monitor\app.py)
- [frontend/components/media-monitor/dashboard-tab.tsx](C:\Users\Ivan\Docs\Projects\media-monitor\frontend\components\media-monitor\dashboard-tab.tsx)

Approximate lines:
- Discord test route: 2154-2164
- Dashboard handlers: 69-101

Problem:
- The backend returns success from the Discord test route even on non-2xx webhook responses.
- The frontend shows success toasts without checking `response.ok`.

Proposed fix:
- Fail closed on non-OK responses both in the backend and frontend.

```diff
--- a/app.py
+++ b/app.py
@@
 @app.route('/api/test/discord', methods=['POST'])
 def test_discord():
     try:
         embed = {
             'title':       'Test Notification',
             'description': 'This is a test from Media Monitor!',
             'color':       0x00FF00,
             'timestamp':   datetime.utcnow().isoformat(),
             'footer':      {'text': 'Media Monitor'},
         }
         r = requests.post(config['discord_webhook'], json={'embeds': [embed]}, timeout=10)
-        return jsonify({'status': 'success', 'message': f'HTTP {r.status_code}'})
+        if not r.ok:
+            return jsonify({
+                'status': 'error',
+                'message': f'Discord webhook returned HTTP {r.status_code}',
+            }), 502
+        return jsonify({'status': 'success', 'message': f'HTTP {r.status_code}'})
     except Exception as e:
         return jsonify({'status': 'error', 'message': str(e)}), 500
```

```diff
--- a/frontend/components/media-monitor/dashboard-tab.tsx
+++ b/frontend/components/media-monitor/dashboard-tab.tsx
@@
   const handleSave = async () => {
     try {
-      await fetch('/api/config', {
+      const r = await fetch('/api/config', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(config),
       })
+      if (!r.ok) throw new Error(`save ${r.status}`)
       toast.success("Configuration saved")
     } catch {
       toast.error("Failed to save configuration")
     }
   }
@@
   const handleTestNtfy = async () => {
     try {
-      await fetch('/api/test/ntfy', { method: 'POST' })
+      const r = await fetch('/api/test/ntfy', { method: 'POST' })
+      if (!r.ok) throw new Error(`ntfy ${r.status}`)
       toast.success("Test notification sent to Ntfy")
     } catch {
       toast.error("Failed to send test notification")
     }
   }
@@
   const handleTestDiscord = async () => {
     try {
       const r = await fetch('/api/test/discord', { method: 'POST' })
       const data = await r.json()
-      if (data.status === 'success') toast.success("Test notification sent to Discord")
+      if (!r.ok) throw new Error(data.message || `discord ${r.status}`)
+      if (data.status === 'success') toast.success("Test notification sent to Discord")
       else toast.error(data.message || "Failed")
     } catch {
       toast.error("Failed to send test notification")
     }
   }
```

## Optional hardening follow-up

These are not required to fix the bugs above, but they would improve behavior further:

- Add a backend validation whitelist for `/api/config` keys so arbitrary JSON keys cannot be persisted into `config`.
- Add a dedicated “folder conflicts” or “multiple videos” filter instead of overloading `alerts`.
- Improve translation cancellation by also making long-running subprocess calls interruptible, not just stage-gated.
- Add regression tests around queue deduplication and startup recovery.
