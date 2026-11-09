"""Validated ASS styles shared by the preview and the subtitle worker."""
import bisect
import html
import itertools
import math
import operator
import re
import statistics
import sys
import unicodedata
from array import array
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
# Many SRTs carry ASS text escapes as plain text: \h (hard space), \N and \n
# (line breaks). Players honour them, so they are kept as real escapes; only
# other backslashes are made literal. \n becomes \N: an SRT author means a break.
_TEXT_ESCAPE = re.compile(r'\\([Nnh])')
_ESCAPED_TEXT_ESCAPE = re.compile(r'＼([Nnh])')


def _ass_escape(match):
    return '\\h' if match[1] == 'h' else '\\N'


def srt_to_ass(content, settings, layouts=None, end_limit=None):
    """Create a uniform dialogue style at 1080p; retain timing and basic markup.

    PGS regions can retain their positions; a source {\\anN} alignment is kept;
    other typesetting is flattened. `end_limit` (seconds, the video duration)
    clips cues so the track never outlasts the video. Exact duplicate cues
    (same times and text) are dropped.
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

    events, seen, matched = [], set(), 0
    limit = None if end_limit is None else int(end_limit * 100)
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
        matched += 1
        if limit is not None:
            end = min(end, limit)
            if end <= start:
                continue
        # Escape literal ASS control characters before adding our own tags.
        text = html.unescape(match[3].strip())
        alignment = next((m[1] for block in _OVERRIDE_BLOCK.findall(text) for m in [_ALIGNMENT.search(block)] if m), None)
        text = _OVERRIDE_BLOCK.sub('', text)
        # \x00 stands in for the backslash of escapes that must survive.
        text = _TEXT_ESCAPE.sub(lambda m: '\x00' + _ass_escape(m)[1], text)
        text = text.replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\x00', '\\')
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
        event = f'Dialogue: 0,{format_time(start)},{format_time(end)},Anime,,0,0,0,,{text}'
        if event not in seen:
            seen.add(event)
            events.append(event)
    if not events:
        raise ValueError('Subtitle contains no usable dialogue')
    if placements is not None and matched != len(placements):
        raise ValueError('PGS placement cue count changed')
    return header + '\n'.join(events) + '\n'


def _ass_seconds(value):
    h, m, s = value.strip().split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def _ass_time(seconds):
    cs = round(max(0.0, seconds) * 100)
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


def ass_cues(content):
    """(start, end) in seconds of every Dialogue event in an ASS document."""
    cues = []
    for line in content.replace('\r\n', '\n').split('\n'):
        fields = line.split(',', 9)
        if line.startswith('Dialogue:') and len(fields) == 10:
            cues.append((_ass_seconds(fields[1]), _ass_seconds(fields[2])))
    return cues


def ass_start_times(content):
    """Start time in seconds of every Dialogue event in an ASS document."""
    return [start for start, _ in ass_cues(content)]


def restyle_ass(content, settings, offset=0.0, end_limit=None):
    """Apply new style settings to a track Fix Anime made earlier.

    Its events are kept (positions, translation), so a re-run restyles instead
    of round-tripping through SRT; `offset` moves them when the timing is off
    and `end_limit` clips them to the video's length. Override tags and \\h/\\N
    escapes an earlier version turned into visible full-width text become real
    again.
    """
    events, seen = [], set()
    for line in content.replace('\r\n', '\n').split('\n'):
        if line.startswith('Dialogue:'):
            fields = line.split(',', 9)
            if len(fields) == 10:
                start, end = _ass_seconds(fields[1]) + offset, _ass_seconds(fields[2]) + offset
                if end_limit is not None:
                    end = min(end, end_limit)
                if end <= max(0.0, start):
                    continue
                if offset or end_limit is not None:
                    fields[1], fields[2] = _ass_time(start), _ass_time(end)
                fields[3] = 'Anime'
                fields[9] = _ESCAPED_OVERRIDE.sub(lambda m: '{\\' + m[1].replace('＼', '\\') + '}', fields[9])
                fields[9] = _ESCAPED_TEXT_ESCAPE.sub(_ass_escape, fields[9])
                event = ','.join(fields)
                if event not in seen:
                    seen.add(event)
                    events.append(event)
    if not events:
        raise ValueError('Subtitle contains no usable dialogue')
    return _ass_header(settings) + '\n'.join(events) + '\n'


# ── Sidecar timing alignment ─────────────────────────────────────────────────
_SRT_TIME = re.compile(r'(\d+):(\d{2}):(\d{2})[,.](\d{3})')
_SRT_TIMING_LINE = re.compile(r'^\s*(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})(.*)$', re.M)


def _seconds(value):
    h, m, s, ms = map(int, _SRT_TIME.fullmatch(value).groups())
    return h * 3600 + m * 60 + s + ms / 1000


def srt_cues(content):
    """(start, end) in seconds of every cue in an SRT document."""
    return [(_seconds(m[1]), _seconds(m[2])) for m in _SRT_TIMING_LINE.finditer(content.replace('\r\n', '\n'))]


def srt_start_times(content):
    """Start time in seconds of every cue in an SRT document."""
    return [start for start, _ in srt_cues(content)]


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


# ── Text clean-up ────────────────────────────────────────────────────────────
_SCRIPT_GROUPS = {'HIRAGANA': 'CJK', 'KATAKANA': 'CJK', 'HALFWIDTH': 'CJK', 'IDEOGRAPHIC': 'CJK'}


def _script(ch):
    """Writing system of a letter or mark, None for anything else."""
    category = unicodedata.category(ch)
    if not (ch.isalpha() or category.startswith('M')):
        return None
    code = ord(ch)
    if code < 0x0250 or 0x1E00 <= code <= 0x1EFF or 0x2C60 <= code <= 0x2C7F or 0xA720 <= code <= 0xA7FF:
        return 'LATIN'   # includes º/ª and accented letters
    if category.startswith('M') and code < 0x0370:
        return None      # combining accents go with any script
    word = unicodedata.name(ch, '').split(' ')[0]
    return _SCRIPT_GROUPS.get(word, word) or None


def remove_stray_script(source, translated, share=0.01):
    """Drop letters from a writing system that is rare in `translated` and absent
    from the matching `source` cue. Returns (text, number of characters removed).

    Models now and then append a word in an unrelated script (Bengali `পির` at
    the end of Spanish lines). A script that makes up under `share` of the
    letters, and that the source line did not contain, is such noise; names
    copied from the source survive.
    """
    counts = Counter(s for ch in translated for s in [_script(ch)] if s)
    total = sum(counts.values())
    stray = {s for s, c in counts.items() if c / total < share} if total else set()
    if not stray:
        return translated, 0
    split = re.compile(r'\n\s*\n')
    source_blocks = split.split(source.replace('\r\n', '\n').strip())
    blocks = split.split(translated.replace('\r\n', '\n').strip())
    aligned = len(source_blocks) == len(blocks)
    everywhere = set(source)
    removed = 0
    cleaned = []
    for i, block in enumerate(blocks):
        allowed = set(source_blocks[i]) if aligned else everywhere
        lines = block.split('\n')
        timing = next((j for j, line in enumerate(lines) if '-->' in line), -1)
        kept = lines[:timing + 1]
        for line in lines[timing + 1:]:
            new = ''.join(ch for ch in line if ch in allowed or _script(ch) not in stray)
            if new != line:
                removed += len(line) - len(new)
                new = re.sub(r'\s+([.,!?;:…])', r'\1', re.sub(r'[ \t]{2,}', ' ', new)).strip()
            if new:
                kept.append(new)
        cleaned.append('\n'.join(kept))
    return '\n\n'.join(cleaned) + ('\n' if translated.endswith('\n') else ''), removed


_STOPWORDS = {
    'eng': 'the and you to is it that of what this we are have was not your for with be just',
    'spa': 'que de no la el en es los se lo un por qué con para una me te está las del pero eso',
    'por': 'que não de você eu um uma isso com para está do da se ele mas',
    'fra': 'le la de et les des est que je vous pas ne un une il nous ce ça qui en',
    'ita': 'che di non il è la un per mi sono ho ti lo una questo cosa ma',
    'deu': 'der die und das ist nicht ich du sie es ein zu wir was den mit',
}
_STOPWORDS = {lang: set(words.split()) for lang, words in _STOPWORDS.items()}


def guess_subtitle_language(text):
    """3-letter code of the language a subtitle is written in, '' when unsure.

    For sidecars named only with a modifier (`Episode.hi.srt`, `.sdh.srt`):
    `hi` is also Hindi's code, so the dialogue decides. Covers the languages
    sidecars commonly come in. One-letter words are skipped: karaoke tracks
    split songs into single letters.
    """
    words = re.findall(r"[^\W\d_]{2,}", re.sub(r'\d+:\d\d:\d\d[,.]\d+|<[^>]+>|\{[^}]*\}', ' ', text).lower())
    if len(words) < 50:
        return ''
    scores = sorted(((sum(w in stop for w in words) / len(words), lang) for lang, stop in _STOPWORDS.items()),
                    reverse=True)
    (best, lang), (second, _) = scores[0], scores[1]
    return lang if best >= 0.15 and best >= 1.3 * second else ''


# ── Timing against the audio ─────────────────────────────────────────────────
# Without an embedded track to compare against, cues are lined up with the
# speech in the soundtrack: subtitles are on screen while people talk, so the
# shift that puts the most cue time over loud speech-band audio is the right
# one. Measured on Attack on Titan Blu-rays against their English PGS:
# within ±0.07 s of the PGS answer, confidence 6.7–18.8 for the episode's own
# subtitles and 2.1–3.8 for another episode's.
SPEECH_SAMPLE_RATE = 8000
FRAMES_PER_SECOND = 100
# Subtitles conventionally appear a little before the voice starts.
SUBTITLE_LEAD_IN = 0.14
AUDIO_MISMATCH_CONFIDENCE = 5.0   # below this the subtitle is for other audio
AUDIO_SHIFT_CONFIDENCE = 6.0      # at or above this the audio offset is trusted
AUDIO_MINIMUM_SHIFT = 0.3         # audio offsets are coarser than track offsets


def speech_envelope(pcm):
    """Per-10 ms speech activity from 8 kHz mono s16le speech-band audio.

    Log energy minus its 2 s running mean, so loud music beds and quiet scenes
    weigh the same; standardised to mean 0 and deviation 1.
    """
    samples = array('h')
    samples.frombytes(pcm[:len(pcm) // 2 * 2])
    if sys.byteorder == 'big':
        samples.byteswap()
    size = SPEECH_SAMPLE_RATE // FRAMES_PER_SECOND
    energy = [math.log10(sum(map(operator.mul, chunk, chunk)) / size + 1.0)
              for chunk in (samples[i:i + size] for i in range(0, len(samples) - size + 1, size))]
    if len(energy) < FRAMES_PER_SECOND * 60:
        return []
    window = 2 * FRAMES_PER_SECOND
    prefix = [0.0, *itertools.accumulate(energy)]
    n = len(energy)
    local = [energy[i] - (prefix[min(n, i + window // 2)] - prefix[max(0, i - window // 2)])
             / (min(n, i + window // 2) - max(0, i - window // 2)) for i in range(n)]
    mean = statistics.fmean(local)
    deviation = statistics.pstdev(local, mean)
    # Soundtracks vary by 0.7–1.0 (log10 energy); a steady tone or hiss by
    # under 0.1. Without that rise and fall there is nothing to line up with.
    if deviation < 0.2:
        return []
    return [(v - mean) / deviation for v in local]


def audio_offset(cues, envelope, max_offset=15.0):
    """Shift (seconds) that lines (start, end) cues up with `speech_envelope`.

    Returns (offset, confidence) or None with too little to compare.
    Confidence is how far the best shift's score stands above the scores of
    shifts more than a second away, in standard deviations.
    """
    fps = FRAMES_PER_SECOND
    n = len(envelope)
    cues = [(round(s * fps), round(e * fps)) for s, e in cues if e > s]
    if len(cues) < 20 or n < fps * 60:
        return None
    prefix = [0.0, *itertools.accumulate(envelope)]
    reach = int(max_offset * fps)
    lags = range(-reach, reach + 1)

    def clamp(i):
        return 0 if i < 0 else n if i > n else i

    scores = [sum(prefix[clamp(e + lag)] - prefix[clamp(s + lag)] for s, e in cues) for lag in lags]
    best = max(range(len(scores)), key=scores.__getitem__)
    far = [v for i, v in enumerate(scores) if abs(i - best) > fps]
    spread = statistics.pstdev(far) or 1.0
    confidence = (scores[best] - statistics.median(scores)) / spread
    # The coverage peak is broad; speech rising after each start and falling
    # after each end pins it down.
    width = 15

    def edges(lag):
        total = 0.0
        for s, e in cues:
            for t, sign in ((s + lag, 1), (e + lag, -1)):
                c = min(max(t, width), n - width)
                total += sign * (prefix[c + width] - 2 * prefix[c] + prefix[c - width])
        return total

    near = range(lags[best] - fps // 2, lags[best] + fps // 2 + 1)
    refined = max(near, key=edges)
    return round(refined / fps - SUBTITLE_LEAD_IN, 2), round(confidence, 1)


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
