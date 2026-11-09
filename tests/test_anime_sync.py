"""Fix Anime: position tags, restyling, sidecar timing and default tracks."""
import json
import shutil
import subprocess

import pytest

from anime_subtitles import (DEFAULT_SETTINGS, estimate_offset, restyle_ass, shift_srt, should_shift,
                             srt_start_times, srt_to_ass)

pytestmark = pytest.mark.usefixtures('spanish_anime_preferences')


def srt_doc(cues, offset=0.0, text='Line'):
    def fmt(t):
        ms = round(t * 1000)
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
    return '\n\n'.join(f'{i + 1}\n{fmt(s + offset)} --> {fmt(s + offset + 1.2)}\n{text} {i}'
                       for i, s in enumerate(cues)) + '\n'


# Irregular gaps, like real dialogue, so only one shift lines everything up.
CUES = [round(3 + i * 1.7 + (i * 7919 % 13) * 0.11, 3) for i in range(40)]


def test_ass_alignment_tags_from_converted_ass_are_kept_not_escaped():
    ass = srt_to_ass('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Top line\n\n'
                     '2\n00:00:03,000 --> 00:00:04,000\n{\\fad(200,0)\\an2}Faded {\\i1}bottom\n', DEFAULT_SETTINGS)
    assert r'{\an8}Top line' in ass
    assert r'{\an2}Faded bottom' in ass
    assert '｛' not in ass and '＼' not in ass and r'\fad' not in ass


def test_literal_braces_are_still_escaped():
    ass = srt_to_ass('1\n00:00:01,000 --> 00:00:02,000\nA {note} here\n', DEFAULT_SETTINGS)
    assert 'A ｛note｝ here' in ass


def test_restyle_repairs_escaped_tags_and_applies_new_style():
    broken = srt_to_ass('1\n00:00:01,000 --> 00:00:02,000\nHola\n', DEFAULT_SETTINGS).replace(
        'Hola', '{\\b1}｛＼an2＼pos(958,1000)｝Hola{\\b1}')
    out = restyle_ass(broken, {**DEFAULT_SETTINGS, 'font_name': 'Trebuchet MS'})
    assert 'Style: Anime,Trebuchet MS,' in out
    assert r'{\b1}{\an2\pos(958,1000)}Hola{\b1}' in out
    assert '0:00:01.00,0:00:02.00' in out


def test_estimate_offset_finds_constant_shift_between_different_translations():
    # The sidecar is 1.05 s early and splits some lines differently.
    source = [t - 1.05 for i, t in enumerate(CUES) if i % 7] + [t - 1.05 + 0.6 for t in CUES[::7]]
    estimate = estimate_offset(sorted(source), CUES)
    assert estimate[0] == pytest.approx(1.05, abs=0.02)
    assert estimate[1] >= 0.8 and estimate[2] < 0.2
    assert should_shift(estimate)
    assert not should_shift(estimate_offset(CUES, CUES))
    assert estimate_offset(CUES[:10], CUES) is None
    assert srt_start_times(srt_doc([1.5, 2.25])) == [1.5, 2.25]


def test_shift_srt_moves_cues_and_drops_ones_before_zero():
    shifted = shift_srt(srt_doc([0.1, 5.0]), -1.0)
    assert srt_start_times(shifted) == [0.0, 4.0]  # clipped, not dropped: it ends after 0:00
    assert srt_start_times(shift_srt(srt_doc([0.1]), -1.5)) == []
    assert '00:00:04,000 --> 00:00:05,200' in shifted
    assert srt_start_times(shift_srt(srt_doc([5.0]), 1.05)) == [6.05]


@pytest.fixture
def sidecar_episode(tmp_path, app_module, insert_media):
    """English embedded on the video's timeline; Spanish sidecar 1.05 s early."""
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg/ffprobe not installed')
    eng = tmp_path / 'eng.srt'
    eng.write_text(srt_doc(CUES, text='English'), encoding='utf-8')
    video = tmp_path / 'Show - S01E01.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=2',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-i', str(eng),
                    '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:0', '-map', '2:0', '-t', '90',
                    '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-c:s', 'srt',
                    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
                    '-disposition:a:0', 'default', '-disposition:a:1', '0',
                    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Signs',
                    '-disposition:s:0', 'default+forced',
                    '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=Dialogue',
                    '-disposition:s:1', '0', str(video)], check=True, capture_output=True, timeout=60)
    (tmp_path / 'Show - S01E01.es.srt').write_text(srt_doc(CUES, offset=-1.05, text='Español'), encoding='utf-8')
    info = app_module.parse_media_info(str(video))
    fid = insert_media(filepath=str(video), filename=video.name, media_type='show', show_name='Show',
                       audio_tracks=info['audio_tracks'], subtitle_tracks=info['subtitle_tracks'])
    return fid, video


