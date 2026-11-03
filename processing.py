"""Processing preferences: track retention, encoding, output files, and rules.

Pure logic only (no Flask, DB, or ffmpeg calls) so app.py and the tests share
one definition of what each setting means. Every function takes the resolved
settings dict explicitly; queued jobs pass the snapshot taken when they were
queued, so later edits never change pending work.
"""
import math
import os
import re
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath

# ── Defaults ──────────────────────────────────────────────────────────────────
NOTIFY_EVENTS = ('new_media', 'attention', 'job_complete', 'job_failed', 'disc_detected')
NTFY_PRIORITIES = ('min', 'low', 'default', 'high', 'urgent')
PRESETS = ('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7')
QUALITY_PROFILES = ('quality', 'balanced', 'compact', 'custom')
MAX_HEIGHTS = (0, 2160, 1440, 1080, 720, 480)
DEFAULT_AUDIO_CODEC_ORDER = ['truehd', 'flac', 'dts', 'eac3', 'ac3', 'aac', 'opus', 'vorbis', 'mp3', 'mp2']

DEFAULTS = {
    # Language retention (which tracks survive encoding and ripping)
    'keep_audio_langs': ['eng', 'jpn', 'spa'],
    'keep_all_audio_langs': False,
    'keep_untagged_audio': False,
    'audio_fallback': 'all',          # no audio track matches: 'all' | 'first'
    'keep_sub_langs': ['eng', 'spa'],
    'keep_all_sub_langs': False,
    'keep_untagged_subs': False,
    # Audio selection among the retained languages
    'audio_selection': 'best',        # 'best' (one per language) | 'all'
    'audio_codec_order': list(DEFAULT_AUDIO_CODEC_ORDER),
    'commentary_audio': 'drop',       # 'drop' | 'keep'
    'default_audio_lang': '',         # '' keeps the source's default flags
    # Video encoding
    'video_encoder': 'hevc_nvenc',
    'encode_profile': 'balanced',
    'encode_quality': 20,             # only used by the 'custom' profile
    'encode_preset': 'p4',
    'encode_max_height': 1080,        # 0 preserves the original resolution
    'encode_10bit': True,
    'encode_lookahead': 20,           # NVENC only
    # Output files
    'output_policy': 'replace',       # 'replace' | 'separate'
    'output_dir': '',                 # '' writes next to the source
    'output_suffix': '.encoded',
    'backup_originals': False,
    'backup_retention_days': 30,      # 0 keeps backups until removed manually
    'keep_translated_sidecar': False,
    # Notifications
    'ntfy_events': list(NOTIFY_EVENTS),
    'discord_events': ['new_media', 'attention', 'disc_detected'],
    'ntfy_priorities': {'new_media': 'default', 'attention': 'high', 'job_complete': 'default',
                        'job_failed': 'high', 'disc_detected': 'default'},
    # Translation and OCR
    'translation_cache_days': 30,
    'local_ai_timeout': 600,
    'ocr_fallback_lang': 'eng',
    'ocr_preset': 'standard',         # 'fast' | 'standard' | 'accurate'
    # Library classification
    'movie_roots': [],
    'show_roots': [],
    'excluded_folders': [],
}

# Settings captured with each encode/remux/rip/mux job when it is queued.
JOB_SETTING_KEYS = (
    'keep_audio_langs', 'keep_all_audio_langs', 'keep_untagged_audio', 'audio_fallback',
    'keep_sub_langs', 'keep_all_sub_langs', 'keep_untagged_subs',
    'audio_selection', 'audio_codec_order', 'commentary_audio', 'default_audio_lang',
    'video_encoder', 'encode_profile', 'encode_quality', 'encode_preset',
    'encode_max_height', 'encode_10bit', 'encode_lookahead',
    'output_policy', 'output_dir', 'output_suffix', 'backup_originals',
    'keep_translated_sidecar', 'ocr_fallback_lang', 'ocr_preset',
)


def job_settings(config, snapshot=None):
    """Resolve a job's settings: its queued snapshot, else current config."""
    result = {key: config.get(key, DEFAULTS[key]) for key in JOB_SETTING_KEYS}
    if snapshot:
        result.update({k: v for k, v in snapshot.items() if k in JOB_SETTING_KEYS})
    return result


