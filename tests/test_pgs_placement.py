"""Synthetic PGS display sets exercise geometry without copyrighted media."""
import io
import json
import shutil
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from anime_subtitles import DEFAULT_SETTINGS, srt_to_ass

pytestmark = pytest.mark.usefixtures('spanish_anime_preferences')


def segment(ms, kind, payload=b''):
    return b'PG' + struct.pack('>IIBH', ms * 90, 0, kind, len(payload)) + payload


def composition(ms, refs, state=0, palette=0):
    payload = struct.pack('>HHBHBBBB', 1920, 1080, 0x10, ms, state, 0, palette, len(refs))
    for oid, x, y, crop in refs:
        payload += struct.pack('>HBBHH', oid, 0, 0x80 if crop else 0, x, y)
        if crop:
            payload += struct.pack('>HHHH', *crop)
    return segment(ms, 0x16, payload)


def palette(ms, pid=0, alpha=255):
    return segment(ms, 0x14, bytes([pid, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, alpha]))


def bitmap(ms, oid, width=80, height=30, fragmented=False):
    rle = (bytes([1]) * width + b'\x00\x00') * height
    header = struct.pack('>HBB', oid, 0, 0x80 if fragmented else 0xC0)
    header += (len(rle) + 4).to_bytes(3, 'big') + struct.pack('>HH', width, height)
    if fragmented:
        split = len(rle) // 2
        return segment(ms, 0x15, header + rle[:split]) + segment(ms, 0x15, struct.pack('>HBB', oid, 0, 0x40) + rle[split:])
    return segment(ms, 0x15, header + rle)


def moving_pgs():
    return (composition(1000, [(1, 200, 100, None), (2, 1500, 850, None)], state=0x80)
            + palette(1000) + bitmap(1000, 1) + bitmap(1000, 2, width=120) + segment(1000, 0x80)
            + composition(2000, [(1, 800, 500, None), (2, 1500, 850, None)]) + segment(2000, 0x80)
            + composition(3000, []) + segment(3000, 0x80))


def close_frames(frames):
    for frame in frames:
        frame[2].close()


def test_all_objects_and_cached_position_changes_survive(app_module):
    frames = list(app_module._parse_pgs(moving_pgs(), include_layout=True))
    try:
        assert [(s, e, layout['x'], layout['y']) for s, e, _, layout in frames] == [
            (1000, 2000, 200, 100), (1000, 2000, 1500, 850),
            (2000, 3000, 800, 500), (2000, 3000, 1500, 850)]
        assert all(layout['screen_width'] == 1920 and layout['screen_height'] == 1080 for _, _, _, layout in frames)
        assert frames[0][2].tobytes() == frames[2][2].tobytes()
    finally:
        close_frames(frames)


def test_legacy_parser_shape_and_fragmented_bitmap(app_module):
    data = (composition(1000, [(1, 100, 100, None)], state=0x80) + palette(1000)
            + bitmap(1000, 1, fragmented=True) + segment(1000, 0x80)
            + composition(2000, []) + segment(2000, 0x80))
    frames = list(app_module._parse_pgs(data))
    try:
        assert len(frames) == 1 and len(frames[0]) == 3
        assert frames[0][:2] == (1000, 2000)
    finally:
        close_frames(frames)


def test_crop_and_window_bounds_are_applied(app_module):
    data = (composition(1000, [(1, 200, 100, (10, 5, 40, 20))], state=0x80)
            + segment(1000, 0x17, bytes([1]) + struct.pack('>BHHHH', 0, 220, 110, 100, 100))
            + palette(1000) + bitmap(1000, 1) + segment(1000, 0x80)
            + composition(2000, []) + segment(2000, 0x80))
    frames = list(app_module._parse_pgs(data, include_layout=True))
    try:
        assert frames[0][2].size == (30, 15)
        assert frames[0][3]['x'] == 220 and frames[0][3]['y'] == 110
    finally:
        close_frames(frames)


def test_selected_palette_and_invisible_display(app_module):
    data = (composition(1000, [(1, 200, 100, None)], state=0x80, palette=2)
            + palette(1000, pid=0, alpha=0) + palette(1000, pid=2)
            + bitmap(1000, 1) + segment(1000, 0x80)
            + composition(2000, [(1, 200, 100, None)], palette=0) + segment(2000, 0x80))
    frames = list(app_module._parse_pgs(data, include_layout=True))
    try:
        assert len(frames) == 1 and frames[0][:2] == (1000, 2000)
    finally:
        close_frames(frames)


