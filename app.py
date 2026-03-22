#!/usr/bin/env python3
"""
Media Monitor - Media library monitoring, notifications, and transcoding management.
"""
import os
import re
import json
import time
import shutil
import threading
import sqlite3
import subprocess
from collections import Counter, deque
from contextlib import contextmanager
from pathlib import Path
from queue import Queue
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import Flask, render_template, request, jsonify
import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

app = Flask(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
CONFIG_FILE        = os.environ.get('CONFIG_FILE', '/config/config.json')
DB_FILE            = os.environ.get('DB_FILE', '/config/processed.db')
WATCH_DIR          = os.environ.get('WATCH_DIR', '/watch')
STABILIZE_INTERVAL = int(os.environ.get('STABILIZE_INTERVAL', '10'))
STABILIZE_CHECKS   = int(os.environ.get('STABILIZE_CHECKS', '3'))
MAX_WORKERS        = int(os.environ.get('MAX_WORKERS', '4'))
REENCODE_SIZE_GB   = float(os.environ.get('REENCODE_SIZE_GB', '20'))

VIDEO_EXTENSIONS = ('.mkv', '.mp4', '.avi', '.mov', '.m4v')

IMAGE_BASED_SUB_CODECS = {
    'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle',
    'dvb_teletext', 'eia_608', 'eia_708',
}

APPROVED_AUDIO_LANGS = {'eng', 'spa', 'jpn'}
APPROVED_SUB_LANGS   = {'eng', 'spa'}

AUDIO_QUALITY = {
    'truehd': 10, 'flac': 9, 'dts': 8, 'eac3': 7, 'ac3': 6,
    'aac': 5, 'opus': 4, 'vorbis': 4, 'mp3': 3, 'mp2': 2,
}

LANG_MAP = {
    'en': 'eng', 'es': 'spa', 'ja': 'jpn', 'sp': 'spa', 'jp': 'jpn',
    'de': 'deu', 'fr': 'fra', 'pt': 'por', 'it': 'ita', 'zh': 'zho',
    'ko': 'kor', 'ru': 'rus', 'ar': 'ara', 'hi': 'hin',
}

SHOW_ROOT_SEGMENTS  = {'series', 'tv', 'shows', 'anime', 'television'}
MOVIE_ROOT_SEGMENTS = {'movies', 'movie', 'films', 'film'}
SE_PATTERN          = re.compile(r'[Ss](\d{1,2})[Ee](\d{1,2})')

# ── In-memory log buffer (frontend /api/logs) ─────────────────────────────────
_log_buffer     = deque(maxlen=500)
_log_seq        = 0
_log_lock       = threading.Lock()

def log(level: str, msg: str):
    """Log to stdout and the in-memory ring buffer exposed via /api/logs."""
    global _log_seq
    ts = datetime.now().strftime('%H:%M:%S')
    print(f"[{ts}] [{level.upper()}] {msg}", flush=True)
    with _log_lock:
        _log_seq += 1
        _log_buffer.append({'seq': _log_seq, 'ts': ts, 'level': level, 'msg': msg})


def detect_media_type(filepath):
    """Return (media_type, show_name, season_episode) for a given filepath."""
    parts = Path(filepath).parts
    for i, part in enumerate(parts):
        low = part.lower()
        if low in SHOW_ROOT_SEGMENTS and i + 1 < len(parts):
            show_name = parts[i + 1]
            m = SE_PATTERN.search(Path(filepath).stem)
            se = f"S{int(m.group(1)):02d}E{int(m.group(2)):02d}" if m else None
            return 'show', show_name, se
        if low in MOVIE_ROOT_SEGMENTS:
            return 'movie', None, None
    # Fallback: filename SE pattern suggests an episode
    m = SE_PATTERN.search(Path(filepath).stem)
    if m:
        p = Path(filepath)
        # parent is likely "Season N", grandparent is show name
        show_name = p.parent.parent.name if p.parent.parent != p.parent else p.parent.name
        se = f"S{int(m.group(1)):02d}E{int(m.group(2)):02d}"
        return 'show', show_name, se
    return 'movie', None, None


config = {
    'ntfy_server':     os.environ.get('NTFY_SERVER', 'https://ntfy.sh'),
    'ntfy_topic':      os.environ.get('NTFY_TOPIC', ''),
    'discord_webhook': os.environ.get('DISCORD_WEBHOOK', ''),
    'tvdb_api_key':    os.environ.get('TVDB_API_KEY', ''),
    'enable_discord':  True,
    'enable_ntfy':     True,
    'enable_posters':  True,
    'openai_api_key':  os.environ.get('OPENAI_API_KEY', ''),
    'openai_model':    os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'),
}

executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

# Encode job state
encode_queue  = Queue()
active_proc   = None       # running subprocess.Popen
active_job_id = None
encode_lock   = threading.Lock()

# Translation job state
translation_queue = Queue()

# Scan state (shared, read by /api/media/scan/status)
scan_status = {'running': False, 'scanned': 0, 'total': 0}

# TVDB token cache (valid ~30 days, refreshed on expiry)
_tvdb_token         = None
_tvdb_token_expires = 0.0


# ── Config persistence ────────────────────────────────────────────────────────
def load_config():
    global config
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE) as f:
                config.update(json.load(f))
            print(f"[config] loaded from {CONFIG_FILE}")
    except Exception as e:
        print(f"[config] load error: {e}")


def save_config():
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
    except Exception as e:
        print(f"[config] save error: {e}")


# ── Database ──────────────────────────────────────────────────────────────────
@contextmanager
def db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate_db():
    """Add columns introduced after initial schema creation."""
    with db() as conn:
        for col, definition in [
            ('poster_url',     'TEXT'),
            ('media_type',     "TEXT DEFAULT 'movie'"),
            ('show_name',      'TEXT'),
            ('season_episode', 'TEXT'),
        ]:
            try:
                conn.execute(f'ALTER TABLE media_files ADD COLUMN {col} {definition}')
            except Exception:
                pass  # column already exists


