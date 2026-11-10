"""
Model Context Protocol (MCP) endpoint for Media Monitor.

Implements the MCP "Streamable HTTP" transport (spec 2025-03-26 and later) on
a single POST endpoint, answering every request with plain JSON. The server
is stateless: no Mcp-Session-Id is issued and no server-initiated SSE stream
is offered (GET returns 405, which the spec allows).

Tools are thin wrappers over the dashboard's own REST handlers, called
in-process through the `api` callable the app passes in, so the AI sees the
same validation, locking and job queues as the web UI.

This module deliberately does not import app.py. The app supplies:
  api(method, path, body=None, query=None) -> ApiResult
  authenticate(authorization_header) -> 'read' | 'full' | None
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from flask import Response, jsonify

SUPPORTED_PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

ENCODE_ACTIVE = ('queued', 'encoding')
TRANSLATION_ACTIVE = ('pending', 'extracting', 'ocr', 'translating', 'styling', 'muxing')

# Config keys that hold credentials. They are never returned over MCP; the AI
# only learns whether each one is set.
SECRET_CONFIG_KEYS = ('openai_api_key', 'gemini_api_key', 'tvdb_api_key', 'discord_webhook', 'ntfy_topic')

INSTRUCTIONS = """\
Media Monitor manages a self-hosted video library: it scans files, flags ones
that need work, re-encodes on the GPU, edits audio/subtitle tracks, translates
or OCRs subtitles, styles anime subtitles ("Fix Anime"), and rips disc images.

Media files are addressed by numeric file_id. Find ids with search_media, then
read a file's tracks and status with get_media_details before changing it.
Statuses: RE-ENCODE (too large), REMUX (tracks to drop), MISSING LANG
(required subtitle language absent), UNPROCESSABLE (disc image or unreadable).