def styled_track(video):
    probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(video)],
                                      capture_output=True, text=True, check=True).stdout)['streams']
    subs = [s for s in probe if s['codec_type'] == 'subtitle']
    styled = [i for i, s in enumerate(subs) if s.get('tags', {}).get('title', '').startswith('Anime ASS')]
    content = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-map', f'0:s:{styled[0]}', '-f', 'ass', '-'],
                             capture_output=True, text=True, encoding='utf-8', check=True).stdout if styled else ''
    return probe, subs, styled, content


def first_dialogue(content):
    return next(line for line in content.splitlines() if line.startswith('Dialogue:'))


def run_job(client, app_module, fid, settings=None):
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': settings or {}}).get_json()
    assert result['count'] == 1, result
    app_module.run_translation_job(result['queued'][0])
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (result['queued'][0],)).fetchone()
    assert job['status'] == 'done', job['error_text']
    return job


def test_real_sidecar_is_retimed_to_embedded_track_and_made_default(client, app_module, monkeypatch, sidecar_episode):
    fid, video = sidecar_episode
    monkeypatch.setattr(app_module, 'translate_subtitle_file', lambda *a, **k: pytest.fail('AI must not run'))
    job = run_job(client, app_module, fid)
    assert 'shifted +1.05 s' in job['progress_detail']
    probe, subs, styled, content = styled_track(video)
    assert len(styled) == 1
    first = first_dialogue(content)
    assert first.split(',')[1] == '0:00:03.00' and 'Español 0' in first
    # The styled Spanish and the Japanese audio are the defaults; Signs keeps forced.
    assert [s['disposition']['default'] for s in subs] == [0, 0, 1]
    assert subs[0]['disposition']['forced'] == 1
    audio = [s for s in probe if s['codec_type'] == 'audio']
    assert [(s['tags']['language'], s['disposition']['default']) for s in audio] == [('eng', 0), ('jpn', 1)]


def test_real_rerun_restyles_existing_track_without_duplicating_or_shifting_again(client, app_module, monkeypatch, sidecar_episode):
    fid, video = sidecar_episode
    monkeypatch.setattr(app_module, 'translate_subtitle_file', lambda *a, **k: pytest.fail('AI must not run'))
    run_job(client, app_module, fid, {'font_name': 'Noto Sans'})
    job = run_job(client, app_module, fid, {'font_name': 'Trebuchet MS'})
    assert 'shifted' not in job['progress_detail']
    _, subs, styled, content = styled_track(video)
    assert len(styled) == 1 and len(subs) == 3
    assert 'Style: Anime,Trebuchet MS,' in content
    assert first_dialogue(content).split(',')[1] == '0:00:03.00'


def test_real_sidecar_already_in_sync_is_left_alone(client, app_module, monkeypatch, sidecar_episode, tmp_path):
    fid, video = sidecar_episode
    (tmp_path / 'Show - S01E01.es.srt').write_text(srt_doc(CUES, text='Español'), encoding='utf-8')
    job = run_job(client, app_module, fid)
    assert 'shifted' not in job['progress_detail']
    _, _, _, content = styled_track(video)
    assert first_dialogue(content).split(',')[1] == '0:00:03.00'


def test_real_rerun_fixes_track_styled_from_mistimed_sidecar_before_alignment(client, app_module, monkeypatch, sidecar_episode):
    """Episodes processed by older versions carry the sidecar's early timing."""
    fid, video = sidecar_episode
    with monkeypatch.context() as patch:
        patch.setattr(app_module, 'timing_correction', lambda *a, **k: None)
        run_job(client, app_module, fid)
    assert first_dialogue(styled_track(video)[3]).split(',')[1] == '0:00:01.95'
    job = run_job(client, app_module, fid)
    assert 'styled track timing shifted +1.05 s' in job['progress_detail']
    _, subs, styled, content = styled_track(video)
    assert len(styled) == 1 and len(subs) == 3
    assert first_dialogue(content).split(',')[1] == '0:00:03.00'