def init_db():
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    with db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS processed_files (
                filepath     TEXT PRIMARY KEY,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status       TEXT,
                size         INTEGER
            );

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
                has_sibling_videos  INTEGER DEFAULT 0,
                poster_url          TEXT,
                media_type          TEXT DEFAULT 'movie',
                show_name           TEXT,
                season_episode      TEXT,
                scanned_at          TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS encode_jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                media_file_id   INTEGER REFERENCES media_files(id),
                filepath        TEXT NOT NULL,
                status          TEXT DEFAULT 'queued',
                progress        REAL DEFAULT 0.0,
                speed           TEXT,
                eta_seconds     INTEGER,
                started_at      TEXT,
                completed_at    TEXT,
                original_size   INTEGER,
                encoded_size    INTEGER,
                error_text      TEXT,
                created_at      TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS translation_jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                media_file_id   INTEGER REFERENCES media_files(id),
                filepath        TEXT NOT NULL,
                source_sub_idx  INTEGER,
                source_lang     TEXT,
                status          TEXT DEFAULT 'pending',
                progress        REAL DEFAULT 0.0,
                progress_detail TEXT,
                srt_path        TEXT,
                error_text      TEXT,
                started_at      TEXT,
                completed_at    TEXT,
                created_at      TEXT DEFAULT (datetime('now'))
            );
        ''')


# ── Language helpers ──────────────────────────────────────────────────────────
def normalize_lang(lang):
    if not lang:
        return ''
    l = lang.lower().strip()
    return LANG_MAP.get(l, l)


# ── FFprobe / media info ──────────────────────────────────────────────────────
def run_ffprobe(filepath):
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', filepath],
            capture_output=True, text=True, timeout=60,
        )
        return json.loads(result.stdout)
    except Exception as e:
        print(f"[ffprobe] error on {filepath}: {e}")
        return None


def parse_media_info(filepath):
    """Run ffprobe and return a structured dict ready for DB insertion."""
    data = run_ffprobe(filepath)
    if not data:
        return None

    path = Path(filepath)
    try:
        size_bytes = os.path.getsize(filepath)
    except OSError:
        return None

    fmt      = data.get('format', {})
    duration = float(fmt.get('duration') or 0)

    video_streams, audio_streams, subtitle_streams = [], [], []
    audio_idx = sub_idx = 0

    for s in data.get('streams', []):
        ct   = s.get('codec_type')
        tags = s.get('tags') or {}
        lang  = tags.get('language') or tags.get('LANGUAGE') or ''
        title = tags.get('title')    or tags.get('TITLE')    or ''

        if ct == 'video':
            video_streams.append({
                'stream_idx': s.get('index'),
                'codec':      s.get('codec_name', ''),
                'width':      s.get('width', 0),
                'height':     s.get('height', 0),
                'bitrate':    int(s.get('bit_rate') or 0),
            })
        elif ct == 'audio':
            audio_streams.append({
                'stream_idx': s.get('index'),
                'audio_idx':  audio_idx,
                'lang':       lang,
                'codec':      s.get('codec_name', ''),
                'channels':   s.get('channels', 0),
                'title':      title,
                'bitrate':    int(s.get('bit_rate') or 0),
            })
            audio_idx += 1
        elif ct == 'subtitle':
            subtitle_streams.append({
                'stream_idx': s.get('index'),
                'sub_idx':    sub_idx,
                'lang':       lang,
                'codec':      s.get('codec_name', ''),
                'title':      title,
            })
            sub_idx += 1

    video = video_streams[0] if video_streams else {}
    status = determine_status(size_bytes, audio_streams, subtitle_streams)

    media_type, show_name, season_episode = detect_media_type(filepath)

    return {
        'filepath':         filepath,
        'folder_name':      path.parent.name,
        'filename':         path.name,
        'size_bytes':       size_bytes,
        'duration_seconds': duration,
        'video_codec':      video.get('codec', ''),
        'video_width':      video.get('width', 0),
        'video_height':     video.get('height', 0),
        'video_bitrate':    video.get('bitrate', 0),
        'audio_tracks':     json.dumps(audio_streams),
        'subtitle_tracks':  json.dumps(subtitle_streams),
        'format_name':      fmt.get('format_name', ''),
        'status':           status,
        'has_sibling_videos': 0,  # set by caller
        'media_type':       media_type,
        'show_name':        show_name,
        'season_episode':   season_episode,
    }


def determine_status(size_bytes, audio_streams, subtitle_streams):
    parts = []
    if size_bytes > REENCODE_SIZE_GB * 1024 ** 3:
        parts.append('RE-ENCODE')
    # Only consider non-dropped tracks when checking for missing language tags
    active = [s for s in audio_streams + subtitle_streams if s.get('action') != 'drop']
    if any(not s.get('lang') for s in active):
        parts.append('REMUX')
    # Flag if BOTH English and Spanish subtitles are not present — each is required
    active_subs = [s for s in subtitle_streams if s.get('action') != 'drop']
    active_sub_langs = {normalize_lang(s.get('lang', '')) for s in active_subs}
    if not APPROVED_SUB_LANGS.issubset(active_sub_langs):
        parts.append('MISSING LANG')
    return ' | '.join(parts) if parts else 'OK'


def upsert_media_file(info):
    row = {**info, 'poster_url': info.get('poster_url')}
    with db() as conn:
        conn.execute('''
            INSERT INTO media_files
                (filepath, folder_name, filename, size_bytes, duration_seconds,
                 video_codec, video_width, video_height, video_bitrate,
                 audio_tracks, subtitle_tracks, format_name, status,
                 has_sibling_videos, poster_url,
                 media_type, show_name, season_episode,
                 scanned_at)
            VALUES
                (:filepath, :folder_name, :filename, :size_bytes, :duration_seconds,
                 :video_codec, :video_width, :video_height, :video_bitrate,
                 :audio_tracks, :subtitle_tracks, :format_name, :status,
                 :has_sibling_videos, :poster_url,
                 :media_type, :show_name, :season_episode,
                 datetime('now'))
            ON CONFLICT(filepath) DO UPDATE SET
                folder_name=excluded.folder_name,
                filename=excluded.filename,
                size_bytes=excluded.size_bytes,
                duration_seconds=excluded.duration_seconds,
                video_codec=excluded.video_codec,
                video_width=excluded.video_width,
                video_height=excluded.video_height,
                video_bitrate=excluded.video_bitrate,
                audio_tracks=excluded.audio_tracks,
                subtitle_tracks=excluded.subtitle_tracks,
                format_name=excluded.format_name,
                status=excluded.status,
                has_sibling_videos=excluded.has_sibling_videos,
                poster_url=COALESCE(excluded.poster_url, media_files.poster_url),
                media_type=COALESCE(excluded.media_type, media_files.media_type),
                show_name=excluded.show_name,
                season_episode=excluded.season_episode,
                scanned_at=datetime('now')
        ''', row)


# ── TVDB poster fetching ──────────────────────────────────────────────────────
_TVDB_BASE = 'https://api4.thetvdb.com/v4'


def tvdb_get_token():
    """Authenticate with TVDB v4 API and return a bearer token (cached ~30 days)."""
    global _tvdb_token, _tvdb_token_expires
    if _tvdb_token and time.time() < _tvdb_token_expires:
        return _tvdb_token

    api_key = config.get('tvdb_api_key', '')
    if not api_key:
        return None

    try:
        r = requests.post(
            f'{_TVDB_BASE}/login',
            json={'apikey': api_key},
            timeout=10,
        )
        data = r.json()
        token = data.get('data', {}).get('token')
        if r.ok and token:
            _tvdb_token         = token
            _tvdb_token_expires = time.time() + 29 * 24 * 3600  # 29 days
            print('[tvdb] authenticated OK')
            return _tvdb_token
        print(f'[tvdb] auth failed: {data.get("message", r.status_code)}')
    except Exception as e:
        print(f'[tvdb] auth error: {e}')
    return None


def tvdb_search_poster(title, is_episode=False):
    """
    Search TVDB for a poster image URL.
    Tries the specific type first, falls back to open search.
    Returns a URL string or None.
    """
    if not config.get('enable_posters') or not config.get('tvdb_api_key'):
        return None

    token = tvdb_get_token()
    if not token:
        return None

    headers = {'Authorization': f'Bearer {token}'}
    search_type = 'series' if is_episode else 'movie'

    for params in [
        {'query': title, 'type': search_type, 'limit': 3},
        {'query': title, 'limit': 3},                      # fallback: no type filter
    ]:
        try:
            r = requests.get(
                f'{_TVDB_BASE}/search',
                params=params,
                headers=headers,
                timeout=10,
            )
            if not r.ok:
                continue
            results = r.json().get('data') or []
            for result in results:
                url = result.get('imageUrl') or result.get('image_url')
                if url:
                    return url
        except Exception as e:
            print(f'[tvdb] search error for "{title}": {e}')
            break

    return None


# ── Library scanner ───────────────────────────────────────────────────────────
def scan_library():
    global scan_status
    if scan_status['running']:
        return {'error': 'Scan already in progress'}

    def _run():
        global scan_status
        scan_status = {'running': True, 'scanned': 0, 'total': 0}
        try:
            all_files = []
            for root, _, files in os.walk(WATCH_DIR):
                for f in files:
                    if f.lower().endswith(VIDEO_EXTENSIONS):
                        all_files.append(os.path.join(root, f))

            scan_status['total'] = len(all_files)
            print(f"[scan] found {len(all_files)} video files")

            folder_counts = Counter(str(Path(fp).parent) for fp in all_files)
            poster_cache  = {}   # cache_key → url|None (fetch once per title/show)

            for fp in all_files:
                info = parse_media_info(fp)
                if info:
                    is_show = info.get('media_type') == 'show'
                    # For shows, flag sibling videos only if they're in the same season folder
                    # but don't treat it as an alert — that's normal for shows
                    info['has_sibling_videos'] = 1 if (
                        folder_counts[str(Path(fp).parent)] > 1 and not is_show
                    ) else 0

                    # Use show_name as cache key for shows (avoids searching by "Season 1")
                    cache_key = info['show_name'] if is_show and info.get('show_name') else info['folder_name']
                    if cache_key not in poster_cache:
                        poster_cache[cache_key] = tvdb_search_poster(cache_key, is_show)

                    info['poster_url'] = poster_cache.get(cache_key)
                    upsert_media_file(info)
                scan_status['scanned'] += 1

            print(f"[scan] complete — {scan_status['scanned']} files processed")
        except Exception as e:
            print(f"[scan] error: {e}")
        finally:
            scan_status['running'] = False

    threading.Thread(target=_run, daemon=True).start()
    return {'status': 'started'}


def get_multi_video_folders():
    with db() as conn:
        rows = conn.execute('''
            SELECT folder_name,
                   GROUP_CONCAT(filename, '|||') AS files,
                   COUNT(*) AS cnt
            FROM media_files
            WHERE has_sibling_videos = 1
              AND (media_type IS NULL OR media_type = 'movie')
            GROUP BY folder_name
            HAVING cnt > 1
        ''').fetchall()
    return [
        {'folder': r['folder_name'], 'files': r['files'].split('|||'), 'count': r['cnt']}
        for r in rows
    ]


# ── Audio / subtitle track selection ─────────────────────────────────────────
def select_audio_tracks(audio_tracks):
    """
    Keep the highest-quality track per approved language.
    Tracks with action='drop' are always excluded.
    If no approved languages remain after filtering (foreign film), keep all non-dropped tracks.
    """
    active   = [t for t in audio_tracks if t.get('action') != 'drop']
    approved = [t for t in active if normalize_lang(t.get('lang', '')) in APPROVED_AUDIO_LANGS]

    if not approved:
        return active  # foreign film — keep everything non-dropped

    best = {}
    for t in approved:
        lang = normalize_lang(t.get('lang', ''))
        q    = AUDIO_QUALITY.get(t.get('codec', '').lower(), 0)
        if lang not in best or q > AUDIO_QUALITY.get(best[lang].get('codec', '').lower(), 0):
            best[lang] = t

    return list(best.values())


def select_subtitle_tracks(subtitle_tracks):
    return [
        t for t in subtitle_tracks
        if t.get('action') != 'drop'
        and normalize_lang(t.get('lang', '')) in APPROVED_SUB_LANGS
    ]


# ── Size estimation ───────────────────────────────────────────────────────────
def estimate_output_size(row):
    """
    Predict encoded file size (bytes) for hevc_nvenc CQ 20.
    Rough but useful — based on source codec, bitrate, resolution, and duration.
    """
    duration    = row['duration_seconds'] or 0
    height      = row['video_height']     or 1080
    codec       = (row['video_codec']     or '').lower()
    src_bitrate = row['video_bitrate']    or 0

    audio_tracks  = json.loads(row['audio_tracks']    or '[]')
    selected_audio = select_audio_tracks(audio_tracks)

    # ── Video estimate ────────────────────────────────────────────────────────
    # Target: hevc_nvenc CQ 20 at 1080p ≈ 3–5 Mbps average
    target_video_bps = 4_000_000  # 4 Mbps baseline

    if height > 1080:
        # 4K → 1080p: resolution factor (1080/2160)² ≈ 0.25 + codec efficiency
        # Typically 10–20% of the original 4K remux size
        target_video_bps = 4_000_000
    elif src_bitrate > 0 and codec in ('hevc', 'h265'):
        # Already H.265 1080p → re-encode at CQ 20: ~50–70% of original
        target_video_bps = src_bitrate * 0.6
    elif src_bitrate > 0:
        # H.264 / other → H.265: ~40–55% of original
        target_video_bps = src_bitrate * 0.45

    video_bytes = target_video_bps * duration / 8

    # ── Audio estimate (passthrough bitrates) ─────────────────────────────────
    AUDIO_BPS = {
        'truehd': 4_000_000, 'flac': 2_000_000, 'dts': 1_500_000,
        'eac3': 640_000, 'ac3': 640_000, 'aac': 256_000,
        'mp3': 320_000, 'opus': 256_000, 'vorbis': 256_000,
    }
    audio_bytes = 0
    for t in selected_audio:
        bps = t.get('bitrate') or AUDIO_BPS.get(t.get('codec', '').lower(), 512_000)
        audio_bytes += bps * duration / 8

    return int(video_bytes + audio_bytes + 5_000_000)  # +5 MB container overhead


# ── FFmpeg command builder ────────────────────────────────────────────────────
def build_ffmpeg_cmd(filepath, output_path, row):
    audio_tracks    = json.loads(row['audio_tracks']    or '[]')
    subtitle_tracks = json.loads(row['subtitle_tracks'] or '[]')
    height          = row['video_height'] or 0

    sel_audio = select_audio_tracks(audio_tracks)
    sel_subs  = select_subtitle_tracks(subtitle_tracks)

    cmd = [
        'ffmpeg', '-y',
        # Structured progress → stdout (newline-separated key=value).
        # -nostats suppresses the \r-overwritten stats line on stderr so
        # stderr carries only warnings/errors (safe to buffer until done).
        '-progress', 'pipe:1',
        '-nostats',
        # CPU decode → GPU encode (hevc_nvenc).
        # Avoids requiring libnvcuvid (NVDEC) which can be missing even
        # when libnvidia-encode (NVENC) is present. CPU decoding adds
        # negligible overhead vs. GPU encoding on REMUX sources.
        '-i', filepath,
        '-map', '0:v:0',
    ]
    for t in sel_audio:
        cmd += ['-map', f'0:a:{t["audio_idx"]}']
    for t in sel_subs:
        cmd += ['-map', f'0:s:{t["sub_idx"]}']

    cmd += [
        '-c:v', 'hevc_nvenc',
        '-preset:v', 'p4',
        '-cq:v', '20',
        '-profile:v', 'main10',
        '-rc-lookahead', '20',   # default is 32; reduce to lower RAM usage
    ]

    if height > 1080:
        cmd += ['-vf', 'scale=-2:1080']

    cmd += ['-c:a', 'copy']
    if sel_subs:
        cmd += ['-c:s', 'copy']

    # Explicitly set container format — ffmpeg can't infer it from .encoding.tmp
    cmd += ['-f', 'matroska', output_path]
    return cmd


# ── FFmpeg progress parsing ───────────────────────────────────────────────────
# ffmpeg -progress pipe:1 emits newline-separated key=value pairs, e.g.:
#   out_time_us=51234567000
#   speed=1.50x
#   progress=continue   (or "end" when finished)
# We accumulate key/value pairs and emit an update on each "progress=" line.

def parse_progress_output(stdout_iter):
    """Generator that yields (elapsed_seconds, speed_str) for each ffmpeg
    progress report block (triggered by the "progress=..." sentinel line).
    Reads from an iterable of stdout lines (newline-terminated).
    """
    block = {}
    for raw in stdout_iter:
        line = raw.strip()
        if '=' not in line:
            continue
        key, _, val = line.partition('=')
        block[key] = val
        if key == 'progress':
            # Emit one update per complete block
            try:
                elapsed = int(block.get('out_time_us', 0)) / 1_000_000
            except ValueError:
                elapsed = None
            speed_raw = block.get('speed', '').strip()
            speed = speed_raw if speed_raw and speed_raw != 'N/A' else ''
            if elapsed is not None:
                yield elapsed, speed
            block = {}


# ── Health verification ───────────────────────────────────────────────────────
def verify_encoded_file(original_path, encoded_path):
    """Return (ok: bool, message: str)."""
    try:
        enc = run_ffprobe(encoded_path)
        if not enc:
            return False, 'Cannot read encoded file with ffprobe'

        # Duration check
        orig = run_ffprobe(original_path)
        if orig:
            orig_dur = float(orig.get('format', {}).get('duration') or 0)
            enc_dur  = float(enc.get('format', {}).get('duration')  or 0)
            if abs(orig_dur - enc_dur) > 10:
                return False, f'Duration mismatch: {orig_dur:.1f}s vs {enc_dur:.1f}s'

        # Video stream check
        if not any(s.get('codec_type') == 'video' for s in enc.get('streams', [])):
            return False, 'No video stream found in encoded file'

        # Sanity size check (encoded must be > 5% of original)
        enc_size  = os.path.getsize(encoded_path)
        orig_size = os.path.getsize(original_path)
        if enc_size < orig_size * 0.05:
            return False, f'Encoded file suspiciously small ({enc_size / 1e9:.2f} GB)'

        return True, 'OK'
    except Exception as e:
        return False, str(e)


# ── Encode job runner ─────────────────────────────────────────────────────────
def _fail_job(job_id, filepath, tmp_path, error):
    if tmp_path and os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    with db() as conn:
        conn.execute(
            "UPDATE encode_jobs SET status='failed', error_text=?, "
            "completed_at=datetime('now') WHERE id=?",
            (error, job_id),
        )
        conn.execute(
            "UPDATE media_files SET encode_status='failed' WHERE filepath=?",
            (filepath,),
        )
    log('error', f"[encode] job {job_id} failed: {error}")
    folder_name = Path(filepath).parent.name
    filename    = Path(filepath).name
    send_ntfy_notification(
        f"Encode Failed: {folder_name}",
        f"File: {filename}\nError: {error}",
        tags='rotating_light,x',
        priority='high',
    )


def run_encode_job(job_id):
    global active_proc, active_job_id

    with db() as conn:
        job = conn.execute(
            'SELECT * FROM encode_jobs WHERE id=?', (job_id,)
        ).fetchone()
        if not job:
            log('warn', f"[encode] job {job_id} not found in DB — skipping")
            return
        if job['status'] in ('cancelled', 'done', 'failed'):
            log('info', f"[encode] job {job_id} already in terminal state '{job['status']}' — skipping")
            return
        mf = conn.execute(
            'SELECT * FROM media_files WHERE filepath=?', (job['filepath'],)
        ).fetchone()

    if not mf:
        _fail_job(job_id, job['filepath'], None, 'Media record not found in DB')
        return
    log('info', f"[encode] job {job_id} picked up — {Path(job['filepath']).name}")

    filepath = job['filepath']
    tmp_path = filepath + '.encoding.tmp'

    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    try:
        with db() as conn:
            conn.execute(
                "UPDATE encode_jobs SET status='encoding', started_at=datetime('now') WHERE id=?",
                (job_id,),
            )
            conn.execute(
                "UPDATE media_files SET encode_status='encoding' WHERE filepath=?",
                (filepath,),
            )
    except Exception as e:
        _fail_job(job_id, filepath, tmp_path, f'DB error before encode start: {e}')
        return

    cmd      = build_ffmpeg_cmd(filepath, tmp_path, dict(mf))
    duration = mf['duration_seconds'] or 0
    log('info', f"[encode] job {job_id} starting — {Path(filepath).name}")
    log('info', f"[encode] cmd: {' '.join(cmd)}")

    stderr_lines = []

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,   # -progress pipe:1 → structured key=value
            stderr=subprocess.PIPE,   # errors only (-nostats suppresses stats)
            text=True, bufsize=1,
        )
        with encode_lock:
            active_proc   = proc
            active_job_id = job_id

        # Read structured progress from stdout; stderr is buffered for errors.
        for elapsed, speed in parse_progress_output(proc.stdout):
            if duration > 0:
                progress = min(elapsed / duration * 100, 99.0)
                eta = None
                try:
                    if speed:
                        rate = float(speed.rstrip('x'))
                        if rate > 0:
                            eta = int((duration - elapsed) / rate)
                except (ValueError, ZeroDivisionError):
                    pass
                with db() as conn:
                    conn.execute(
                        'UPDATE encode_jobs SET progress=?, speed=?, eta_seconds=? WHERE id=?',
                        (round(progress, 1), speed, eta, job_id),
                    )

        proc.wait()
        stderr_lines = proc.stderr.read().splitlines()
        retcode = proc.returncode

    except Exception as e:
        with encode_lock:
            active_proc   = None
            active_job_id = None
        _fail_job(job_id, filepath, tmp_path, str(e))
        return
    finally:
        with encode_lock:
            active_proc   = None
            active_job_id = None

    if retcode != 0:
        err_tail = '\n'.join(stderr_lines[-10:]) if stderr_lines else ''
        log('error', f"[encode] job {job_id} ffmpeg stderr:\n{err_tail}")
        _fail_job(job_id, filepath, tmp_path, f'ffmpeg exited with code {retcode}')
        return

    ok, msg = verify_encoded_file(filepath, tmp_path)
    if not ok:
        _fail_job(job_id, filepath, tmp_path, f'Health check failed: {msg}')
        return

    encoded_size = os.path.getsize(tmp_path)
    try:
        os.replace(tmp_path, filepath)
    except OSError as e:
        _fail_job(job_id, filepath, tmp_path, f'Failed to replace original: {e}')
        return

    # Re-scan the freshly encoded file
    new_info = parse_media_info(filepath)
    with db() as conn:
        conn.execute(
            "UPDATE encode_jobs SET status='done', progress=100.0, "
            "completed_at=datetime('now'), encoded_size=? WHERE id=?",
            (encoded_size, job_id),
        )
        if new_info:
            new_info['has_sibling_videos'] = mf['has_sibling_videos']
            new_info['encode_status']      = 'done'
            # upsert via raw execute to include encode_status
            conn.execute('''
                UPDATE media_files SET
                    size_bytes=:size_bytes, video_codec=:video_codec,
                    video_width=:video_width, video_height=:video_height,
                    video_bitrate=:video_bitrate, audio_tracks=:audio_tracks,
                    subtitle_tracks=:subtitle_tracks, status='OK',
                    encode_status='done', scanned_at=datetime('now')
                WHERE filepath=:filepath
            ''', new_info)
        else:
            conn.execute(
                "UPDATE media_files SET encode_status='done', status='OK', "
                "size_bytes=? WHERE filepath=?",
                (encoded_size, filepath),
            )

    orig_size    = mf['size_bytes'] or encoded_size
    savings_pct  = (1 - encoded_size / orig_size) * 100 if orig_size > 0 else 0
    orig_h       = mf['video_height'] or 0
    new_h        = new_info['video_height'] if new_info else orig_h
    res_str      = f"{orig_h}p → {new_h}p" if new_h and new_h != orig_h else f"{new_h or orig_h}p"
    log('info',
        f"[encode] job {job_id} done — "
        f"{orig_size/1e9:.2f} GB → {encoded_size/1e9:.2f} GB "
        f"(saved {savings_pct:.0f}%, {res_str})"
    )
    send_ntfy_notification(
        f"Encode Complete: {mf['folder_name']}",
        f"File: {mf['filename']}\n"
        f"Size: {orig_size/1e9:.2f} GB → {encoded_size/1e9:.2f} GB  ({savings_pct:.0f}% saved)\n"
        f"Resolution: {res_str}",
        tags='white_check_mark,movie_camera',
        attach_url=mf['poster_url'] if mf['poster_url'] else None,
    )


def encode_worker_loop():
    """Single-threaded worker — processes encode jobs one at a time (one GPU)."""
    log('info', '[encode] worker thread started')
    while True:
        try:
            job_id = encode_queue.get(timeout=2)
        except Exception:
            continue
        try:
            run_encode_job(job_id)
        except Exception as e:
            log('error', f"[encode] unhandled error in job {job_id}: {e}")
        encode_queue.task_done()


def queue_encode_jobs(file_ids):
    """Insert encode jobs and push them onto the worker queue.

    encode_queue.put() is called AFTER the transaction commits so the worker
    never reads a job_id before the INSERT is visible to other connections.
    """
    queued = []
    with db() as conn:
        for fid in file_ids:
            mf = conn.execute(
                'SELECT * FROM media_files WHERE id=?', (fid,)
            ).fetchone()
            if not mf:
                continue
            existing = conn.execute(
                "SELECT id FROM encode_jobs WHERE filepath=? AND status IN ('queued','encoding')",
                (mf['filepath'],),
            ).fetchone()
            if existing:
                continue
            cursor = conn.execute(
                'INSERT INTO encode_jobs (media_file_id, filepath, original_size) VALUES (?,?,?)',
                (fid, mf['filepath'], mf['size_bytes']),
            )
            job_id = cursor.lastrowid
            conn.execute(
                "UPDATE media_files SET encode_status='queued' WHERE id=?", (fid,)
            )
            queued.append(job_id)
    # Push onto the queue only after the transaction has committed
    for job_id in queued:
        encode_queue.put(job_id)
    return queued


# ── Subtitle translation pipeline ────────────────────────────────────────────
_SRT_SYSTEM_PROMPT = (
    "You are an expert Cuban Spanish subtitle translator.\n\n"
    "CRITICAL RULES — follow every one or the subtitle file will be broken:\n"
    "1. Preserve ALL subtitle block numbers exactly as given.\n"
    "2. Preserve ALL timestamps exactly as given "
    "(e.g. 00:01:23,456 --> 00:01:26,789).\n"
    "3. Translate ONLY the dialogue text lines — never modify numbers or timestamps.\n"
    "4. Use authentic Cuban expressions, idioms, and vocabulary where they fit naturally.\n"
    "5. Preserve any HTML-like formatting tags: <i>, <b>, <u>.\n"
    "6. Do NOT add or remove subtitle blocks.\n"
    "7. Return ONLY the raw SRT content — no explanations, no markdown, no code fences."
)


def is_image_based_subtitle(codec):
    return (codec or '').lower() in IMAGE_BASED_SUB_CODECS


def extract_subtitle_to_srt(filepath, sub_stream_idx, output_path):
    """Extract subtitle track at position sub_stream_idx to SRT via ffmpeg.

    No timeout — large remux files (40-50 GB BluRay) can take several minutes
    to demux even a single subtitle stream.  This always runs inside the
    translation worker thread so there is no risk of blocking the Flask server.
    """
    cmd = [
        'ffmpeg', '-y',
        '-fflags', '+genpts',   # helps with malformed PTS in remux streams
        '-i', filepath,
        '-map', f'0:s:{sub_stream_idx}',
        '-c:s', 'srt',
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=None)
    if result.returncode != 0:
        log('error', f'[translate] subtitle extract stderr: {result.stderr[-500:]}')
    return result.returncode == 0


def chunk_srt_content(content, max_blocks=350):
    """Split SRT content into chunks of at most max_blocks subtitle blocks."""
    blocks = re.split(r'\n\n+', content.strip())
    return [
        '\n\n'.join(blocks[i:i + max_blocks])
        for i in range(0, len(blocks), max_blocks)
    ]


def translate_srt_chunk(content, source_lang=''):
    """Send one SRT chunk to the OpenAI API and return the translated text."""
    api_key = config.get('openai_api_key', '')
    if not api_key:
        raise ValueError('OpenAI API key not configured')

    from openai import OpenAI
    client = OpenAI(api_key=api_key)

    src_note = f" from {source_lang}" if source_lang else ''
    response = client.chat.completions.create(
        model=config.get('openai_model', 'gpt-4o-mini'),
        messages=[
            {'role': 'system', 'content': _SRT_SYSTEM_PROMPT},
            {'role': 'user',   'content': f'Translate this subtitle file{src_note} to Cuban Spanish:\n\n{content}'},
        ],
        temperature=0.3,
    )
    translated = response.choices[0].message.content.strip()
    # Strip any markdown code fences GPT adds despite instructions
    translated = re.sub(r'^```[a-z]*\n?', '', translated, flags=re.MULTILINE)
    translated = re.sub(r'\n?```$',        '', translated, flags=re.MULTILINE)
    return translated.strip()


def translate_subtitle_file(srt_path, source_lang='', progress_cb=None):
    """
    Translate a full SRT file to Cuban Spanish, chunking if needed.
    progress_cb(pct: float, detail: str) is called periodically.
    Returns the translated SRT content as a string.
    """
    with open(srt_path, encoding='utf-8', errors='replace') as f:
        content = f.read()

    if not content.strip():
        raise ValueError('Extracted subtitle file is empty')

    chunks = chunk_srt_content(content)
    if not chunks:
        raise ValueError('Could not parse subtitle content into blocks')

    translated_parts = []
    for i, chunk in enumerate(chunks):
        if progress_cb:
            progress_cb((i / len(chunks)) * 100, f'Translating part {i + 1}/{len(chunks)}…')
        translated_parts.append(translate_srt_chunk(chunk, source_lang))

    if progress_cb:
        progress_cb(95, 'Assembling translated file…')

    return '\n\n'.join(translated_parts)


def mux_subtitle_into_video(filepath, srt_path):
    """
    Add a Spanish (Cuban) subtitle track from srt_path into the video at filepath.
    Returns (ok: bool, message: str).
    """
    tmp_path  = filepath + '.subtrans.tmp'
    orig_data = run_ffprobe(filepath)
    if not orig_data:
        return False, 'Cannot read original file with ffprobe'

    existing_subs = [
        s for s in orig_data.get('streams', []) if s.get('codec_type') == 'subtitle'
    ]
    new_sub_idx = len(existing_subs)

    cmd = [
        'ffmpeg', '-y',
        '-i', filepath,
        '-i', srt_path,
        '-map', '0',
        '-map', '1:0',
        '-c', 'copy',
        f'-metadata:s:s:{new_sub_idx}', 'language=spa',
        f'-metadata:s:s:{new_sub_idx}', 'title=Spanish (Cuban)',
        '-f', 'matroska',
        tmp_path,
    ]

    # No timeout — muxing a 40-50 GB remux can take longer than 5 minutes.
    # Runs in the translation worker thread, never blocks Flask.
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=None)
    if result.returncode != 0:
        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except OSError: pass
        return False, f'ffmpeg mux error: {result.stderr[-500:]}'

    # Sanity check: output should have one more subtitle stream
    new_data = run_ffprobe(tmp_path)
    if new_data:
        new_subs = [s for s in new_data.get('streams', []) if s.get('codec_type') == 'subtitle']
        if len(new_subs) <= new_sub_idx:
            os.remove(tmp_path)
            return False, 'Subtitle track count did not increase after mux'

    try:
        os.replace(tmp_path, filepath)
    except OSError as e:
        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except OSError: pass
        return False, f'Failed to replace original file: {e}'

    return True, 'OK'


def _fail_translation_job(job_id, error):
    with db() as conn:
        conn.execute(
            "UPDATE translation_jobs SET status='failed', error_text=?, "
            "completed_at=datetime('now') WHERE id=?",
            (error, job_id),
        )
        job = conn.execute(
            'SELECT filepath FROM translation_jobs WHERE id=?', (job_id,)
        ).fetchone()
    log('error', f"[translate] job {job_id} failed: {error}")
    if job:
        folder_name = Path(job['filepath']).parent.name
        filename    = Path(job['filepath']).name
        send_ntfy_notification(
            f"Translation Failed: {folder_name}",
            f"File: {filename}\nError: {error}",
            tags='rotating_light,x',
            priority='high',
        )


def run_translation_job(job_id):
    with db() as conn:
        job = conn.execute(
            'SELECT * FROM translation_jobs WHERE id=?', (job_id,)
        ).fetchone()
        if not job or job['status'] in ('cancelled', 'done', 'failed'):
            return
        mf = conn.execute(
            'SELECT * FROM media_files WHERE filepath=?', (job['filepath'],)
        ).fetchone()

    if not mf:
        _fail_translation_job(job_id, 'Media record not found in DB')
        return

    filepath    = job['filepath']
    sub_idx     = job['source_sub_idx']
    source_lang = job['source_lang'] or ''

    path        = Path(filepath)
    srt_path    = str(path.parent / (path.stem + '.es.srt'))
    tmp_srt     = filepath + f'.sub{sub_idx}.extracting.srt'

    def set_progress(pct, detail=''):
        with db() as conn:
            conn.execute(
                'UPDATE translation_jobs SET progress=?, progress_detail=? WHERE id=?',
                (round(pct, 1), detail, job_id),
            )

    try:
        # 1 ── Extract
        with db() as conn:
            conn.execute(
                "UPDATE translation_jobs SET status='extracting', started_at=datetime('now') WHERE id=?",
                (job_id,),
            )
        set_progress(5, 'Extracting subtitle track…')

        if not extract_subtitle_to_srt(filepath, sub_idx, tmp_srt) or not os.path.exists(tmp_srt):
            _fail_translation_job(job_id, 'ffmpeg could not extract subtitle track as SRT')
            return

        # 2 ── Translate
        with db() as conn:
            conn.execute(
                "UPDATE translation_jobs SET status='translating' WHERE id=?", (job_id,)
            )

        translated = translate_subtitle_file(
            tmp_srt, source_lang,
            progress_cb=lambda pct, detail: set_progress(10 + pct * 0.75, detail),
        )

        # 3 ── Save .srt alongside video
        set_progress(87, 'Saving .srt file…')
        with open(srt_path, 'w', encoding='utf-8') as f:
            f.write(translated)

        # 4 ── Mux into video
        with db() as conn:
            conn.execute(
                "UPDATE translation_jobs SET status='muxing', srt_path=? WHERE id=?",
                (srt_path, job_id),
            )
        set_progress(90, 'Muxing subtitle into video file…')

        ok, msg = mux_subtitle_into_video(filepath, srt_path)
        if not ok:
            _fail_translation_job(job_id, f'Mux failed: {msg}')
            return

        # 5 ── Refresh media record
        set_progress(97, 'Updating media record…')
        new_info = parse_media_info(filepath)
        if new_info:
            with db() as conn:
                row = conn.execute(
                    'SELECT has_sibling_videos, encode_status FROM media_files WHERE filepath=?',
                    (filepath,),
                ).fetchone()
                new_info['has_sibling_videos'] = (row['has_sibling_videos'] if row else 0)
            upsert_media_file(new_info)
            if row and row['encode_status']:
                with db() as conn:
                    conn.execute(
                        'UPDATE media_files SET encode_status=? WHERE filepath=?',
                        (row['encode_status'], filepath),
                    )

        # 6 ── Done
        with db() as conn:
            conn.execute(
                "UPDATE translation_jobs SET status='done', progress=100.0, "
                "srt_path=?, completed_at=datetime('now') WHERE id=?",
                (srt_path, job_id),
            )

        log('info', f"[translate] job {job_id} done → {srt_path}")
        src_label = source_lang.upper() if source_lang else 'unknown'
        send_ntfy_notification(
            f"Subtitle Ready: {mf['folder_name']}",
            f"File: {mf['filename']}\n"
            f"Translated: {src_label} → Spanish\n"
            f"Saved as: {Path(srt_path).name}",
            tags='white_check_mark,speech_balloon',
            attach_url=mf['poster_url'] if mf['poster_url'] else None,
        )

    except Exception as e:
        _fail_translation_job(job_id, str(e))
    finally:
        if os.path.exists(tmp_srt):
            try: os.remove(tmp_srt)
            except OSError: pass


def translation_worker_loop():
    """Translation runs independently of encoding (API/IO-bound, not GPU-bound)."""
    while True:
        try:
            job_id = translation_queue.get(timeout=2)
        except Exception:
            continue
        try:
            run_translation_job(job_id)
        except Exception as e:
            log('error', f"[translate] unhandled error in job {job_id}: {e}")
        translation_queue.task_done()


# ── Notifications ─────────────────────────────────────────────────────────────
def send_ntfy_notification(title, message, tags=None, priority=None, attach_url=None):
    if not config.get('enable_ntfy') or not config.get('ntfy_topic'):
        return
    try:
        url     = f"{config['ntfy_server']}/{config['ntfy_topic']}"
        headers = {'Title': title}
        if tags:
            headers['Tags'] = tags
        if priority:
            headers['Priority'] = priority
        if attach_url:
            headers['Attach'] = attach_url
        requests.post(url, data=message, headers=headers, timeout=10)
    except Exception as e:
        print(f"[ntfy] error: {e}")


def send_discord_notification(filepath, status, size, media_info):
    if not config.get('enable_discord') or not config.get('discord_webhook'):
        return
    try:
        path      = Path(filepath)
        title_str = path.parent.name
        filename  = path.stem
        is_ep     = any(x in filename.lower() for x in ['s0', 'e0', 'season', 'episode'])

        embed = {
            'title':       f"New Media Added: {title_str}",
            'description': f"**File:** {filename}",
            'color':       0x00FF00 if status == 'OK' else 0xFF9900,
            'fields': [
                {'name': 'Status', 'value': status,                         'inline': True},
                {'name': 'Size',   'value': f"{size / 1024**3:.2f} GB",     'inline': True},
                {'name': 'Type',   'value': 'Episode' if is_ep else 'Movie', 'inline': True},
            ],
            'timestamp': datetime.utcnow().isoformat(),
            'footer':    {'text': 'Media Monitor'},
        }

        if media_info:
            fmt     = media_info.get('format', {})
            vids    = [s for s in media_info.get('streams', []) if s.get('codec_type') == 'video']
            auds    = [s for s in media_info.get('streams', []) if s.get('codec_type') == 'audio']
            if vids:
                v = vids[0]
                embed['fields'].append({
                    'name':   'Video',
                    'value':  f"{v.get('codec_name','?')} {v.get('width','?')}×{v.get('height','?')}",
                    'inline': True,
                })
            if auds:
                embed['fields'].append({
                    'name':   'Audio',
                    'value':  f"{auds[0].get('codec_name','?')} ({len(auds)} track(s))",
                    'inline': True,
                })
            embed['fields'].append({
                'name':   'Duration',
                'value':  f"{float(fmt.get('duration') or 0) / 60:.1f} min",
                'inline': True,
            })

        # Poster thumbnail — check DB first, then fall back to live TVDB search
        poster_url = None
        try:
            with db() as conn:
                row = conn.execute(
                    'SELECT poster_url FROM media_files WHERE filepath=?', (filepath,)
                ).fetchone()
            if row and row['poster_url']:
                poster_url = row['poster_url']
            else:
                poster_url = tvdb_search_poster(title_str, is_ep)
        except Exception:
            pass

        if poster_url:
            embed['thumbnail'] = {'url': poster_url}

        requests.post(config['discord_webhook'], json={'embeds': [embed]}, timeout=10)
    except Exception as e:
        print(f"[discord] error: {e}")


# ── File analysis (called by watchdog) ───────────────────────────────────────
def is_already_processed(filepath):
    with db() as conn:
        return conn.execute(
            'SELECT 1 FROM processed_files WHERE filepath=?', (filepath,)
        ).fetchone() is not None


def mark_as_processed(filepath, status, size):
    with db() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO processed_files '
            '(filepath, status, size, processed_at) VALUES (?,?,?,?)',
            (filepath, status, size, datetime.now()),
        )


def wait_for_stable_file(filepath):
    last_size    = -1
    stable_count = 0
    while stable_count < STABILIZE_CHECKS:
        try:
            current = os.path.getsize(filepath)
            if current == last_size:
                stable_count += 1
            else:
                stable_count = 0
                last_size    = current
            time.sleep(STABILIZE_INTERVAL)
        except FileNotFoundError:
            return False
    return True


def analyze_file(filepath):
    print(f"[{threading.current_thread().name}] analyzing: {filepath}")

    if is_already_processed(filepath):
        print(f"[analyze] already processed: {filepath}")
        return

    print(f"[analyze] waiting for stable file: {filepath}")
    if not wait_for_stable_file(filepath):
        print(f"[analyze] file disappeared: {filepath}")
        return

    try:
        size         = os.path.getsize(filepath)
        ffprobe_data = run_ffprobe(filepath)
        if not ffprobe_data:
            print(f"[analyze] could not read: {filepath}")
            return

        info = parse_media_info(filepath)
        if info:
            folder   = str(Path(filepath).parent)
            siblings = [f for f in os.listdir(folder) if f.lower().endswith(VIDEO_EXTENSIONS)]
            is_show = info.get('media_type') == 'show'
            info['has_sibling_videos'] = 1 if (len(siblings) > 1 and not is_show) else 0

            is_show = info.get('media_type') == 'show'
            cache_key = info['show_name'] if is_show and info.get('show_name') else info['folder_name']
            info['poster_url'] = tvdb_search_poster(cache_key, is_show)
            upsert_media_file(info)

            if info['has_sibling_videos'] and info.get('media_type') != 'show':
                sibling_list = '\n'.join(f'• {f}' for f in siblings)
                send_ntfy_notification(
                    f"Multiple Videos: {info['folder_name']}",
                    f"Multiple video files detected:\n{sibling_list}",
                    tags='warning,rotating_light',
                    priority='high',
                )

        audio_streams = json.loads(info['audio_tracks'])    if info else []
        sub_streams   = json.loads(info['subtitle_tracks']) if info else []
        status_str    = determine_status(size, audio_streams, sub_streams)

        # Rich new-file notification
        codec_str  = (f"{info['video_codec'].upper()} "
                      f"{info['video_width']}×{info['video_height']}") if info else '?'
        dur_min    = int((info['duration_seconds'] or 0) // 60) if info else 0
        size_gb    = size / 1e9
        lang_list  = ', '.join(t.get('lang', '?') for t in audio_streams) or 'unknown'
        body = (
            f"File: {os.path.basename(filepath)}\n"
            f"Status: {status_str}\n"
            f"Video: {codec_str}  •  {size_gb:.2f} GB  •  {dur_min} min\n"
            f"Audio: {lang_list}"
        )
        if 'RE-ENCODE' in status_str or 'REMUX' in status_str:
            ntfy_tags, ntfy_priority = 'rotating_light,movie_camera', 'high'
        else:
            ntfy_tags, ntfy_priority = 'white_check_mark,movie_camera', 'default'
        poster = info.get('poster_url') if info else None
        send_ntfy_notification(
            Path(filepath).parent.name,
            body,
            tags=ntfy_tags,
            priority=ntfy_priority,
            attach_url=poster,
        )
        send_discord_notification(filepath, status_str, size, ffprobe_data)
        mark_as_processed(filepath, status_str, size)

        print(f"[analyze] done: {filepath} — {status_str}")

    except Exception as e:
        print(f"[analyze] error {filepath}: {e}")


# ── Watchdog ──────────────────────────────────────────────────────────────────
class MediaFileHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and event.src_path.lower().endswith(VIDEO_EXTENSIONS):
            executor.submit(analyze_file, event.src_path)

    def on_moved(self, event):
        if not event.is_directory and event.dest_path.lower().endswith(VIDEO_EXTENSIONS):
            executor.submit(analyze_file, event.dest_path)


def start_monitoring():
    print(f"[monitor] watching: {WATCH_DIR}")
    handler  = MediaFileHandler()
    observer = Observer()
    observer.schedule(handler, WATCH_DIR, recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


# ── Flask routes — existing ───────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', config=config)


@app.route('/api/config', methods=['GET'])
def get_config_route():
    return jsonify(config)


@app.route('/api/config', methods=['POST'])
def update_config_route():
    global config
    config.update(request.json)
    save_config()
    return jsonify({'status': 'success', 'config': config})


@app.route('/api/test/ntfy', methods=['POST'])
def test_ntfy():
    send_ntfy_notification('Test Notification', 'This is a test from Media Monitor!', tags='test_tube')
    return jsonify({'status': 'success', 'message': 'Test notification sent'})


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
        return jsonify({'status': 'success', 'message': f'HTTP {r.status_code}'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/stats')
def get_stats():
    with db() as conn:
        total     = conn.execute('SELECT COUNT(*) FROM processed_files').fetchone()[0]
        by_status = dict(conn.execute(
            'SELECT status, COUNT(*) FROM processed_files GROUP BY status'
        ).fetchall())
    return jsonify({
        'total':      total,
        'by_status':  by_status,
        'watch_dir':  WATCH_DIR,
        'max_workers': MAX_WORKERS,
    })


# ── Flask routes — media library ──────────────────────────────────────────────
@app.route('/api/media')
def get_media():
    f = request.args.get('filter', 'all')
    t = request.args.get('type', 'movie')
    # Validate type to prevent injection (only allow known values)
    if t not in ('movie', 'show'):
        t = 'movie'
    tc = f" AND (media_type = '{t}' OR media_type IS NULL)" if t == 'movie' else f" AND media_type = '{t}'"

    queries = {
        'needs_encoding': (
            f"SELECT * FROM media_files "
            f"WHERE status LIKE '%RE-ENCODE%' "
            f"AND (encode_status IS NULL OR encode_status='failed'){tc} "
            f"ORDER BY size_bytes DESC"
        ),
        'needs_remux': (
            f"SELECT * FROM media_files "
            f"WHERE status LIKE '%REMUX%' "
            f"AND (encode_status IS NULL OR encode_status='failed'){tc} "
            f"ORDER BY size_bytes DESC"
        ),
        'queued': (
            f"SELECT * FROM media_files WHERE encode_status IN ('queued','encoding'){tc} "
            f"ORDER BY scanned_at DESC"
        ),
        'done': (
            f"SELECT * FROM media_files WHERE encode_status='done'{tc} ORDER BY scanned_at DESC"
        ),
        'alerts': (
            f"SELECT * FROM media_files WHERE has_sibling_videos=1{tc} ORDER BY folder_name"
        ),
        'missing_lang': (
            f"SELECT * FROM media_files WHERE status LIKE '%MISSING LANG%'{tc} "
            f"ORDER BY folder_name, filename"
        ),
        'all': (
            f"SELECT * FROM media_files WHERE 1=1{tc} ORDER BY folder_name, filename"
        ),
    }

    sql = queries.get(f, queries['all'])
    with db() as conn:
        rows = conn.execute(sql).fetchall()

    result = []
    for r in rows:
        d                   = dict(r)
        d['audio_tracks']   = json.loads(d['audio_tracks']   or '[]')
        d['subtitle_tracks'] = json.loads(d['subtitle_tracks'] or '[]')
        d['size_gb']        = round((r['size_bytes'] or 0) / 1e9, 2)
        d['estimated_size_gb'] = (
            round(estimate_output_size(r) / 1e9, 2)
            if 'RE-ENCODE' in (r['status'] or '')
            else None
        )
        result.append(d)

    # Library stats filtered by type
    with db() as conn:
        totals = conn.execute(f'''
            SELECT
                COUNT(*)                                         AS total_files,
                COALESCE(SUM(size_bytes), 0)                     AS total_bytes,
                COUNT(CASE WHEN status LIKE '%RE-ENCODE%'
                           AND (encode_status IS NULL OR encode_status='failed')
                           THEN 1 END)                           AS needs_encoding,
                COUNT(CASE WHEN encode_status IN ('queued','encoding') THEN 1 END) AS encoding_active
            FROM media_files
            WHERE 1=1{tc}
        ''').fetchone()

    return jsonify({
        'files':  result,
        'total':  len(result),
        'stats':  dict(totals),
    })


@app.route('/api/media/recalculate-status', methods=['POST'])
def recalculate_status():
    """
    Re-run determine_status() for every row using already-stored track data.
    Much faster than a full scan — no ffprobe, no filesystem access.
    """
    updated = 0
    with db() as conn:
        rows = conn.execute(
            'SELECT id, size_bytes, audio_tracks, subtitle_tracks FROM media_files'
        ).fetchall()
        for row in rows:
            audio_streams = json.loads(row['audio_tracks']    or '[]')
            sub_streams   = json.loads(row['subtitle_tracks'] or '[]')
            new_status    = determine_status(row['size_bytes'] or 0, audio_streams, sub_streams)
            conn.execute(
                'UPDATE media_files SET status=? WHERE id=?',
                (new_status, row['id']),
            )
            updated += 1
    log('info', f'[recalculate] updated status for {updated} files')
    return jsonify({'updated': updated})


@app.route('/api/media/scan', methods=['POST'])
def trigger_scan():
    return jsonify(scan_library())


@app.route('/api/media/scan/status')
def scan_status_route():
    return jsonify(scan_status)


@app.route('/api/media/<int:file_id>/refresh', methods=['POST'])
def refresh_file(file_id):
    with db() as conn:
        row = conn.execute(
            'SELECT filepath, has_sibling_videos FROM media_files WHERE id=?', (file_id,)
        ).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    info = parse_media_info(row['filepath'])
    if not info:
        return jsonify({'error': 'Could not read file'}), 500
    info['has_sibling_videos'] = row['has_sibling_videos']
    upsert_media_file(info)
    return jsonify({'status': 'ok'})


@app.route('/api/media/alerts')
def get_alerts():
    return jsonify({'alerts': get_multi_video_folders()})


# ── Flask routes — track assignment ──────────────────────────────────────────
@app.route('/api/media/<int:file_id>/assign-tracks', methods=['POST'])
def assign_tracks(file_id):
    """
    Save manual language assignments and drop actions for audio/subtitle tracks.
    Body: {
      "audio":     [{"audio_idx": 0, "lang": "eng", "action": "keep"|"drop"}, ...],
      "subtitles": [{"sub_idx":   0, "lang": "spa", "action": "keep"|"drop"}, ...]
    }
    Returns the updated file record and recalculated status.
    """
    data = request.json or {}
    audio_assignments = {a['audio_idx']: a for a in data.get('audio', [])}
    sub_assignments   = {a['sub_idx']:   a for a in data.get('subtitles', [])}

    with db() as conn:
        row = conn.execute('SELECT * FROM media_files WHERE id=?', (file_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Not found'}), 404

        audio_tracks    = json.loads(row['audio_tracks']    or '[]')
        subtitle_tracks = json.loads(row['subtitle_tracks'] or '[]')

    # Apply audio assignments
    for t in audio_tracks:
        assignment = audio_assignments.get(t['audio_idx'])
        if assignment:
            if assignment.get('lang'):
                t['lang']          = assignment['lang']
                t['lang_assigned'] = True
            t['action'] = assignment.get('action', 'keep')

    # Apply subtitle assignments
    for t in subtitle_tracks:
        assignment = sub_assignments.get(t['sub_idx'])
        if assignment:
            if assignment.get('lang'):
                t['lang']          = assignment['lang']
                t['lang_assigned'] = True
            t['action'] = assignment.get('action', 'keep')

    new_status = determine_status(row['size_bytes'], audio_tracks, subtitle_tracks)

    with db() as conn:
        conn.execute(
            'UPDATE media_files SET audio_tracks=?, subtitle_tracks=?, status=? WHERE id=?',
            (json.dumps(audio_tracks), json.dumps(subtitle_tracks), new_status, file_id),
        )

    return jsonify({
        'status':     'ok',
        'new_status': new_status,
        'audio_tracks':    audio_tracks,
        'subtitle_tracks': subtitle_tracks,
    })


# ── Flask routes — encode ─────────────────────────────────────────────────────
@app.route('/api/encode/queue', methods=['POST'])
def api_queue_encode():
    data     = request.json or {}
    file_ids = data.get('file_ids', [])
    if data.get('file_id'):
        file_ids = [data['file_id']]
    if not file_ids:
        return jsonify({'error': 'No file_ids provided'}), 400
    queued = queue_encode_jobs(file_ids)
    return jsonify({'queued': queued, 'count': len(queued)})


@app.route('/api/encode/cancel/<int:job_id>', methods=['POST'])
def cancel_encode(job_id):
    global active_proc, active_job_id

    with encode_lock:
        if active_job_id == job_id and active_proc:
            active_proc.terminate()

    with db() as conn:
        job = conn.execute(
            'SELECT * FROM encode_jobs WHERE id=?', (job_id,)
        ).fetchone()
        if not job:
            return jsonify({'error': 'Job not found'}), 404

        if job['status'] in ('queued', 'encoding'):
            conn.execute(
                "UPDATE encode_jobs SET status='cancelled', completed_at=datetime('now') WHERE id=?",
                (job_id,),
            )
            conn.execute(
                "UPDATE media_files SET encode_status=NULL WHERE filepath=?",
                (job['filepath'],),
            )
            tmp = job['filepath'] + '.encoding.tmp'
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    return jsonify({'status': 'cancelled'})


@app.route('/api/encode/jobs')
def get_encode_jobs():
    with db() as conn:
        rows = conn.execute('''
            SELECT ej.*,
                   mf.folder_name, mf.filename,
                   mf.video_codec, mf.video_height
            FROM encode_jobs ej
            LEFT JOIN media_files mf ON ej.media_file_id = mf.id
            ORDER BY ej.created_at DESC
            LIMIT 100
        ''').fetchall()

    jobs = []
    for r in rows:
        d                    = dict(r)
        d['original_size_gb'] = round((r['original_size'] or 0) / 1e9, 2)
        d['encoded_size_gb']  = (
            round(r['encoded_size'] / 1e9, 2) if r['encoded_size'] else None
        )
        d['savings_pct'] = (
            round((1 - r['encoded_size'] / r['original_size']) * 100, 1)
            if r['encoded_size'] and r['original_size']
            else None
        )
        jobs.append(d)

    return jsonify({'jobs': jobs})


# ── Flask routes — subtitle translation ──────────────────────────────────────
@app.route('/api/media/<int:file_id>/translate-subtitle', methods=['POST'])
def api_translate_subtitle(file_id):
    data    = request.json or {}
    sub_idx = data.get('sub_idx')
    if sub_idx is None:
        return jsonify({'error': 'sub_idx is required'}), 400

    if not config.get('openai_api_key'):
        return jsonify({
            'error': 'OpenAI API key not configured. Add it in the Dashboard settings.'
        }), 400

    with db() as conn:
        mf = conn.execute('SELECT * FROM media_files WHERE id=?', (file_id,)).fetchone()
        if not mf:
            return jsonify({'error': 'File not found'}), 404

        sub_tracks = json.loads(mf['subtitle_tracks'] or '[]')
        track      = next((t for t in sub_tracks if t['sub_idx'] == sub_idx), None)
        if not track:
            return jsonify({'error': f'Subtitle track {sub_idx} not found'}), 404

        if is_image_based_subtitle(track.get('codec', '')):
            return jsonify({
                'error': f"Track #{sub_idx} is image-based ({track.get('codec')}) "
                         f"and cannot be translated. Only text-based tracks (SRT, ASS, SSA) "
                         f"are supported."
            }), 400

        active = conn.execute(
            "SELECT id FROM translation_jobs WHERE filepath=? "
            "AND status IN ('pending','extracting','translating','muxing')",
            (mf['filepath'],),
        ).fetchone()
        if active:
            return jsonify({'error': 'A translation job is already running for this file'}), 400

        cursor = conn.execute(
            'INSERT INTO translation_jobs '
            '(media_file_id, filepath, source_sub_idx, source_lang) VALUES (?,?,?,?)',
            (file_id, mf['filepath'], sub_idx, track.get('lang', '')),
        )
        job_id = cursor.lastrowid

    translation_queue.put(job_id)
    return jsonify({'status': 'queued', 'job_id': job_id})


@app.route('/api/translate/cancel/<int:job_id>', methods=['POST'])
def cancel_translation(job_id):
    with db() as conn:
        job = conn.execute(
            'SELECT * FROM translation_jobs WHERE id=?', (job_id,)
        ).fetchone()
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        if job['status'] not in ('done', 'failed', 'cancelled'):
            conn.execute(
                "UPDATE translation_jobs SET status='cancelled', "
                "completed_at=datetime('now') WHERE id=?",
                (job_id,),
            )
    return jsonify({'status': 'cancelled'})


@app.route('/api/encode/jobs/clear', methods=['POST'])
def clear_encode_jobs():
    """Delete encode jobs that are in a terminal state (done/failed/cancelled)."""
    with db() as conn:
        result = conn.execute(
            "DELETE FROM encode_jobs WHERE status IN ('done', 'failed', 'cancelled')"
        )
    return jsonify({'deleted': result.rowcount})


@app.route('/api/translate/jobs/clear', methods=['POST'])
def clear_translation_jobs():
    """Delete translation jobs that are in a terminal state (done/failed/cancelled)."""
    with db() as conn:
        result = conn.execute(
            "DELETE FROM translation_jobs WHERE status IN ('done', 'failed', 'cancelled')"
        )
    return jsonify({'deleted': result.rowcount})


@app.route('/api/translate/jobs')
def get_translation_jobs():
    with db() as conn:
        rows = conn.execute('''
            SELECT tj.*, mf.folder_name, mf.filename
            FROM translation_jobs tj
            LEFT JOIN media_files mf ON tj.media_file_id = mf.id
            ORDER BY tj.created_at DESC
            LIMIT 50
        ''').fetchall()
    return jsonify({'jobs': [dict(r) for r in rows]})


@app.route('/api/logs')
def get_logs():
    """Return recent log entries from the in-memory ring buffer.
    Optional ?since=N returns only entries with seq > N (for polling).
    """
    since = request.args.get('since', 0, type=int)
    with _log_lock:
        entries = [e for e in _log_buffer if e['seq'] > since]
    return jsonify({'logs': entries, 'total': _log_seq})


# ── Startup ───────────────────────────────────────────────────────────────────
def _recover_queued_jobs():
    """Re-enqueue any encode jobs that were left in 'queued' or 'encoding'
    state from a previous run (e.g. container restart mid-encode).
    'encoding' jobs are reset to 'queued' first since the process is gone.
    """
    with db() as conn:
        conn.execute(
            "UPDATE encode_jobs SET status='queued', progress=0 "
            "WHERE status='encoding'"
        )
        rows = conn.execute(
            "SELECT id FROM encode_jobs WHERE status='queued' ORDER BY created_at"
        ).fetchall()
    for row in rows:
        encode_queue.put(row['id'])
    if rows:
        log('warn', f"[startup] re-queued {len(rows)} interrupted encode job(s)")


if __name__ == '__main__':
    init_db()
    _migrate_db()
    load_config()
    os.makedirs(WATCH_DIR, exist_ok=True)

    _recover_queued_jobs()

    threading.Thread(target=start_monitoring,       daemon=True).start()
    threading.Thread(target=encode_worker_loop,     daemon=True).start()
    threading.Thread(target=translation_worker_loop, daemon=True).start()

    port = int(os.environ.get('PORT', '5000'))
    app.run(host='0.0.0.0', port=port, debug=False)
