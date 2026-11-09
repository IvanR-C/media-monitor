"""Validated ASS styles shared by the preview and the subtitle worker."""
import bisect
import html
import math
import re
import statistics
from collections import Counter


DEFAULT_SETTINGS = {
    'target_lang': '', 'font_name': 'Noto Sans', 'font_size': 54,
    'primary_color': '#FFFFFF', 'outline_color': '#15151F',
    'shadow_color': '#000000', 'outline': 2.5, 'shadow': 1.5,
    'margin_v': 48, 'alignment': 2, 'bold': True, 'italic': False,
    'audio_languages': ['jpn', 'eng', 'spa'],
    'subtitle_languages': ['eng', 'spa'], 'mode': 'target',
    'preserve_pgs_placement': True,
}


def validate_settings(value, languages):
    if not isinstance(value, dict):
        raise ValueError('Anime settings must be an object')
    if set(value) - set(DEFAULT_SETTINGS):
        raise ValueError('Unknown anime setting')
    result = {**DEFAULT_SETTINGS, **value}
    if result['mode'] not in ('target', 'all'):
        raise ValueError('Choose target-language or all-subtitles mode')
    for key in ('audio_languages', 'subtitle_languages'):
        values = result[key]
        if not isinstance(values, list) or not values or not all(isinstance(v, str) and v in languages for v in values):
            raise ValueError(f'{key} must contain at least one supported language')
        result[key] = list(dict.fromkeys(values))
    if not isinstance(result['target_lang'], str) or (result['target_lang'] and
            (result['target_lang'] not in languages or result['target_lang'] in ('und', 'mis', 'mul', 'zxx'))):
        raise ValueError('Choose a supported target subtitle language')
    font = result['font_name']
    if not isinstance(font, str) or not font.strip() or len(font) > 80 or re.search(r'[,\r\n{}\\]', font):
        raise ValueError('Font name must be 1–80 characters without ASS control characters')
    result['font_name'] = font.strip()
    for key in ('primary_color', 'outline_color', 'shadow_color'):
        if not isinstance(result[key], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', result[key]):
            raise ValueError(f'{key} must be a hex color (#RRGGBB)')
    for key, minimum, maximum in [('font_size', 12, 120), ('outline', 0, 10),
                                   ('shadow', 0, 10), ('margin_v', 0, 300)]:
        number = result[key]
        if isinstance(number, bool) or not isinstance(number, (float, int)) or not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValueError(f'{key} must be between {minimum} and {maximum}')
    if type(result['alignment']) is not int or result['alignment'] not in (2, 5, 8):
        raise ValueError('Alignment must be bottom, middle, or top center')
    for key in ('bold', 'italic', 'preserve_pgs_placement'):
        if not isinstance(result[key], bool):
            raise ValueError(f'{key} must be a boolean')
    return result


def ass_color(color):
    return '&H00' + color[5:7] + color[3:5] + color[1:3]


def _position_override(layout):
    """Anchor each region to its source screen zone, scaled to ASS coordinates."""
    sw, sh = layout['screen_width'], layout['screen_height']
    x, y, w, h = (layout[key] for key in ('x', 'y', 'width', 'height'))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
           for v in (sw, sh, x, y, w, h)) or min(sw, sh, w, h) <= 0:
        raise ValueError('Invalid PGS placement metadata')
    cx, cy = x + w / 2, y + h / 2
    col = 0 if cx < sw / 3 else 2 if cx > sw * 2 / 3 else 1
    row = 2 if cy < sh / 3 else 0 if cy > sh * 2 / 3 else 1
    px = (x, cx, x + w)[col]
    py = (y + h, cy, y)[row]
    px, py = round(max(0, min(sw, px)) * 1920 / sw), round(max(0, min(sh, py)) * 1080 / sh)
    return '{' + rf'\an{row * 3 + col + 1}\pos({px},{py})' + '}'


def _ass_header(settings):
    s = settings
    style = ','.join(map(str, [
        'Anime', s['font_name'], s['font_size'], ass_color(s['primary_color']),
        ass_color(s['primary_color']), ass_color(s['outline_color']),
        ass_color(s['shadow_color']), -int(s['bold']), -int(s['italic']),
        0, 0, 100, 100, 0, 0, 1, s['outline'], s['shadow'], s['alignment'],
        60, 60, s['margin_v'], 1,
    ]))
    header = (
        '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n'
        'WrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n'
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, '
        'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, '
        'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
        f'Style: {style}\n\n[Events]\n'
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    )
    return header