# ── Encoders ──────────────────────────────────────────────────────────────────
# name → (codec family, backend)
ENCODERS = {
    'hevc_nvenc': ('hevc', 'nvidia'), 'h264_nvenc': ('h264', 'nvidia'), 'av1_nvenc': ('av1', 'nvidia'),
    'hevc_qsv': ('hevc', 'intel'), 'h264_qsv': ('h264', 'intel'), 'av1_qsv': ('av1', 'intel'),
    'hevc_amf': ('hevc', 'amd'), 'h264_amf': ('h264', 'amd'), 'av1_amf': ('av1', 'amd'),
    'libx265': ('hevc', 'cpu'), 'libx264': ('h264', 'cpu'), 'libsvtav1': ('av1', 'cpu'),
}
BACKEND_LABELS = {'nvidia': 'NVIDIA NVENC', 'intel': 'Intel Quick Sync', 'amd': 'AMD AMF', 'cpu': 'CPU (software)'}
CODEC_LABELS = {'hevc': 'HEVC (H.265)', 'h264': 'H.264', 'av1': 'AV1'}

# Native quality values per profile: (quality, balanced, compact). Lower is
# better on every scale. Each backend has its own scale, so the profiles are
# what stay comparable across encoders, not the raw numbers.
_PROFILE_VALUES = {
    ('hevc', 'nvidia'): (18, 20, 24), ('h264', 'nvidia'): (19, 21, 25), ('av1', 'nvidia'): (26, 30, 36),
    ('hevc', 'intel'): (20, 23, 27), ('h264', 'intel'): (20, 23, 27), ('av1', 'intel'): (22, 26, 31),
    ('hevc', 'amd'): (18, 21, 25), ('h264', 'amd'): (18, 21, 25), ('av1', 'amd'): (100, 120, 150),
    ('hevc', 'cpu'): (19, 21, 25), ('h264', 'cpu'): (18, 20, 23), ('av1', 'cpu'): (24, 30, 36),
}
_QUALITY_MAX = {'av1_amf': 255, 'libsvtav1': 63}
_CPU_PRESETS = ('ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower')
_SVT_PRESETS = (12, 10, 9, 8, 6, 5, 4)
_QSV_PRESETS = ('veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow')
_AMF_PRESETS = ('speed', 'speed', 'balanced', 'balanced', 'balanced', 'quality', 'quality')
# Relative bitrate at equal perceived quality (HEVC = 1).
_CODEC_EFFICIENCY = {'hevc': 1.0, 'h264': 1.45, 'av1': 0.75}


def quality_max(encoder):
    return _QUALITY_MAX.get(encoder, 51)


def quality_value(settings):
    """The native quality number the configured profile uses for its encoder."""
    family = ENCODERS[settings['video_encoder']]
    profile = settings['encode_profile']
    if profile == 'custom':
        return max(0, min(int(settings['encode_quality']), quality_max(settings['video_encoder'])))
    return _PROFILE_VALUES[family][QUALITY_PROFILES.index(profile)]


def profile_values(encoder):
    """{profile: native value} for the UI's per-encoder explanation."""
    values = _PROFILE_VALUES[ENCODERS[encoder]]
    return dict(zip(QUALITY_PROFILES[:3], values))


def output_height(settings, source_height):
    limit = settings['encode_max_height']
    if limit and source_height and source_height > limit:
        return limit
    return source_height or 0


def video_args(settings, source_height):
    """ffmpeg video-encoding arguments shared by encode and disc rip jobs."""
    encoder = settings['video_encoder']
    codec, backend = ENCODERS[encoder]
    q = str(quality_value(settings))
    level = PRESETS.index(settings['encode_preset'])
    ten_bit = bool(settings['encode_10bit']) and codec != 'h264'
    args = ['-c:v', encoder]
    if backend == 'nvidia':
        args += ['-preset:v', settings['encode_preset'], '-cq:v', q]
        if codec == 'hevc':
            args += ['-profile:v', 'main10' if ten_bit else 'main']
        elif codec == 'h264':
            args += ['-profile:v', 'high']
        elif ten_bit:
            args += ['-pix_fmt', 'p010le']
        args += ['-rc-lookahead', str(settings['encode_lookahead'])]
    elif backend == 'cpu':
        preset = str(_SVT_PRESETS[level]) if encoder == 'libsvtav1' else _CPU_PRESETS[level]
        args += ['-preset', preset, '-crf', q, '-pix_fmt', 'yuv420p10le' if ten_bit else 'yuv420p']
    elif backend == 'intel':
        args += ['-preset', _QSV_PRESETS[level], '-global_quality', q,
                 '-pix_fmt', 'p010le' if ten_bit else 'nv12']
    else:  # amd
        args += ['-quality', _AMF_PRESETS[level], '-rc', 'cqp', '-qp_i', q, '-qp_p', q]
        if codec == 'h264':
            args += ['-qp_b', q]
        if ten_bit and codec == 'hevc':
            args += ['-profile:v', 'main10']
        args += ['-pix_fmt', 'p010le' if ten_bit else 'nv12']
    height = output_height(settings, source_height)
    if source_height and height < source_height:
        args += ['-vf', f'scale=-2:{height}']
    return args