def test_new_epoch_cannot_reuse_stale_bitmap(app_module):
    data = moving_pgs() + composition(4000, [(1, 200, 100, None)], state=0x80) + palette(4000) + segment(4000, 0x80)
    iterator = app_module._parse_pgs(data, include_layout=True)
    with pytest.raises(ValueError, match='incomplete bitmap'):
        for frame in iterator:
            frame[2].close()


def test_sparse_regions_map_back_after_ocr_upscaling(app_module, monkeypatch):
    import pytesseract
    monkeypatch.setattr(pytesseract, 'image_to_data', lambda *a, **kw: {
        'text': ['Hello', 'world', 'SIGN', ''], 'conf': ['95', '94', '90', '-1'],
        'block_num': [1, 1, 2, 0], 'par_num': [1, 1, 1, 0], 'line_num': [1, 1, 1, 0],
        'left': [20, 70, 100, 0], 'top': [10, 10, 40, 0],
        'width': [40, 40, 30, 0], 'height': [10, 10, 10, 0],
    })
    with Image.new('L', (160, 60), 255) as gray:
        regions = app_module._pgs_text_regions(gray, (80, 30), 'eng')
    assert regions == [('Hello world', (10, 5, 45, 5)), ('SIGN', (50, 20, 15, 5))]


def fake_ocr_data(image, **kwargs):
    return {'text': ['Caption'], 'conf': [95], 'block_num': [1], 'par_num': [1],
            'line_num': [1], 'left': [0], 'top': [0], 'width': [image.width], 'height': [image.height]}