# ffmpeg keeps ASS override blocks such as {\an8} when it converts an ASS
# track to SRT. They are markup, never dialogue, so they must not be escaped
# into visible text.
_OVERRIDE_BLOCK = re.compile(r'\{\\[^{}]*\}')
_ALIGNMENT = re.compile(r'\\an([1-9])')
# Earlier versions escaped those blocks into full-width look-alikes.
_ESCAPED_OVERRIDE = re.compile(r'｛＼([^｛｝]*)｝')


def srt_to_ass(content, settings, layouts=None):
    """Create a uniform dialogue style at 1080p; retain timing and basic markup.

    PGS regions can retain their positions; a source {\\anN} alignment is kept;
    other typesetting is flattened.
    """
    s = settings
    header = _ass_header(s)

    def timestamp(value):
        h, m, sec, ms = map(int, re.split(r'[:,.]', value))
        if m > 59 or sec > 59:
            raise ValueError('Invalid subtitle timestamp')
        return h * 360000 + m * 6000 + sec * 100 + ms // 10

    def format_time(cs):
        return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'

    events = []
    placements = {str(item['cue_id']): item for item in layouts} if layouts is not None else None
    if placements is not None and len(placements) != len(layouts):
        raise ValueError('Duplicate PGS cue placement IDs')
    pattern = r'(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})[^\n]*\n(.+)'
    for block in re.split(r'\n\s*\n', content.replace('\r\n', '\n').strip()):
        match = re.search(pattern, block, re.S)
        if not match:
            continue
        start, end = timestamp(match[1]), timestamp(match[2])
        if end <= start:
            continue
        # Escape literal ASS control characters before adding our own tags.
        text = html.unescape(match[3].strip())
        alignment = next((m[1] for block in _OVERRIDE_BLOCK.findall(text) for m in [_ALIGNMENT.search(block)] if m), None)
        text = _OVERRIDE_BLOCK.sub('', text)
        text = text.replace('\\', '＼').replace('{', '｛').replace('}', '｝')
        for tag, default in [('i', s['italic']), ('b', s['bold']), ('u', False)]:
            text = re.sub(f'<{tag}>', lambda _: '{\\' + tag + '1}', text, flags=re.I)
            text = re.sub(f'</{tag}>', lambda _: '{\\' + tag + str(int(default)) + '}', text, flags=re.I)
        text = re.sub(r'<[^>]+>', '', text).replace('\n', r'\N')
        if placements is not None:
            cue_id = block.splitlines()[0].strip().lstrip('\ufeff')
            if cue_id not in placements:
                raise ValueError('PGS placement no longer matches subtitle cues')
            if settings.get('preserve_pgs_placement', True):
                text = _position_override(placements[cue_id]) + text
        elif alignment:
            text = '{\\an' + alignment + '}' + text
        events.append(f'Dialogue: 0,{format_time(start)},{format_time(end)},Anime,,0,0,0,,{text}')
    if not events:
        raise ValueError('Subtitle contains no usable dialogue')
    if placements is not None and len(events) != len(placements):
        raise ValueError('PGS placement cue count changed')
    return header + '\n'.join(events) + '\n'


def _ass_seconds(value):
    h, m, s = value.strip().split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def _ass_time(seconds):
    cs = round(max(0.0, seconds) * 100)
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


def ass_start_times(content):
    """Start time in seconds of every Dialogue event in an ASS document."""
    starts = []
    for line in content.replace('\r\n', '\n').split('\n'):
        fields = line.split(',', 9)
        if line.startswith('Dialogue:') and len(fields) == 10:
            starts.append(_ass_seconds(fields[1]))
    return starts