def estimate_video_bps(settings, source_codec, source_bitrate, source_height):
    """Rough average video bitrate for the configured encoder and profile."""
    encoder = settings['video_encoder']
    codec, backend = ENCODERS[encoder]
    height = output_height(settings, source_height) or 1080
    if source_height and height < source_height or not source_bitrate:
        base = 4_000_000 * (height / 1080) ** 2  # HEVC CQ 20 at 1080p ≈ 3–5 Mbps
    elif (source_codec or '').lower() in ('hevc', 'h265'):
        base = source_bitrate * 0.6
    else:
        base = source_bitrate * 0.45
    balanced = _PROFILE_VALUES[(codec, backend)][1]
    steps = (quality_value(settings) - balanced) * 51 / quality_max(encoder)
    return base * _CODEC_EFFICIENCY[codec] * 0.89 ** steps


def encoder_test_args(encoder, ten_bit=False):
    """A tiny synthetic encode proving the encoder works on this machine."""
    codec, backend = ENCODERS[encoder]
    pix = ('p010le' if backend in ('nvidia', 'intel', 'amd') else 'yuv420p10le') if ten_bit and codec != 'h264' \
        else ('nv12' if backend in ('intel', 'amd') else 'yuv420p')
    return ['ffmpeg', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:r=10:d=0.5',
            '-frames:v', '5', '-pix_fmt', pix, '-c:v', encoder, '-f', 'null', '-']


# ── Track selection ───────────────────────────────────────────────────────────
_COMMENTARY_RE = re.compile(r'comment', re.I)


def is_commentary(track):
    return bool(_COMMENTARY_RE.search(track.get('title') or ''))


def _explicit_action(track, auto_actions):
    """A user's track-editor choice, which always overrides the rules.

    Changes made in the editor are marked action_user. Older records lack the
    mark: for ordinary files a stored 'drop' is still the user's choice, but a
    disc image's stored actions are recommendations from analysis (auto_actions).
    """
    if track.get('action_user'):
        return track.get('action')
    if not auto_actions and track.get('action') == 'drop':
        return 'drop'
    return None


def _codec_rank(track, order):
    codec = (track.get('codec') or '').lower()
    return order.index(codec) if codec in order else len(order)