def test_ocr_streams_all_regions_and_reuses_moving_bitmaps(app_module, monkeypatch):
    import pytesseract
    calls = []
    def extract(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(moving_pgs())
        return SimpleNamespace(returncode=0, stderr='')
    def ocr(image, **kwargs):
        calls.append(image.size)
        return fake_ocr_data(image, **kwargs)
    monkeypatch.setattr(app_module.subprocess, 'run', extract)
    monkeypatch.setattr(pytesseract, 'image_to_data', ocr)
    layouts = []
    content = app_module.pgs_ocr('test.mkv', 0, 'eng', layout_out=layouts)
    assert len(app_module._parse_srt_blocks(content)) == len(layouts) == 4
    assert len(calls) == 2  # Two distinct bitmaps, each displayed twice.
    assert [layout['x'] for layout in layouts] == [200, 1500, 800, 1500]
    ass = srt_to_ass(content, DEFAULT_SETTINGS, layouts=layouts)
    assert r'{\an7\pos(200,100)}' in ass
    assert r'{\an3\pos(1620,880)}' in ass
    assert r'{\an5\pos(840,515)}' in ass


def test_legacy_ocr_still_returns_srt(app_module, monkeypatch):
    import pytesseract
    def extract(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(moving_pgs())
        return SimpleNamespace(returncode=0, stderr='')
    monkeypatch.setattr(app_module.subprocess, 'run', extract)
    monkeypatch.setattr(pytesseract, 'image_to_string', lambda *a, **kw: 'Hello\n\nworld')
    content = app_module.pgs_ocr('test.mkv', 0, 'eng')
    assert len(app_module._parse_srt_blocks(content)) == 4
    assert 'Hello\nworld' in content


def test_layout_survives_translation_without_sending_positions_to_ai(app_module, monkeypatch, tmp_path):
    content = ('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n'
               '2\n00:00:01,000 --> 00:00:02,000\nSign\n\n'
               '3\n00:00:02,000 --> 00:00:03,000\nHello')
    source = tmp_path / 'source.srt'
    source.write_text(content, encoding='utf-8')
    layouts = [{'cue_id': i, 'x': 200 if i != 3 else 1200, 'y': 100,
                'width': 100, 'height': 40, 'screen_width': 1920, 'screen_height': 1080} for i in (1, 2, 3)]
    calls = []
    def translate(path, source_lang, **kwargs):
        text = Path(path).read_text(encoding='utf-8')
        calls.append(text)
        assert len(app_module._parse_srt_blocks(text)) == 2
        assert 'pos(' not in text and 'screen_width' not in text
        return text.replace('Hello', 'Hola').replace('Sign', 'Letrero')
    monkeypatch.setattr(app_module, 'translate_subtitle_file', translate)
    translated = app_module.translate_anime_subtitle_file(str(source), 'eng', layouts=layouts, target_lang='spa')
    assert len(calls) == 1
    assert translated.count('Hola') == 2
    assert '3\n00:00:02,000 --> 00:00:03,000\nHola' in translated
    ass = srt_to_ass(translated, DEFAULT_SETTINGS, layouts)
    assert r'\pos(200,100)' in ass and r'\pos(1250,100)' in ass


def test_ass_scaling_and_toggle_off():
    content = '1\n00:00:01,000 --> 00:00:02,000\nCaption'
    layouts = [{'cue_id': 1, 'x': 100, 'y': 50, 'width': 200, 'height': 30,
                'screen_width': 1280, 'screen_height': 720}]
    assert r'{\an7\pos(150,75)}' in srt_to_ass(content, DEFAULT_SETTINGS, layouts)
    assert r'\pos(' not in srt_to_ass(content, {**DEFAULT_SETTINGS, 'preserve_pgs_placement': False}, layouts)
    with pytest.raises(ValueError, match='cue count'):
        srt_to_ass(content, DEFAULT_SETTINGS, layouts + [{**layouts[0], 'cue_id': 2}])


def test_settings_default_and_boolean_validation(client):
    assert client.get('/api/anime/settings').get_json()['settings']['preserve_pgs_placement'] is True
    assert client.post('/api/anime/settings', json={'preserve_pgs_placement': False}).status_code == 200
    assert client.get('/api/anime/settings').get_json()['settings']['preserve_pgs_placement'] is False
    assert client.post('/api/anime/settings', json={'preserve_pgs_placement': 'yes'}).status_code == 400


@pytest.mark.parametrize('preserve', [True, False])
def test_real_pgs_to_ass_job_keeps_timing_positions_and_translation(client, app_module, monkeypatch, tmp_path, insert_media, preserve):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg/ffprobe unavailable')
    import pytesseract
    sup = tmp_path / 'source.sup'
    sup.write_bytes(moving_pgs())
    video = tmp_path / 'pgs.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=5',
                    '-i', str(sup), '-map', '0:v', '-map', '1:s', '-t', '4', '-c:v', 'mpeg4', '-c:s', 'copy',
                    '-metadata:s:s:0', 'language=eng', str(video)], check=True, capture_output=True, timeout=30)
    info = app_module.parse_media_info(str(video))
    fid = insert_media(filepath=str(video), filename=video.name, audio_tracks=info['audio_tracks'], subtitle_tracks=info['subtitle_tracks'])
    monkeypatch.setattr(pytesseract, 'image_to_data', fake_ocr_data)
    monkeypatch.setattr(pytesseract, 'image_to_string', lambda *a, **kw: 'Caption')
    monkeypatch.setattr(app_module, '_translation_backend_ready', lambda settings=None: (True, ''))
    requests = []
    def translate(path, source_lang, **kwargs):
        text = Path(path).read_text(encoding='utf-8')
        requests.append(text)
        return text.replace('Caption', 'Subtítulo')
    monkeypatch.setattr(app_module, 'translate_subtitle_file', translate)
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'preserve_pgs_placement': preserve}}).get_json()
    app_module.run_translation_job(result['queued'][0])
    job = client.get('/api/translate/jobs').get_json()['jobs'][0]
    assert job['status'] == 'done', job['error_text']
    _, _, tracks = app_module._streams_from_ffprobe(app_module.run_ffprobe(str(video)))
    ass_track = next(t for t in tracks if t['codec'] == 'ass')
    exported = tmp_path / 'result.ass'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-map', f'0:s:{ass_track["sub_idx"]}',
                    '-c:s', 'copy', str(exported)], check=True, capture_output=True, timeout=30)
    ass = exported.read_text(encoding='utf-8-sig')
    # Without placement, regions shown together with the same text would stack
    # as duplicate lines; only one of each is kept.
    assert ass.count('Subtítulo') == (4 if preserve else 2)
    assert r'\pos(200,100)' in ass if preserve else r'\pos(' not in ass
    assert len(app_module._parse_srt_blocks(requests[0])) == (1 if preserve else 4)


def test_rendered_preview_obeys_pgs_preservation(client):
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg unavailable')
    boxes = []
    for preserve in (True, False):
        response = client.post('/api/anime/preview', json={'scene': 'pgs_top', 'text': 'Sample',
                               'settings': {'preserve_pgs_placement': preserve}})
        assert response.status_code == 200
        with Image.open(io.BytesIO(response.data)).convert('RGB') as image:
            background = {color for _, color in sorted(image.getcolors(image.width * image.height), reverse=True)[:2]}
            mask = Image.new('L', image.size)
            mask.putdata([0 if pixel in background else 255 for pixel in image.getdata()])
            boxes.append(mask.getbbox())
            mask.close()
    assert boxes[0][3] < 180  # Source top placement.
    assert boxes[1][1] > 400  # Default bottom placement when disabled.