def restyle_ass(content, settings, offset=0.0):
    """Apply new style settings to a track Fix Anime made earlier.

    Its events are kept (positions, translation), so a re-run restyles instead
    of round-tripping through SRT; `offset` moves them when the timing is off.
    Override tags an earlier version escaped into visible text are turned back
    into real tags.
    """
    events = []
    for line in content.replace('\r\n', '\n').split('\n'):
        if line.startswith('Dialogue:'):
            fields = line.split(',', 9)
            if len(fields) == 10:
                if offset:
                    start, end = _ass_seconds(fields[1]) + offset, _ass_seconds(fields[2]) + offset
                    if end <= 0:
                        continue
                    fields[1], fields[2] = _ass_time(start), _ass_time(end)
                fields[3] = 'Anime'
                fields[9] = _ESCAPED_OVERRIDE.sub(lambda m: '{\\' + m[1].replace('＼', '\\') + '}', fields[9])
                events.append(','.join(fields))
    if not events:
        raise ValueError('Subtitle contains no usable dialogue')
    return _ass_header(settings) + '\n'.join(events) + '\n'


# ── Sidecar timing alignment ─────────────────────────────────────────────────
_SRT_TIME = re.compile(r'(\d+):(\d{2}):(\d{2})[,.](\d{3})')
_SRT_TIMING_LINE = re.compile(r'^\s*(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})(.*)$', re.M)


def _seconds(value):
    h, m, s, ms = map(int, _SRT_TIME.fullmatch(value).groups())
    return h * 3600 + m * 60 + s + ms / 1000


def srt_start_times(content):
    """Start time in seconds of every cue in an SRT document."""
    return [_seconds(m[1]) for m in _SRT_TIMING_LINE.finditer(content.replace('\r\n', '\n'))]


def _match_fraction(source, reference, offset, tolerance):
    hits = 0
    for start in source:
        shifted = start + offset
        k = bisect.bisect_left(reference, shifted)
        if any(0 <= j < len(reference) and abs(reference[j] - shifted) <= tolerance for j in (k - 1, k)):
            hits += 1
    return hits / len(source)


def estimate_offset(source, reference, max_offset=15.0, tolerance=0.15, bin_size=0.05):
    """Find the constant shift that best lines `source` cue starts up with `reference`.

    Both are start times in seconds. The two tracks may be different
    translations that split lines differently, so the shift is the one most cue
    pairs agree on, not an average. Returns (offset, aligned, aligned_unshifted)
    as fractions of source cues, or None when there are too few cues to tell.
    """
    reference = sorted(reference)
    if len(source) < 20 or len(reference) < 20:
        return None
    votes = Counter()
    for start in source:
        lo = bisect.bisect_left(reference, start - max_offset)
        hi = bisect.bisect_right(reference, start + max_offset)
        for r in reference[lo:hi]:
            votes[round((r - start) / bin_size)] += 1
    if not votes:
        return None
    # Neighbouring bins split one true offset between them; score bins with
    # their neighbours and refine with the median of the pairs they hold.
    best = max(votes, key=lambda b: (votes[b - 1] + votes[b] + votes[b + 1], votes[b]))
    near = []
    for start in source:
        lo = bisect.bisect_left(reference, start + (best - 1.5) * bin_size)
        hi = bisect.bisect_right(reference, start + (best + 1.5) * bin_size)
        near.extend(r - start for r in reference[lo:hi])
    offset = round(statistics.median(near), 3)
    return (offset, _match_fraction(source, reference, offset, tolerance),
            _match_fraction(source, reference, 0.0, tolerance))


def should_shift(estimate, minimum_shift=0.2, minimum_aligned=0.5, minimum_gain=0.2):
    """True when a shift clearly fixes the timing rather than chasing noise."""
    if not estimate:
        return False
    offset, aligned, unshifted = estimate
    return abs(offset) >= minimum_shift and aligned >= minimum_aligned and aligned - unshifted >= minimum_gain


def shift_srt(content, offset):
    """Move every cue by `offset` seconds; cues pushed before 0:00 are clipped or dropped."""
    def fmt(seconds):
        ms = round(seconds * 1000)
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'

    blocks = []
    for block in re.split(r'\n\s*\n', content.replace('\r\n', '\n').strip()):
        match = _SRT_TIMING_LINE.search(block)
        if not match:
            continue
        start, end = _seconds(match[1]) + offset, _seconds(match[2]) + offset
        if end <= 0:
            continue
        timing = f'{fmt(max(0.0, start))} --> {fmt(end)}{match[3]}'
        blocks.append(block[:match.start()] + timing + block[match.end():])
    return '\n\n'.join(blocks) + '\n'