def select_tracks(audio_tracks, subtitle_tracks, settings, normalize, auto_actions=False):
    """Apply retention + audio-selection rules.

    Precedence, highest first:
      1. Explicit track-editor Drop/Keep choices.
      2. Commentary handling (audio).
      3. Language keep lists (or Keep all languages), untagged-track switches.
      4. Audio mode: best track per language, or every matching track.
      5. Audio fallback when nothing above kept any audio track.
    Returns {'audio': [...], 'subtitles': [...], 'decisions': [...]} with the
    kept tracks in source order and one decision (kept + reason) per track.
    """
    audio_decisions = {}
    candidates = []
    keep_audio = set(settings['keep_audio_langs'])
    for i, track in enumerate(audio_tracks):
        explicit = _explicit_action(track, auto_actions)
        if explicit == 'drop':
            audio_decisions[i] = (False, 'Dropped in the track editor')
        elif explicit == 'keep':
            audio_decisions[i] = (True, 'Kept in the track editor')
        elif is_commentary(track) and settings['commentary_audio'] == 'drop':
            audio_decisions[i] = (False, 'Commentary track')
        else:
            candidates.append(i)

    matched = []
    for i in candidates:
        lang = normalize(audio_tracks[i].get('lang'))
        if settings['keep_all_audio_langs'] or (lang in keep_audio if lang else settings['keep_untagged_audio']):
            matched.append(i)
        else:
            audio_decisions[i] = (False, 'Untagged track' if not lang else 'Language not in the audio keep list')

    if settings['audio_selection'] == 'best':
        order = [c.lower() for c in settings['audio_codec_order']]
        best = {}
        for i in matched:
            lang = normalize(audio_tracks[i].get('lang'))
            rank = (_codec_rank(audio_tracks[i], order), -(audio_tracks[i].get('channels') or 0), i)
            if lang not in best or rank < best[lang][0]:
                best[lang] = (rank, i)
        winners = {i for _, i in best.values()}
        for i in matched:
            audio_decisions[i] = (True, 'Best track for its language') if i in winners \
                else (False, 'Another track for this language ranks higher')
    else:
        for i in matched:
            audio_decisions[i] = (True, 'Matches the audio keep list')

    if not any(kept for kept, _ in audio_decisions.values()):
        # Never produce a file without audio unless the user dropped it all.
        pool = [i for i in range(len(audio_tracks)) if _explicit_action(audio_tracks[i], auto_actions) != 'drop']
        preferred = [i for i in pool if not is_commentary(audio_tracks[i])] or pool
        if settings['audio_fallback'] == 'first':
            preferred = preferred[:1]
            reason = 'No preferred language found — keeping the first audio track'
        else:
            reason = 'No preferred language found — keeping all audio'
        for i in preferred:
            audio_decisions[i] = (True, reason)

    keep_subs = set(settings['keep_sub_langs'])
    sub_decisions = {}
    for i, track in enumerate(subtitle_tracks):
        explicit = _explicit_action(track, auto_actions)
        lang = normalize(track.get('lang'))
        if explicit == 'drop':
            sub_decisions[i] = (False, 'Dropped in the track editor')
        elif explicit == 'keep':
            sub_decisions[i] = (True, 'Kept in the track editor')
        elif settings['keep_all_sub_langs'] or (lang in keep_subs if lang else settings['keep_untagged_subs']):
            sub_decisions[i] = (True, 'Matches the subtitle keep list')
        else:
            sub_decisions[i] = (False, 'Untagged track' if not lang else 'Language not in the subtitle keep list')

    decisions = (
        [{'kind': 'audio', 'index': track.get('audio_idx', i), 'lang': normalize(track.get('lang')),
          'codec': track.get('codec') or '', 'channels': track.get('channels') or 0, 'title': track.get('title') or '',
          'kept': audio_decisions[i][0], 'reason': audio_decisions[i][1]} for i, track in enumerate(audio_tracks)]
        + [{'kind': 'subtitle', 'index': track.get('sub_idx', i), 'lang': normalize(track.get('lang')),
            'codec': track.get('codec') or '', 'title': track.get('title') or '',
            'kept': sub_decisions[i][0], 'reason': sub_decisions[i][1]} for i, track in enumerate(subtitle_tracks)]
    )
    return {
        'audio': [t for i, t in enumerate(audio_tracks) if audio_decisions[i][0]],
        'subtitles': [t for i, t in enumerate(subtitle_tracks) if sub_decisions[i][0]],
        'decisions': decisions,
    }


def default_audio_position(kept_audio, settings, normalize):
    """Index (within the kept tracks) to flag as default, or None to keep source flags."""
    lang = settings.get('default_audio_lang')
    if not lang:
        return None
    for i, track in enumerate(kept_audio):
        if normalize(track.get('lang')) == lang:
            return i
    return None


# ── Output paths ──────────────────────────────────────────────────────────────
def unique_path(path):
    """`path`, or `name (2).ext`, `name (3).ext`… — never an existing file."""
    path = Path(path)
    if not os.path.lexists(path):
        return path
    for n in range(2, 10_000):
        candidate = path.with_name(f'{path.stem} ({n}){path.suffix}')
        if not os.path.lexists(candidate):
            return candidate
    raise OSError(f'No free output name for {path.name}')


def resolve_output_dir(output_dir, watch_dir):
    if not output_dir:
        return None
    path = Path(output_dir)
    return path if path.is_absolute() else Path(watch_dir) / path


def separate_output_path(source, settings, watch_dir, ext='.mkv'):
    """Where a 'Write separate output' job writes, mirroring subfolders under
    a custom output folder so same-named episodes never collide."""
    source = Path(source)
    folder = resolve_output_dir(settings['output_dir'], watch_dir)
    if folder is None:
        folder = source.parent
    else:
        try:
            folder = folder / source.parent.relative_to(watch_dir)
        except ValueError:
            pass
    return unique_path(folder / f'{source.stem}{settings["output_suffix"]}{ext}')


def backup_path(source):
    source = Path(source)
    return unique_path(source.with_name(source.name + '.bak'))


