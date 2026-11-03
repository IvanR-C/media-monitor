"""PGS display sets, including every bitmap's position and visible bounds."""
import struct

from PIL import Image


def iter_segments(data):
    offset = 0
    while offset + 13 <= len(data):
        if data[offset:offset + 2] != b'PG':
            offset += 1
            continue
        length = struct.unpack_from('>H', data, offset + 11)[0]
        end = offset + 13 + length
        if end > len(data):
            raise ValueError('Truncated PGS segment')
        pts = struct.unpack_from('>I', data, offset + 2)[0] * 1000 // 90000
        yield pts, data[offset + 10], data[offset + 13:end]
        offset = end


def parse_pgs(data, decode_rle, include_layout=False):
    """Yield timed bitmaps; optionally append source-canvas layout metadata.

    Object/palette/window caches survive display sets within an epoch. A new
    composition closes all previously displayed objects, including clear events.
    Discrete movement is retained exactly as timed position changes, not guessed
    as a smooth animation.
    """
    palettes, objects, windows = {}, {}, {}
    pending, refs = [], []
    screen_w = screen_h = timestamp = palette_id = 0
    has_composition = False

    def finish(end):
        for start, image, layout in pending:
            if end > start:
                yield (start, end, image, layout) if include_layout else (start, end, image)
            else:
                image.close()

    for pts, kind, segment in iter_segments(data):
        if kind == 0x16:  # Presentation composition
            if len(segment) < 11:
                raise ValueError('Truncated PGS composition')
            if segment[7] & 0x80:  # Epoch start; pending images own their pixels.
                palettes, objects, windows = {}, {}, {}
            screen_w, screen_h = struct.unpack_from('>HH', segment)
            timestamp, palette_id, has_composition = pts, segment[9], True
            refs, offset = [], 11
            for _ in range(segment[10]):
                if offset + 8 > len(segment):
                    raise ValueError('Truncated PGS object reference')
                oid, window, flags, x, y = struct.unpack_from('>HBBHH', segment, offset)
                offset += 8
                crop = None
                if flags & 0x80:
                    if offset + 8 > len(segment):
                        raise ValueError('Truncated PGS crop rectangle')
                    crop = struct.unpack_from('>HHHH', segment, offset)
                    offset += 8
                refs.append((oid, window, flags, x, y, crop))
        elif kind == 0x14:  # Palette, selected by the composition's palette ID.
            if len(segment) < 2:
                raise ValueError('Truncated PGS palette')
            palette = palettes.setdefault(segment[0], {})
            for offset in range(2, len(segment) - 4, 5):
                entry, luminance, cr, cb, alpha = segment[offset:offset + 5]
                clamp = lambda v: max(0, min(255, round(v)))
                palette[entry] = (clamp(luminance + 1.402 * (cr - 128)),
                                  clamp(luminance - .34414 * (cb - 128) - .71414 * (cr - 128)),
                                  clamp(luminance + 1.772 * (cb - 128)), alpha)
        elif kind == 0x15:  # Fragmented bitmap data
            if len(segment) < 4:
                raise ValueError('Truncated PGS bitmap header')
            oid, flags = struct.unpack_from('>H', segment)[0], segment[3]
            if flags & 0x80:
                if len(segment) < 11:
                    raise ValueError('Truncated PGS bitmap dimensions')
                width, height = struct.unpack_from('>HH', segment, 7)
                expected = int.from_bytes(segment[4:7], 'big') - 4
                if not width or not height or width * height > 16777216 or expected < 0:
                    raise ValueError('Invalid PGS bitmap dimensions or length')
                objects[oid] = {'w': width, 'h': height, 'expected': expected,
                                'rle': bytearray(segment[11:]), 'complete': bool(flags & 0x40)}
            elif oid in objects:
                objects[oid]['rle'].extend(segment[4:])
                objects[oid]['complete'] = bool(flags & 0x40)
        elif kind == 0x17:  # Window definitions
            if not segment:
                raise ValueError('Truncated PGS windows')
            for i in range(segment[0]):
                offset = 1 + i * 9
                if offset + 9 > len(segment):
                    raise ValueError('Truncated PGS window rectangle')
                wid, x, y, width, height = struct.unpack_from('>BHHHH', segment, offset)
                windows[wid] = (x, y, x + width, y + height)
        elif kind == 0x80 and has_composition:
            yield from finish(timestamp)
            pending = []
            if refs and (not screen_w or not screen_h or palette_id not in palettes):
                raise ValueError('PGS composition is missing its canvas or palette')
            palette = palettes.get(palette_id, {})
            for oid, window, flags, x, y, crop in refs:
                obj = objects.get(oid)
                if not obj or not obj['complete'] or len(obj['rle']) != obj['expected']:
                    raise ValueError('PGS composition references an incomplete bitmap')
                width, height = obj['w'], obj['h']
                indices = decode_rle(bytes(obj['rle']), width, height)
                rgba = bytes(channel for index in indices for channel in palette.get(index, (0, 0, 0, 0)))
                image = Image.frombytes('RGBA', (width, height), rgba)
                # Clip the object to its crop, display window, and source canvas.
                left, top, right, bottom = 0, 0, width, height
                if crop:
                    cx, cy, cw, ch = crop
                    left, top, right, bottom = cx, cy, min(width, cx + cw), min(height, cy + ch)
                wx, wy, wr, wb = windows.get(window, (0, 0, screen_w, screen_h))
                left, top = max(left, wx - x, -x), max(top, wy - y, -y)
                right, bottom = min(right, wr - x, screen_w - x), min(bottom, wb - y, screen_h - y)
                if right <= left or bottom <= top:
                    image.close()
                    continue
                clipped = image.crop((left, top, right, bottom))
                image.close()
                bounds = clipped.getchannel('A').getbbox()
                if not bounds:
                    clipped.close()
                    continue
                visible = clipped.crop(bounds)
                clipped.close()
                layout = {'x': x + left + bounds[0], 'y': y + top + bounds[1],
                          'width': visible.width, 'height': visible.height,
                          'screen_width': screen_w, 'screen_height': screen_h,
                          'object_id': oid, 'forced': bool(flags & 0x40)}
                pending.append((timestamp, visible, layout))
            has_composition = False
    if pending:
        yield from finish(timestamp + 3000)