Encodes, remuxes, rips, translations, extractions and Fix Anime runs are
queued jobs that finish in the background. They return a job id; follow them
with list_jobs. Jobs that rewrite files follow the server's output-file
settings (replace in place, optionally with a backup, or write a separate
copy). Confirm with the user before queueing work on many files, purging
backups or running a full library rescan.
"""


@dataclass
class ApiResult:
    status: int
    data: Any            # parsed JSON, or str for non-JSON bodies
    mimetype: str = 'application/json'
    headers: dict | None = None


class ToolError(Exception):
    """A tool failure the model should see (isError result, not a JSON-RPC error)."""


# ── Tool registry ─────────────────────────────────────────────────────────────
@dataclass
class Tool:
    name: str
    title: str
    description: str
    input_schema: dict
    handler: Callable[['ToolContext', dict], Any]
    read_only: bool = False
    destructive: bool = False
    idempotent: bool = False
    open_world: bool = False

    def definition(self):
        return {
            'name': self.name,
            'title': self.title,
            'description': self.description,
            'inputSchema': self.input_schema,
            'annotations': {
                'title': self.title,
                'readOnlyHint': self.read_only,
                'destructiveHint': self.destructive,
                'idempotentHint': self.idempotent,
                'openWorldHint': self.open_world,
            },
        }


TOOLS: dict[str, Tool] = {}


def tool(name, title, description, properties=None, required=(), **flags):
    def register(fn):
        TOOLS[name] = Tool(
            name=name, title=title, description=description,
            input_schema={'type': 'object', 'properties': properties or {},
                          'required': list(required), 'additionalProperties': False},
            handler=fn, **flags,
        )
        return fn
    return register


class ToolContext:
    def __init__(self, api):
        self._api = api

    def call(self, method, path, body=None, query=None, ok=(200, 201, 202, 207)):
        result = self._api(method, path, body=body, query=query)
        if result.status not in ok:
            message = None
            if isinstance(result.data, dict):
                message = result.data.get('error') or result.data.get('message')
            raise ToolError(message or f'{method} {path} failed with HTTP {result.status}')
        if isinstance(result.data, dict) and result.data.get('error') and result.status == 200:
            # A few handlers (e.g. scan_library) report a refusal with HTTP 200.
            raise ToolError(result.data['error'])
        return result

    def get(self, path, query=None):
        return self.call('GET', path, query=query).data

    def post(self, path, body=None):
        return self.call('POST', path, body={} if body is None else body).data


# ── Argument validation ───────────────────────────────────────────────────────
_JSON_TYPES = {
    'string': str, 'boolean': bool, 'object': dict, 'array': list,
    'integer': int, 'number': (int, float),
}


def _check(value, schema, where):
    expected = schema.get('type')
    if expected:
        py = _JSON_TYPES[expected]
        bad = not isinstance(value, py) or (expected in ('integer', 'number') and isinstance(value, bool))
        if bad:
            raise ToolError(f'{where} must be a {expected}')
    if 'enum' in schema and value not in schema['enum']:
        raise ToolError(f"{where} must be one of: {', '.join(map(str, schema['enum']))}")
    if 'minimum' in schema and value < schema['minimum']:
        raise ToolError(f"{where} must be at least {schema['minimum']}")
    if 'maximum' in schema and value > schema['maximum']:
        raise ToolError(f"{where} must be at most {schema['maximum']}")
    if expected == 'array':
        if 'minItems' in schema and len(value) < schema['minItems']:
            raise ToolError(f"{where} needs at least {schema['minItems']} item(s)")
        if 'maxItems' in schema and len(value) > schema['maxItems']:
            raise ToolError(f"{where} allows at most {schema['maxItems']} items")
        for i, item in enumerate(value):
            _check(item, schema.get('items', {}), f'{where}[{i}]')
    if expected == 'object' and 'properties' in schema:
        _check_object(value, schema, where)


def _check_object(value, schema, where):
    props = schema.get('properties', {})
    for key in schema.get('required', []):
        if key not in value:
            raise ToolError(f'{where}.{key} is required' if where else f'{key} is required')
    if schema.get('additionalProperties') is False:
        unknown = sorted(set(value) - set(props))
        if unknown:
            raise ToolError(f"Unknown argument(s): {', '.join(unknown)}")
    for key, sub in props.items():
        if key in value and value[key] is not None:
            _check(value[key], sub, f'{where}.{key}' if where else key)


def validate_arguments(tool_def: Tool, arguments):
    if not isinstance(arguments, dict):
        raise ToolError('arguments must be an object')
    _check_object(arguments, tool_def.input_schema, '')
    defaults = {k: v['default'] for k, v in tool_def.input_schema['properties'].items() if 'default' in v}
    return {**defaults, **{k: v for k, v in arguments.items() if v is not None}}


# ── Shared schema fragments and shaping helpers ───────────────────────────────
FILE_ID = {'type': 'integer', 'minimum': 1, 'description': 'Media file id from search_media.'}
FILE_IDS = {'type': 'array', 'items': {'type': 'integer', 'minimum': 1}, 'minItems': 1, 'maxItems': 5000,
            'description': 'Media file ids from search_media.'}
QUEUE = {'type': 'string', 'enum': ['encode', 'translation'],
         'description': 'encode = encodes, remuxes, subtitle muxes and disc rips; '
                        'translation = subtitle translation, extraction/OCR and Fix Anime.'}
ANIME_SCOPE = {
    'type': 'object',
    'description': 'Alternative to file_ids: one file, or every episode in its season or show.',
    'properties': {
        'kind': {'type': 'string', 'enum': ['file', 'season', 'show']},
        'file_id': FILE_ID,
    },
    'required': ['kind', 'file_id'],
    'additionalProperties': False,
}
ANIME_PROPS = {
    'file_ids': FILE_IDS,
    'scope': ANIME_SCOPE,
    'settings': {'type': 'object', 'description': 'Optional overrides for the saved Fix Anime settings '
                 '(see get_settings → anime_settings for the keys). Omit to use the saved settings.'},
    'source_sub_idx': {'type': 'integer', 'minimum': 0, 'description': 'Single file, target-language mode only: '
                       'the subtitle track (sub_idx) to translate from instead of the automatic pick.'},
}
OCR_LANG = {'type': 'string', 'description': 'Optional ISO 639 code to OCR an image (PGS) track with, '
            'when its language tag is missing or wrong.'}


def _title(row):
    if row.get('media_type') == 'show' and row.get('show_name'):
        return f"{row['show_name']} {row.get('season_episode') or ''}".strip()
    return row.get('folder_name') or row.get('filename') or ''


def _langs(tracks):
    return [t.get('lang') or 'und' for t in tracks or []]


def _media_summary(row):
    height = row.get('video_height')
    summary = {
        'id': row['id'],
        'title': _title(row),
        'media_type': row.get('media_type'),
        'filename': row.get('filename'),
        'filepath': row.get('filepath'),
        'status': row.get('status'),
        'encode_status': row.get('encode_status'),
        'size_gb': row.get('size_gb'),
        'video': ' '.join(p for p in (row.get('video_codec') or '', f'{height}p' if height else '') if p) or None,
        'duration_min': round(row['duration_seconds'] / 60) if row.get('duration_seconds') else None,
        'audio_langs': _langs(row.get('audio_tracks')),
        'subtitle_langs': _langs(row.get('subtitle_tracks')),
    }
    if row.get('estimated_size_gb') is not None:
        summary['estimated_size_gb'] = row['estimated_size_gb']
    if row.get('disc_type'):
        summary['disc_type'] = row['disc_type']
    if row.get('encode_job_type'):
        summary['active_job'] = {'type': row['encode_job_type'], 'progress': row.get('encode_progress')}
    if row.get('translate_status'):
        summary['active_subtitle_job'] = {'status': row['translate_status'], 'progress': row.get('translate_progress')}
    return summary


def _status_matches(status, wanted, active):
    if wanted == 'all':
        return True
    if wanted == 'active':
        return status in active
    return status == wanted


_JOB_FIELDS = {
    'encode': ('id', 'media_file_id', 'job_type', 'status', 'progress', 'speed', 'eta_seconds', 'error_text',
               'original_size_gb', 'encoded_size_gb', 'savings_pct', 'output_path', 'created_at', 'started_at',
               'completed_at'),
    'translation': ('id', 'media_file_id', 'job_type', 'status', 'progress', 'progress_detail', 'source_sub_idx',
                    'source_lang', 'target_lang', 'extract_only', 'output_path', 'error_text', 'created_at',
                    'started_at', 'completed_at'),
}


def _job_summary(queue, job):
    out = {k: job.get(k) for k in _JOB_FIELDS[queue] if job.get(k) not in (None, '')}
    out['queue'] = queue
    out['job_type'] = job.get('job_type') or ('extract' if job.get('extract_only') else
                                              'encode' if queue == 'encode' else 'translate')
    out['title'] = _title(job)
    return out


def _redacted(config):
    clean = {}
    for key, value in config.items():
        if key in SECRET_CONFIG_KEYS or any(word in key for word in ('password', 'secret', 'token')):
            clean[key] = '(set)' if value else '(not set)'
        else:
            clean[key] = value
    return clean


# ── Read-only tools ───────────────────────────────────────────────────────────
@tool('get_library_overview', 'Library overview',
      'Counts of movies and shows by status (needs encoding, needs remux, missing subtitle language, alerts), '
      'total library size, active and failed jobs per queue, whether each queue is paused, and library scan progress. '
      'Start here to see what needs attention.',
      read_only=True, idempotent=True)
def _overview(ctx, args):
    encode = ctx.get('/api/encode/jobs')
    translation = ctx.get('/api/translate/jobs')

    def queue_state(data, active):
        jobs = data.get('jobs', [])
        return {
            'paused': data.get('paused'),
            'active': sum(j['status'] in active for j in jobs),
            'failed': sum(j['status'] == 'failed' for j in jobs),
            'done': sum(j['status'] == 'done' for j in jobs),
        }

    library = {}
    for media_type in ('movie', 'show'):
        stats = ctx.get('/api/media/stats', {'type': media_type})
        stats['total_gb'] = round((stats.pop('total_bytes', 0) or 0) / 1e9, 1)
        library[media_type] = stats
    return {
        'library': library,
        'queues': {'encode': queue_state(encode, ENCODE_ACTIVE),
                   'translation': queue_state(translation, TRANSLATION_ACTIVE)},
        'scan': ctx.get('/api/media/scan/status'),
        'watch_dir': ctx.get('/api/stats').get('watch_dir'),
    }


@tool('search_media', 'Search media library',
      'List media files, optionally narrowed by a status filter, media type and a text search over folder, '
      'file and show names. Returns compact rows (id, title, status, size, video, audio/subtitle languages); '
      'use get_media_details for full track information.',
      {
          'query': {'type': 'string', 'description': 'Text to match in folder name, file name or show name.'},
          'filter': {'type': 'string', 'default': 'all',
                     'enum': ['all', 'needs_encoding', 'needs_remux', 'missing_lang', 'queued', 'done', 'alerts'],
                     'description': 'needs_encoding = RE-ENCODE, needs_remux = REMUX, missing_lang = MISSING LANG, '
                                    'queued = encode in progress, done = encoded, alerts = disc images, '
                                    'unprocessable files and folders with several videos.'},
          'media_type': {'type': 'string', 'enum': ['all', 'movie', 'show'], 'default': 'all'},
          'limit': {'type': 'integer', 'minimum': 1, 'maximum': 500, 'default': 50},
          'offset': {'type': 'integer', 'minimum': 0, 'default': 0},
      }, read_only=True, idempotent=True)
def _search(ctx, args):
    data = ctx.get('/api/media', {'filter': args['filter'], 'type': args['media_type'],
                                   'search': args.get('query', '')})
    files = data.get('files', [])
    start, end = args['offset'], args['offset'] + args['limit']
    page = files[start:end]
    return {'total': len(files), 'offset': start, 'returned': len(page),
            'has_more': end < len(files), 'files': [_media_summary(r) for r in page]}


@tool('get_media_details', 'Media file details',
      'Everything known about one media file: status, size, video stream, every audio and subtitle track '
      '(index, language, codec, channels, title, keep/drop action), required and missing subtitle languages, '
      'sidecar subtitle files, and a preview of which tracks an encode would keep and where it would write.',
      {'file_id': FILE_ID}, required=('file_id',), read_only=True, idempotent=True)
def _details(ctx, args):
    return ctx.get(f"/api/media/{args['file_id']}")


@tool('list_alerts', 'List library alerts',
      'Files that need a human decision: disc images (ISO/IMG) that can be ripped, unprocessable files, and '
      'movie folders that contain more than one video.',
      read_only=True, idempotent=True)
def _alerts(ctx, args):
    rows = ctx.get('/api/media', {'filter': 'alerts', 'type': 'all'}).get('files', [])
    return {
        'disc_images': [_media_summary(r) for r in rows if r.get('disc_type')],
        'unprocessable': [_media_summary(r) for r in rows if r.get('status') == 'UNPROCESSABLE' and not r.get('disc_type')],
        'multi_video_folders': ctx.get('/api/media/alerts').get('alerts', []),
    }


@tool('list_jobs', 'List jobs',
      'Encode-queue jobs (encode, remux, mux_sub, rip) and/or translation-queue jobs (translate, extract, anime) '
      'with status, progress, speed, ETA and error text. Newest first.',
      {
          'queue': {'type': 'string', 'enum': ['all', 'encode', 'translation'], 'default': 'all'},
          'status': {'type': 'string', 'default': 'active',
                     'enum': ['active', 'failed', 'done', 'cancelled', 'all'],
                     'description': 'active = queued or running.'},
          'file_id': {**FILE_ID, 'description': 'Only jobs for this media file.'},
          'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200, 'default': 25},
      }, read_only=True, idempotent=True)
def _list_jobs(ctx, args):
    result = {}
    for queue, path, active in (('encode', '/api/encode/jobs', ENCODE_ACTIVE),
                                ('translation', '/api/translate/jobs', TRANSLATION_ACTIVE)):
        if args['queue'] not in ('all', queue):
            continue
        data = ctx.get(path)
        jobs = [j for j in data.get('jobs', [])
                if _status_matches(j.get('status'), args['status'], active)
                and (not args.get('file_id') or j.get('media_file_id') == args['file_id'])]
        result[queue] = {'paused': data.get('paused'), 'total': len(jobs),
                         'jobs': [_job_summary(queue, j) for j in jobs[:args['limit']]]}
    return result


@tool('get_recent_logs', 'Recent server logs',
      'Recent entries from the server log (the last 500 are kept in memory): scans, job progress, errors.',
      {
          'level': {'type': 'string', 'enum': ['all', 'info', 'warn', 'error'], 'default': 'all',
                    'description': 'warn includes errors.'},
          'contains': {'type': 'string', 'description': 'Only entries whose message contains this text (case-insensitive).'},
          'limit': {'type': 'integer', 'minimum': 1, 'maximum': 500, 'default': 100},
          'since': {'type': 'integer', 'minimum': 0, 'default': 0,
                    'description': 'Only entries after this sequence number (from a previous call\'s last_seq).'},
      }, read_only=True, idempotent=True)
def _logs(ctx, args):
    data = ctx.get('/api/logs', {'since': args['since']})
    entries = data.get('logs', [])
    if args['level'] == 'error':
        entries = [e for e in entries if e['level'] == 'error']
    elif args['level'] == 'warn':
        entries = [e for e in entries if e['level'] in ('warn', 'error')]
    elif args['level'] == 'info':
        entries = [e for e in entries if e['level'] == 'info']
    if args.get('contains'):
        needle = args['contains'].lower()
        entries = [e for e in entries if needle in e['msg'].lower()]
    return {'last_seq': data.get('total'), 'entries': entries[-args['limit']:]}


@tool('list_external_subtitles', 'List sidecar subtitle files',
      'Subtitle files (.srt, .ass, .vtt, …) sitting next to a media file, which mux_external_subtitle can embed.',
      {'file_id': FILE_ID}, required=('file_id',), read_only=True, idempotent=True)
def _external_subs(ctx, args):
    subs = ctx.get(f"/api/media/{args['file_id']}/external-subs").get('subs', [])
    return {'subs': [{'filename': s['filename'], 'ext': s['ext']} for s in subs]}


@tool('get_settings', 'Get settings',
      'The server\'s current settings: translation provider and target language, Fix Anime settings, track '
      'retention rules, encoder and quality, output-file policy, notification events and library rules, plus '
      'which video encoders work on this server. API keys and webhooks are reported only as set / not set.',
      read_only=True, idempotent=True)
def _settings(ctx, args):
    encoders = ctx.get('/api/encoders')
    return {'settings': _redacted(ctx.get('/api/config')),
            'encoders': {'selected': encoders.get('selected'),
                         'available': {k: v.get('available') for k, v in (encoders.get('encoders') or {}).items()}}}


@tool('list_backups', 'List backups',
      'Originals kept as backups after in-place encodes or remuxes: path, original file, size and age, plus '
      'the retention period.',
      read_only=True, idempotent=True)
def _backups(ctx, args):
    return ctx.get('/api/backups')


@tool('preview_fix_anime', 'Preview Fix Anime',
      'Dry run of Fix Anime: for each file, which subtitle track would be styled or translated, which tracks '
      'are kept, where the new MKV would be written, and why a file would be skipped. Changes nothing.',
      ANIME_PROPS, read_only=True, idempotent=True)
def _anime_preview(ctx, args):
    return _anime_request(ctx, '/api/anime/plan', args)


def _anime_request(ctx, path, args):
    if bool(args.get('file_ids')) == bool(args.get('scope')):
        raise ToolError('Give either file_ids or scope')
    body = {k: args[k] for k in ('file_ids', 'scope', 'settings', 'source_sub_idx') if k in args}
    return ctx.post(path, body)


# ── Actions ───────────────────────────────────────────────────────────────────
@tool('scan_library', 'Scan library',
      'Re-scan media on disk. With file_ids, only the folder containing those files is re-read. Without, the '
      'whole watch directory is rescanned from scratch: every library record is cleared and rebuilt '
      '(files on disk are not touched; this can take a long time on large libraries). Runs in the background; '
      'progress shows in get_library_overview.',
      {'file_ids': {**FILE_IDS, 'description': 'Rescan only the folder that contains these files.'}},
      destructive=True)
def _scan(ctx, args):
    if args.get('file_ids'):
        return ctx.post('/api/media/scan/folder', {'file_ids': args['file_ids']})
    return ctx.post('/api/media/scan')


@tool('refresh_media_file', 'Refresh media file',
      'Re-read one file with ffprobe and update its tracks and status (after it changed on disk).',
      {'file_id': FILE_ID}, required=('file_id',), idempotent=True)
def _refresh(ctx, args):
    ctx.post(f"/api/media/{args['file_id']}/refresh")
    return _media_summary(_details(ctx, args))


@tool('recalculate_statuses', 'Recalculate statuses',
      'Re-apply the current status rules (re-encode size threshold, required subtitle languages) to every file '
      'using stored track data. Fast; does not re-read files.',
      idempotent=True)
def _recalculate(ctx, args):
    return ctx.post('/api/media/recalculate-status')


@tool('queue_encode', 'Queue encodes',
      'Queue GPU/CPU re-encodes for files using the server\'s encoding settings. Files that already have an '
      'active job are skipped. The output replaces the original or is written separately, per the output settings.',
      {'file_ids': FILE_IDS}, required=('file_ids',), destructive=True)
def _queue_encode(ctx, args):
    return ctx.post('/api/encode/queue', {'file_ids': args['file_ids']})


TRACK_EDIT = {
    'lang': {'type': 'string', 'description': 'ISO 639 language code to tag the track with.'},
    'action': {'type': 'string', 'enum': ['keep', 'drop']},
}


@tool('update_tracks', 'Edit audio and subtitle tracks',
      'Set language tags and keep/drop choices on a file\'s audio and subtitle tracks, then queue a remux that '
      'writes them into the file (nothing is re-encoded). Tracks not listed keep their current settings. For '
      'disc images the choices are saved for the next rip and no remux is queued.',
      {
          'file_id': FILE_ID,
          'audio': {'type': 'array', 'items': {'type': 'object', 'properties': {
              'audio_idx': {'type': 'integer', 'minimum': 0}, **TRACK_EDIT},
              'required': ['audio_idx'], 'additionalProperties': False}},
          'subtitles': {'type': 'array', 'items': {'type': 'object', 'properties': {
              'sub_idx': {'type': 'integer', 'minimum': 0}, **TRACK_EDIT},
              'required': ['sub_idx'], 'additionalProperties': False}},
      }, required=('file_id',), destructive=True)
def _update_tracks(ctx, args):
    if not args.get('audio') and not args.get('subtitles'):
        raise ToolError('List at least one audio or subtitle track to change')
    current = _details(ctx, args)

    def merged(tracks, edits, key):
        by_idx = {t.get(key): t for t in tracks}
        missing = [e[key] for e in edits if e[key] not in by_idx]
        if missing:
            raise ToolError(f'No {key} {missing[0]} on this file')
        # The endpoint resets action to keep when it is omitted, so carry the
        # current action through for tracks where only the language changes.
        return [{key: e[key], 'action': e.get('action') or by_idx[e[key]].get('action') or 'keep',
                 **({'lang': e['lang']} if e.get('lang') else {})} for e in edits]

    body = {'audio': merged(current.get('audio_tracks', []), args.get('audio', []), 'audio_idx'),
            'subtitles': merged(current.get('subtitle_tracks', []), args.get('subtitles', []), 'sub_idx')}
    result = ctx.post(f"/api/media/{args['file_id']}/assign-tracks", body)
    return {k: result.get(k) for k in ('status', 'new_status', 'remux_job_id', 'error') if result.get(k) is not None}


@tool('rip_disc_image', 'Rip disc image',
      'Queue a rip of a DVD/Blu-ray ISO or IMG into a new MKV with the selected best title and tracks '
      '(see get_media_details for the track plan). The disc image is left in place.',
      {'file_id': FILE_ID}, required=('file_id',))
def _rip(ctx, args):
    return ctx.post(f"/api/media/{args['file_id']}/rip")


@tool('translate_subtitle', 'Translate subtitle track',
      'Queue translation of one subtitle track with the configured AI provider and mux the result into the file '
      'as a new track. Image (PGS) tracks are OCR\'d first.',
      {
          'file_id': FILE_ID,
          'sub_idx': {'type': 'integer', 'minimum': 0, 'description': 'Subtitle track index from get_media_details.'},
          'target_lang': {'type': 'string', 'description': 'ISO 639 code; defaults to the configured target language.'},
          'ocr_lang': OCR_LANG,
      }, required=('file_id', 'sub_idx'), destructive=True, open_world=True)
def _translate(ctx, args):
    body = {k: args[k] for k in ('sub_idx', 'target_lang', 'ocr_lang') if k in args}
    return ctx.post(f"/api/media/{args['file_id']}/translate-subtitle", body)


@tool('extract_subtitle', 'Extract subtitle track',
      'Queue extraction of one subtitle track to SRT (OCR for image tracks) without changing the media file. '
      'When the job is done, read the text with get_extracted_subtitle.',
      {
          'file_id': FILE_ID,
          'sub_idx': {'type': 'integer', 'minimum': 0, 'description': 'Subtitle track index from get_media_details.'},
          'ocr_lang': OCR_LANG,
      }, required=('file_id', 'sub_idx'))
def _extract(ctx, args):
    body = {'ocr_lang': args['ocr_lang']} if args.get('ocr_lang') else {}
    return ctx.post(f"/api/media/{args['file_id']}/subtitle/{args['sub_idx']}/extract", body)


@tool('get_extracted_subtitle', 'Get extracted subtitle',
      'Return the SRT text of a finished extract_subtitle job. The server deletes its copy once read, so this '
      'works once per job.',
      {
          'job_id': {'type': 'integer', 'minimum': 1},
          'max_chars': {'type': 'integer', 'minimum': 1000, 'maximum': 1000000, 'default': 200000,
                        'description': 'Truncate longer subtitles to this many characters.'},
      }, required=('job_id',))
def _get_extracted(ctx, args):
    result = ctx.call('GET', f"/api/translate/jobs/{args['job_id']}/download")
    text = result.data if isinstance(result.data, str) else json.dumps(result.data)
    disposition = (result.headers or {}).get('Content-Disposition', '')
    filename = disposition.split('filename=')[-1].strip('"') if 'filename=' in disposition else None
    return {'filename': filename, 'chars': len(text), 'truncated': len(text) > args['max_chars'],
            'content': text[:args['max_chars']]}


@tool('mux_external_subtitle', 'Embed sidecar subtitle',
      'Queue embedding a subtitle file from the media file\'s folder (see list_external_subtitles) into the media '
      'file as a new track.',
      {
          'file_id': FILE_ID,
          'filename': {'type': 'string', 'description': 'Sidecar file name from list_external_subtitles.'},
          'lang': {'type': 'string', 'default': 'und', 'description': 'ISO 639 language code for the new track.'},
      }, required=('file_id', 'filename'), destructive=True)
def _mux_external(ctx, args):
    subs = ctx.get(f"/api/media/{args['file_id']}/external-subs").get('subs', [])
    match = next((s for s in subs if s['filename'] == args['filename']), None)
    if not match:
        raise ToolError(f"No subtitle file named {args['filename']!r} next to this media file")
    return ctx.post(f"/api/media/{args['file_id']}/mux-external-sub", {'sub_path': match['path'], 'lang': args['lang']})


@tool('queue_fix_anime', 'Queue Fix Anime',
      'Queue Fix Anime for files: style (and if configured, translate) the subtitles, retime mistimed sidecars, '
      'keep the configured languages and write a new MKV. Run preview_fix_anime first to see what each file will get.',
      ANIME_PROPS, open_world=True)
def _anime_queue(ctx, args):
    result = _anime_request(ctx, '/api/anime/queue', args)
    skipped = [{'file_id': f.get('file_id') or f.get('id'), 'reason': f['reason']}
               for f in result.get('files', []) if f.get('reason')]
    return {'queued_job_ids': result.get('queued', []), 'count': result.get('count', 0), 'skipped': skipped}


@tool('cancel_job', 'Cancel job',
      'Cancel one queued or running job. A running encode is stopped immediately and its partial output removed.',
      {'queue': QUEUE, 'job_id': {'type': 'integer', 'minimum': 1}}, required=('queue', 'job_id'), destructive=True)
def _cancel(ctx, args):
    prefix = '/api/encode/cancel/' if args['queue'] == 'encode' else '/api/translate/cancel/'
    return ctx.post(f"{prefix}{args['job_id']}")


_QUEUE_ACTIONS = {
    ('encode', 'pause'): '/api/encode/pause',
    ('encode', 'resume'): '/api/encode/resume',
    ('encode', 'cancel_all'): '/api/encode/cancel-all',
    ('encode', 'clear_finished'): '/api/encode/jobs/clear',
    ('translation', 'pause'): '/api/translate/pause',
    ('translation', 'resume'): '/api/translate/resume',
    ('translation', 'cancel_all'): '/api/translate/cancel-all',
    ('translation', 'clear_finished'): '/api/translate/jobs/clear',
}


@tool('control_queue', 'Control job queue',
      'Pause a queue (the running job finishes, nothing new starts), resume it, cancel every queued and running '
      'job, or clear finished/failed/cancelled jobs from the list.',
      {'queue': QUEUE, 'action': {'type': 'string', 'enum': ['pause', 'resume', 'cancel_all', 'clear_finished']}},
      required=('queue', 'action'), destructive=True)
def _control(ctx, args):
    return ctx.post(_QUEUE_ACTIONS[(args['queue'], args['action'])])


@tool('lookup_poster', 'Look up poster',
      'Find poster artwork on TheTVDB for a movie or show and save it for every file of that title.',
      {'file_id': FILE_ID, 'refresh': {'type': 'boolean', 'default': False,
                                       'description': 'Look up again even if artwork is already saved.'}},
      required=('file_id',), idempotent=True, open_world=True)
def _poster(ctx, args):
    return ctx.post(f"/api/media/{args['file_id']}/poster", {'refresh': args['refresh']})


@tool('purge_backups', 'Purge backups',
      'Permanently delete backed-up originals: by default only those past the retention period, or all of them.',
      {'all': {'type': 'boolean', 'default': False, 'description': 'Delete every backup, not just expired ones.'}},
      destructive=True)
def _purge(ctx, args):
    return ctx.post('/api/backups/purge', {'all': args['all']})


@tool('send_test_notification', 'Send test notification',
      'Send a test message through the saved Ntfy or Discord settings.',
      {'provider': {'type': 'string', 'enum': ['ntfy', 'discord']}}, required=('provider',), open_world=True)
def _test_notification(ctx, args):
    return ctx.post(f"/api/test/{args['provider']}")


# ── JSON-RPC / transport ──────────────────────────────────────────────────────
class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def _tool_result(payload, is_error=False):
    text = payload if isinstance(payload, str) else json.dumps(payload, indent=1, default=str)
    result = {'content': [{'type': 'text', 'text': text}], 'isError': is_error}
    if isinstance(payload, dict) and not is_error:
        result['structuredContent'] = payload
    return result


class MCPServer:
    def __init__(self, api, authenticate, name='media-monitor', title='Media Monitor', version='1.0.0', log=None):
        self.api = api
        self.authenticate = authenticate
        self.info = {'name': name, 'title': title, 'version': version}
        self.log = log or (lambda level, msg: None)

    # Tools visible to a token: read-only tokens never see actions.
    def visible_tools(self, scope):
        return [t for t in TOOLS.values() if scope == 'full' or t.read_only]

    def handle(self, request):
        origin_error = self._check_origin(request)
        if origin_error:
            return origin_error
        scope = self.authenticate(request.headers.get('Authorization', ''))
        if not scope:
            resp = jsonify({'error': 'unauthorized',
                            'message': 'Send "Authorization: Bearer <token>". Create a token in '
                                       'Settings → AI assistants (MCP).'})
            resp.status_code = 401
            resp.headers['WWW-Authenticate'] = 'Bearer realm="media-monitor"'
            return resp
        if request.method != 'POST':
            resp = Response(status=405)
            resp.headers['Allow'] = 'POST'
            return resp

        version = request.headers.get('MCP-Protocol-Version')
        if version and version not in SUPPORTED_PROTOCOL_VERSIONS:
            return self._http_error(400, None, INVALID_REQUEST, f'Unsupported MCP-Protocol-Version: {version}')

        try:
            message = json.loads(request.get_data(as_text=True) or 'null')
        except ValueError:
            return self._http_error(400, None, PARSE_ERROR, 'Parse error')

        if isinstance(message, list):  # JSON-RPC batch (2025-03-26 clients)
            if not message:
                return self._http_error(400, None, INVALID_REQUEST, 'Empty batch')
            replies = [r for r in (self._dispatch(m, scope) for m in message) if r is not None]
            return jsonify(replies) if replies else Response(status=202)
        reply = self._dispatch(message, scope)
        return jsonify(reply) if reply is not None else Response(status=202)

    def _check_origin(self, request):
        """Spec requirement against DNS rebinding: a browser Origin must match the host we serve."""
        origin = request.headers.get('Origin')
        if not origin:
            return None
        if urlsplit(origin).netloc.lower() == request.host.lower():
            return None
        return self._http_error(403, None, INVALID_REQUEST, 'Origin not allowed')

    @staticmethod
    def _http_error(status, msg_id, code, message):
        resp = jsonify({'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': code, 'message': message}})
        resp.status_code = status
        return resp

    def _dispatch(self, message, scope):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': INVALID_REQUEST, 'message': 'Invalid request'}}
        if 'method' not in message:
            return None  # a response to a server request; we never send any
        msg_id = message.get('id')
        is_notification = 'id' not in message
        try:
            result = self._call_method(message['method'], message.get('params') or {}, scope)
        except RpcError as e:
            if is_notification:
                return None
            error = {'code': e.code, 'message': e.message}
            if e.data is not None:
                error['data'] = e.data
            return {'jsonrpc': '2.0', 'id': msg_id, 'error': error}
        except Exception as e:  # pragma: no cover - defensive
            self.log('error', f'[mcp] {message.get("method")} failed: {e}')
            if is_notification:
                return None
            return {'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': INTERNAL_ERROR, 'message': 'Internal error'}}
        if is_notification:
            return None
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': result}

    def _call_method(self, method, params, scope):
        if not isinstance(params, dict):
            raise RpcError(INVALID_PARAMS, 'params must be an object')
        if method == 'initialize':
            requested = params.get('protocolVersion')
            version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
            access = ('This token has full access.' if scope == 'full'
                      else 'This token is read-only: only tools that read the library are available.')
            return {
                'protocolVersion': version,
                'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': self.info,
                'instructions': INSTRUCTIONS + '\n' + access,
            }
        if method == 'ping':
            return {}
        if method.startswith('notifications/'):
            return {}
        if method == 'tools/list':
            return {'tools': [t.definition() for t in self.visible_tools(scope)]}
        if method == 'tools/call':
            return self._call_tool(params, scope)
        raise RpcError(METHOD_NOT_FOUND, f'Method not found: {method}')

    def _call_tool(self, params, scope):
        name = params.get('name')
        tool_def = TOOLS.get(name)
        if not tool_def:
            raise RpcError(INVALID_PARAMS, f'Unknown tool: {name}')
        if scope != 'full' and not tool_def.read_only:
            return _tool_result(f'{name} changes the library, and this MCP token is read-only. '
                                'Create a full-access token in Settings → AI assistants (MCP).', is_error=True)
        try:
            arguments = validate_arguments(tool_def, params.get('arguments') or {})
            payload = tool_def.handler(ToolContext(self.api), arguments)
        except ToolError as e:
            return _tool_result(str(e), is_error=True)
        except Exception as e:
            self.log('error', f'[mcp] tool {name} failed: {e}')
            return _tool_result(f'{name} failed: {e}', is_error=True)
        if not tool_def.read_only:
            self.log('info', f'[mcp] {name} {json.dumps(arguments, default=str)[:300]}')
        return _tool_result(payload if payload is not None else {'status': 'ok'})
