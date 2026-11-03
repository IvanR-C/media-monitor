"""Validated ASS styles shared by the preview and the subtitle worker."""
import html
import math
import re


DEFAULT_SETTINGS = {
    'target_lang': 'spa', 'font_name': 'Noto Sans', 'font_size': 54,
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
    if result['target_lang'] not in languages or result['target_lang'] in ('und', 'mis', 'mul', 'zxx'):
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


def srt_to_ass(content, settings, layouts=None):
    """Create a uniform dialogue style at 1080p; retain timing and basic markup.

    PGS regions can retain their positions; other typesetting is flattened.
    """
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
        events.append(f'Dialogue: 0,{format_time(start)},{format_time(end)},Anime,,0,0,0,,{text}')
    if not events:
        raise ValueError('Subtitle contains no usable dialogue')
    if placements is not None and len(events) != len(placements):
        raise ValueError('PGS placement cue count changed')
    return header + '\n'.join(events) + '\n'