# ── Library classification rules ──────────────────────────────────────────────
def _rel_dirs(filepath, watch_dir):
    try:
        rel = Path(filepath).resolve().relative_to(Path(watch_dir).resolve())
    except (ValueError, OSError):
        try:
            rel = Path(filepath).relative_to(watch_dir)
        except ValueError:
            return None
    return [part.lower() for part in rel.parts[:-1]], list(rel.parts[:-1])


def is_excluded(filepath, patterns, watch_dir):
    """Folder exclusions. A pattern without '/' matches any folder name
    (Extras, *sample*); one with '/' matches a path from the watch folder
    (Movies/Unsorted, TV/*/Specials). Matching ignores case."""
    if not patterns:
        return False
    rel = _rel_dirs(filepath, watch_dir)
    if rel is None:
        return False
    dirs = rel[0]
    for pattern in patterns:
        parts = [p.lower() for p in PurePosixPath(pattern.strip('/')).parts]
        if len(parts) == 1:
            if any(fnmatch(d, parts[0]) for d in dirs):
                return True
        elif len(dirs) >= len(parts) and all(fnmatch(dirs[i], parts[i]) for i in range(len(parts))):
            return True
    return False


def root_match(filepath, settings, watch_dir):
    """(media_type, root_depth, original-case dirs) for the deepest explicit
    movie/show root containing this file, else None."""
    rel = _rel_dirs(filepath, watch_dir)
    if rel is None:
        return None
    dirs, original = rel
    best = None
    for media_type, key in (('movie', 'movie_roots'), ('show', 'show_roots')):
        for root in settings.get(key) or []:
            parts = [p.lower() for p in PurePosixPath(root.strip('/')).parts]
            if parts and dirs[:len(parts)] == parts and (best is None or len(parts) > best[1]):
                best = (media_type, len(parts), original)
    return best


# ── Validation ────────────────────────────────────────────────────────────────
class SettingsError(ValueError):
    pass


def _bool(value, key):
    if type(value) is not bool:
        raise SettingsError(f'{key} must be true or false')
    return value


def _int(value, key, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or int(value) != value or not low <= value <= high:
        raise SettingsError(f'{label} must be a whole number from {low} to {high}')
    return int(value)


def _choice(value, key, options, label):
    if value not in options:
        raise SettingsError(f'Choose a valid {label}')
    return value


def _lang_list(value, key, label, normalize, languages):
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value) or len(value) > 200:
        raise SettingsError(f'{label} must be a list of language codes')
    result = sorted({normalize(v) for v in value if v and normalize(v)})
    unknown = [code for code in result if code not in languages]
    if unknown:
        raise SettingsError(f'{label} contains an unsupported language: {unknown[0]}')
    return result


def _folder_list(value, key, label):
    if not isinstance(value, list) or len(value) > 100:
        raise SettingsError(f'{label} must be a list of folder paths')
    result = []
    for item in value:
        if not isinstance(item, str):
            raise SettingsError(f'{label} must be a list of folder paths')
        cleaned = item.strip().replace('\\', '/').strip('/')
        if not cleaned:
            continue
        if len(cleaned) > 255 or '\x00' in cleaned or any(p in ('.', '..') for p in cleaned.split('/')) \
                or re.match(r'^[A-Za-z]:', cleaned):
            raise SettingsError(f'{label}: use folder paths inside the watch folder, such as Movies/4K')
        if cleaned.lower() not in (r.lower() for r in result):
            result.append(cleaned)
    return result


_BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def validate(payload, current, normalize, languages, watch_dir):
    """Validate and normalize every processing key present in payload.

    `current` is the config before the change; cross-field rules (such as the
    separate-output naming requirement) check the merged result.
    Raises SettingsError with a user-facing message.
    """
    out = {}
    for key, value in payload.items():
        if key not in DEFAULTS:
            continue
        if key in ('keep_audio_langs', 'keep_sub_langs'):
            out[key] = _lang_list(value, key, 'Audio keep list' if key == 'keep_audio_langs'
                                  else 'Subtitle keep list', normalize, languages)
        elif key in ('keep_all_audio_langs', 'keep_untagged_audio', 'keep_all_sub_langs', 'keep_untagged_subs',
                     'encode_10bit', 'backup_originals', 'keep_translated_sidecar'):
            out[key] = _bool(value, key)
        elif key == 'audio_fallback':
            out[key] = _choice(value, key, ('all', 'first'), 'audio fallback')
        elif key == 'audio_selection':
            out[key] = _choice(value, key, ('best', 'all'), 'audio selection mode')
        elif key == 'commentary_audio':
            out[key] = _choice(value, key, ('drop', 'keep'), 'commentary option')
        elif key == 'audio_codec_order':
            if not isinstance(value, list) or not value or not all(isinstance(v, str) and re.fullmatch(r'[a-z0-9_]{1,24}', v.lower()) for v in value) \
                    or len(value) > 40:
                raise SettingsError('Audio codec order must be a list of codec names')
            out[key] = list(dict.fromkeys(v.lower() for v in value))
        elif key in ('default_audio_lang', 'ocr_fallback_lang'):
            if not isinstance(value, str):
                raise SettingsError('Choose a supported language')
            code = normalize(value) if value else ''
            if key == 'ocr_fallback_lang' and not code:
                raise SettingsError('Choose an OCR fallback language')
            if code and code not in languages:
                raise SettingsError('Choose a supported language')
            out[key] = code
        elif key == 'video_encoder':
            out[key] = _choice(value, key, ENCODERS, 'video encoder')
        elif key == 'encode_profile':
            out[key] = _choice(value, key, QUALITY_PROFILES, 'quality profile')
        elif key == 'encode_quality':
            out[key] = _int(value, key, 0, 255, 'Quality value')
        elif key == 'encode_preset':
            out[key] = _choice(value, key, PRESETS, 'speed preset')
        elif key == 'encode_max_height':
            if value not in MAX_HEIGHTS or isinstance(value, bool):
                raise SettingsError('Choose a maximum resolution')
            out[key] = int(value)
        elif key == 'encode_lookahead':
            out[key] = _int(value, key, 0, 32, 'Lookahead')
        elif key == 'output_policy':
            out[key] = _choice(value, key, ('replace', 'separate'), 'output policy')
        elif key == 'output_dir':
            if not isinstance(value, str) or len(value) > 500 or '\x00' in value:
                raise SettingsError('Output folder must be a folder path')
            cleaned = value.strip()
            if cleaned:
                resolved = Path(os.path.normpath(resolve_output_dir(cleaned, watch_dir)))
                watch = Path(os.path.normpath(watch_dir))
                if resolved != watch and watch not in resolved.parents:
                    raise SettingsError('Choose an output folder inside the watch folder so outputs stay in your library')
            out[key] = cleaned
        elif key == 'output_suffix':
            if not isinstance(value, str) or len(value) > 40 or _BAD_NAME_CHARS.search(value):
                raise SettingsError('Filename suffix can’t contain / \\ : * ? " < > | and must be at most 40 characters')
            out[key] = value.strip()
        elif key == 'backup_retention_days':
            out[key] = _int(value, key, 0, 3650, 'Backup retention')
        elif key in ('ntfy_events', 'discord_events'):
            if not isinstance(value, list) or not all(v in NOTIFY_EVENTS for v in value):
                raise SettingsError('Choose notification events from the list')
            out[key] = [e for e in NOTIFY_EVENTS if e in value]
        elif key == 'ntfy_priorities':
            if not isinstance(value, dict) or not all(k in NOTIFY_EVENTS and v in NTFY_PRIORITIES for k, v in value.items()):
                raise SettingsError('Choose a valid Ntfy priority for each event')
            out[key] = {**(current.get(key) or DEFAULTS[key]), **value}
        elif key == 'translation_cache_days':
            out[key] = _int(value, key, 1, 365, 'Saved translation retention')
        elif key == 'local_ai_timeout':
            out[key] = _int(value, key, 30, 7200, 'Local AI timeout')
        elif key == 'ocr_preset':
            out[key] = _choice(value, key, ('fast', 'standard', 'accurate'), 'OCR mode')
        elif key in ('movie_roots', 'show_roots', 'excluded_folders'):
            out[key] = _folder_list(value, key, {'movie_roots': 'Movie folders', 'show_roots': 'Show folders',
                                                 'excluded_folders': 'Excluded folders'}[key])

    merged = {**DEFAULTS, **current, **out}
    if merged['output_policy'] == 'separate' and not merged['output_dir'] and not merged['output_suffix']:
        raise SettingsError('Add a filename suffix or choose an output folder so outputs never replace the original')
    overlap = {r.lower() for r in merged['movie_roots']} & {r.lower() for r in merged['show_roots']}
    if overlap:
        raise SettingsError(f'{sorted(overlap)[0]} can’t be both a movie folder and a show folder')
    if merged['encode_profile'] == 'custom' and merged['encode_quality'] > quality_max(merged['video_encoder']):
        raise SettingsError(f'Quality value must be at most {quality_max(merged["video_encoder"])} for this encoder')
    return out
