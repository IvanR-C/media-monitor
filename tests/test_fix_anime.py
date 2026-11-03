"""Exercise planning, persistence, and real ffmpeg remuxing of disposable media."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from anime_subtitles import DEFAULT_SETTINGS, srt_to_ass


SRT = '1\n00:00:00,100 --> 00:00:00,900\nHello <i>world</i>!\n'


def tracks(*languages):
    return json.dumps([{'sub_idx': i, 'lang': lang, 'codec': 'subrip'} for i, lang in enumerate(languages)])


def test_style_preserves_timing_markup_and_escapes_ass():
    ass = srt_to_ass(SRT + '\n2\n01:00:00,010 --> 01:00:03,100\nLiteral {\\pos(0,0)}\nNext line', DEFAULT_SETTINGS)
    assert 'PlayResY: 1080' in ass
    assert '&H001F1515' in ass
    assert '0:00:00.10,0:00:00.90' in ass
    assert r'Hello {\i1}world{\i0}!' in ass
    assert r'1:00:00.01,1:00:03.10' in ass
    assert r'{\pos(0,0)}' not in ass
    assert r'\NNext line' in ass


@pytest.mark.parametrize('setting', [
    {'font_name': 'Arial\n[Events]'}, {'font_size': 999}, {'outline': float('inf')},
    {'primary_color': 'red'}, {'alignment': True}, {'bold': 'yes'},
    {'target_lang': 'not-a-language'}, {'audio_languages': []},
    {'subtitle_languages': 'eng'}, {'mode': 'anything'}, {'extra': 1},
])
def test_invalid_settings_do_not_persist(client, app_module, setting):
    response = client.post('/api/anime/settings', json=setting)
    assert response.status_code == 400
    assert app_module.config['anime_settings'] == DEFAULT_SETTINGS


def test_settings_save_without_queueing_and_reload(client, app_module):
    settings = {**DEFAULT_SETTINGS, 'target_lang': 'fra', 'font_size': 62, 'mode': 'all'}
    assert client.post('/api/anime/settings', json=settings).status_code == 200
    app_module.config['anime_settings'] = {}
    app_module.load_config()
    assert client.get('/api/anime/settings').get_json()['settings'] == settings
    assert app_module.translation_queue.empty()
    assert client.post('/api/config', json={'anime_settings': {'font_size': -1}}).status_code == 400


def test_scopes_resolve_entire_show_and_season(client, insert_media):
    ids = []
    for season in (1, 2):
        for episode in (1, 2):
            ids.append(insert_media(filename=f'S{season}E{episode}.mkv', media_type='show',
                show_name='Test Show', folder_name=f'Season {season}', subtitle_tracks=tracks('spa'),
                season_episode=f'S{season:02d}E{episode:02d}'))
    insert_media(filename='other.mkv', media_type='show', show_name='Other Show', folder_name='Season 1')
    for kind, count in [('file', 1), ('season', 2), ('show', 4)]:
        response = client.post('/api/anime/plan', json={'scope': {'kind': kind, 'file_id': ids[0]}})
        assert response.status_code == 200
        assert len(response.get_json()['files']) == count


def test_target_reuses_existing_language_without_ai_and_snapshots_settings(client, insert_media, app_module):
    fid = insert_media(subtitle_tracks=tracks('eng', 'spa', 'fra'))
    payload = {'file_ids': [fid, fid], 'settings': {'font_size': 64}}
    response = client.post('/api/anime/queue', json=payload).get_json()
    assert response['count'] == 1
    assert response['files'][0]['needs_translation'] is False
    assert response['files'][0]['subtitles_removed'] == 1
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs').fetchone()
    assert job['job_type'] == 'anime'
    assert job['source_sub_idx'] == 1
    client.post('/api/anime/settings', json={'font_size': 32})
    assert json.loads(job['anime_settings'])['font_size'] == 64
    assert client.post('/api/anime/queue', json=payload).get_json()['count'] == 0


def test_missing_target_needs_ai_but_all_mode_does_not(client, insert_media, app_module):
    fid = insert_media(subtitle_tracks=tracks('eng'))
    target = client.post('/api/anime/plan', json={'file_ids': [fid]}).get_json()['files'][0]
    assert target['needs_translation'] and 'API key' in target['reason']
    all_mode = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'mode': 'all'}}).get_json()
    assert all_mode['count'] == 1
    assert not all_mode['files'][0]['needs_translation']


def test_planning_does_not_queue_and_reports_no_source_or_no_audio(client, insert_media, app_module):
    no_subs = insert_media(filename='no-subs.mkv', subtitle_tracks='[]')
    no_audio = insert_media(filename='french.mkv', audio_tracks=json.dumps([{'audio_idx': 0, 'lang': 'fra'}]), subtitle_tracks=tracks('spa'))
    result = client.post('/api/anime/plan', json={'file_ids': [no_subs, no_audio]}).get_json()
    assert 'No readable source' in result['files'][0]['reason']
    assert 'No audio would remain' in result['files'][1]['reason']
    assert app_module.translation_queue.empty()


def test_episode_sidecar_does_not_leak_into_adjacent_episode(client, insert_media, tmp_path):
    (tmp_path / 'Show.S01E01.spa.srt').write_text(SRT)
    fid = insert_media(filepath=str(tmp_path / 'Show.S01E02.mkv'), filename='Show.S01E02.mkv', media_type='show', subtitle_tracks='[]')
    result = client.post('/api/anime/plan', json={'file_ids': [fid]}).get_json()['files'][0]
    assert result['reason']
    (tmp_path / 'Show.S01E02.spa.srt').write_text(SRT)
    result = client.post('/api/anime/plan', json={'file_ids': [fid]}).get_json()['files'][0]
    assert result['reason'] is None


@pytest.fixture
def real_media(tmp_path, app_module, insert_media):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg/ffprobe not installed')
    sub = tmp_path / 'input.srt'
    sub.write_text(SRT, encoding='utf-8')
    video = tmp_path / 'anime.mkv'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10',
           '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-i', str(sub),
           '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '1:a',
           '-map', '2:0', '-map', '2:0', '-map', '2:0', '-t', '1',
           '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-c:s', 'srt',
           '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng',
           '-metadata:s:a:2', 'language=fra', '-metadata:s:s:0', 'language=eng',
           '-metadata:s:s:1', 'language=spa', '-metadata:s:s:2', 'language=fra', str(video)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=30)
    info = app_module.parse_media_info(str(video))
    fid = insert_media(filepath=str(video), filename=video.name, audio_tracks=info['audio_tracks'], subtitle_tracks=info['subtitle_tracks'])
    return fid, video


@pytest.mark.parametrize('mode', ['target', 'all'])
def test_real_ass_remux_filters_languages_without_translation(client, app_module, monkeypatch, real_media, mode):
    fid, video = real_media
    def no_translation(*args, **kwargs):
        raise AssertionError('AI must not run')
    monkeypatch.setattr(app_module, 'translate_subtitle_file', no_translation)
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'mode': mode}}).get_json()
    assert result['count'] == 1
    app_module.run_translation_job(result['queued'][0])
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (result['queued'][0],)).fetchone()
    assert job['status'] == 'done', job['error_text']
    _, audio, subs = app_module._streams_from_ffprobe(app_module.run_ffprobe(str(video)))
    assert [t['lang'] for t in audio] == ['jpn', 'eng']
    assert {t['lang'] for t in subs} == {'eng', 'spa'}
    assert len(subs) == 2
    assert sum(t['codec'] == 'ass' for t in subs) == (2 if mode == 'all' else 1)
    assert not list(video.parent.glob('.anime-*'))


def test_real_missing_target_translates_to_selected_language(client, app_module, monkeypatch, real_media):
    fid, video = real_media
    calls = []
    monkeypatch.setattr(app_module, '_translation_backend_ready', lambda: (True, ''))
    def translate(path, source_lang, **kwargs):
        calls.append((source_lang, kwargs['target_lang']))
        return Path(path).read_text(encoding='utf-8').replace('Hello', 'Ciao')
    monkeypatch.setattr(app_module, 'translate_subtitle_file', translate)
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'target_lang': 'ita'}}).get_json()
    app_module.run_translation_job(result['queued'][0])
    assert calls == [('eng', 'ita')]
    _, _, subs = app_module._streams_from_ffprobe(app_module.run_ffprobe(str(video)))
    assert any(s['lang'] == 'ita' and s['codec'] == 'ass' for s in subs)


def test_cancel_before_replacement_keeps_original(client, app_module, monkeypatch, real_media):
    fid, video = real_media
    original = video.read_bytes()
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    jid = result['queued'][0]
    real_probe = app_module.run_ffprobe
    def cancel_after_output(path):
        probe = real_probe(path)
        if str(path).endswith('output.tmp'):
            client.post(f'/api/translate/cancel/{jid}')
        return probe
    monkeypatch.setattr(app_module, 'run_ffprobe', cancel_after_output)
    app_module.run_translation_job(jid)
    assert video.read_bytes() == original
    assert client.get('/api/translate/jobs').get_json()['jobs'][0]['status'] == 'cancelled'


def test_unverifiable_remux_keeps_original(client, app_module, monkeypatch, real_media):
    fid, video = real_media
    original = video.read_bytes()
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    real_probe = app_module.run_ffprobe
    monkeypatch.setattr(app_module, 'run_ffprobe', lambda path: None if str(path).endswith('output.tmp') else real_probe(path))
    app_module.run_translation_job(result['queued'][0])
    assert video.read_bytes() == original
    assert client.get('/api/translate/jobs').get_json()['jobs'][0]['status'] == 'failed'


def test_restart_recovers_anime_job_with_saved_snapshot(client, app_module, insert_media):
    fid = insert_media(subtitle_tracks=tracks('spa'))
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'font_size': 64}}).get_json()
    jid = app_module.translation_queue.get_nowait()
    with app_module.db() as conn:
        conn.execute("UPDATE translation_jobs SET status='styling' WHERE id=?", (jid,))
    app_module._recover_queued_jobs()
    assert app_module.translation_queue.get_nowait() == result['queued'][0]
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (jid,)).fetchone()
    assert job['status'] == 'pending'
    assert json.loads(job['anime_settings'])['font_size'] == 64


@pytest.mark.parametrize('route', ['plan', 'queue', 'preview'])
def test_rejects_non_object_requests(client, route):
    assert client.post('/api/anime/' + route, json=[1]).status_code == 400


def test_preview_is_rendered_png(client):
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg not installed')
    response = client.post('/api/anime/preview', json={'settings': {}, 'text': '¡Hola!\n字幕のプレビュー'})
    assert response.status_code == 200, response.get_json(silent=True)
    assert response.mimetype == 'image/png'
    assert response.data.startswith(b'\x89PNG')


def test_anime_routes_require_authentication(raw_client):
    assert raw_client.get('/api/anime/settings').status_code == 401
    assert raw_client.post('/api/anime/queue', json={'file_ids': [1]}).status_code == 401


@pytest.mark.parametrize('extension', ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.m2ts', '.mts',
                                     '.mpg', '.mpeg', '.vob', '.webm', '.wmv', '.flv', '.3gp'])
def test_all_library_video_formats_can_be_planned(client, insert_media, extension):
    fid = insert_media(filename='sample' + extension, subtitle_tracks=tracks('spa'))
    plan = client.post('/api/anime/plan', json={'file_ids': [fid]}).get_json()['files'][0]
    assert plan['reason'] is None
    assert plan['output_filename'] == 'sample.mkv'
    assert plan['converts_container'] == (extension != '.mkv')


@pytest.fixture
def non_mkv_media(tmp_path, app_module, insert_media):
    def create(extension='.mp4', video_codec='libx264', audio_codec='aac', subtitle_codec='mov_text'):
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            pytest.skip('ffmpeg/ffprobe not installed')
        video = tmp_path / ('converted' + extension)
        sub = tmp_path / 'input.srt'
        sub.write_text(SRT, encoding='utf-8')
        cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25',
               '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
        if subtitle_codec:
            cmd += ['-i', str(sub)]
        cmd += ['-map', '0:v', '-map', '1:a', '-metadata:s:a:0', 'language=eng']
        if subtitle_codec:
            cmd += ['-map', '2:0', '-map', '2:0', '-map', '2:0', '-c:s', subtitle_codec,
                    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=spa',
                    '-metadata:s:s:2', 'language=fra']
        else:
            for lang in ('eng', 'spa'):
                video.with_suffix('.' + lang + '.srt').write_text(SRT, encoding='utf-8')
        cmd += ['-t', '1', '-c:v', video_codec, '-c:a', audio_codec]
        if audio_codec == 'wmav2':
            cmd += ['-ar', '44100']
        cmd += [str(video)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=30)
        info = app_module.parse_media_info(str(video))
        fid = insert_media(filepath=str(video), filename=video.name, audio_tracks=info['audio_tracks'],
                           subtitle_tracks=info['subtitle_tracks'], poster_url='/custom-poster.jpg',
                           encode_status='done')
        return fid, video
    return create


@pytest.mark.parametrize('extension,video_codec,audio_codec,subtitle_codec', [
    ('.mp4', 'libx264', 'aac', 'mov_text'),
    ('.mov', 'libx264', 'aac', 'mov_text'),
    ('.m4v', 'libx264', 'aac', 'mov_text'),
    ('.3gp', 'libx264', 'aac', 'mov_text'),
    ('.avi', 'mpeg4', 'mp3', None),
    ('.webm', 'libvpx-vp9', 'libopus', 'webvtt'),
    ('.flv', 'flv1', 'mp3', None),
    ('.wmv', 'wmv2', 'wmav2', None),
    ('.m2ts', 'mpeg2video', 'ac3', None),
    ('.mts', 'mpeg2video', 'ac3', None),
    ('.mpg', 'mpeg2video', 'mp2', None),
    ('.mpeg', 'mpeg2video', 'mp2', None),
    ('.vob', 'mpeg2video', 'ac3', None),
])
def test_real_container_conversion_keeps_identity_and_stream_copies(client, app_module, non_mkv_media,
                                                                  extension, video_codec, audio_codec, subtitle_codec):
    fid, video = non_mkv_media(extension, video_codec, audio_codec, subtitle_codec)
    old_probe = app_module.run_ffprobe(str(video))
    _, old_audio, _ = app_module._streams_from_ffprobe(old_probe)
    with app_module.db() as conn:
        conn.execute("INSERT INTO encode_jobs (media_file_id,filepath,status) VALUES (?,?,'done')", (fid, str(video)))
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {
        'mode': 'all', 'audio_languages': ['eng', 'und']}}).get_json()
    assert result['count'] == 1, result
    app_module.run_translation_job(result['queued'][0])
    job = client.get('/api/translate/jobs').get_json()['jobs'][0]
    assert job['status'] == 'done', job['error_text']
    destination = video.with_suffix('.mkv')
    assert destination.is_file() and not video.exists()
    new_probe = app_module.run_ffprobe(str(destination))
    new_video, new_audio, new_subs = app_module._streams_from_ffprobe(new_probe)
    assert new_video[0]['codec'] == next(s['codec_name'] for s in old_probe['streams'] if s['codec_type'] == 'video')
    assert [s['codec'] for s in new_audio] == [s['codec'] for s in old_audio]
    assert [(s['lang'], s['codec']) for s in new_subs] == [('eng', 'ass'), ('spa', 'ass')]
    with app_module.db() as conn:
        media = conn.execute('SELECT * FROM media_files WHERE id=?', (fid,)).fetchone()
        assert conn.execute('SELECT COUNT(*) FROM media_files').fetchone()[0] == 1
        assert conn.execute('SELECT filepath FROM processed_files').fetchone()['filepath'] == str(destination)
    assert media['filepath'] == job['filepath'] == str(destination)
    assert media['filename'] == destination.name
    assert media['poster_url'] == '/custom-poster.jpg'
    assert media['encode_status'] == 'done'
    assert 'matroska' in media['format_name']
    with app_module.db() as conn:
        assert conn.execute('SELECT filepath FROM encode_jobs WHERE media_file_id=?', (fid,)).fetchone()['filepath'] == str(destination)
    assert not list(video.parent.glob('.anime-*'))


def test_target_mode_converts_retained_mp4_subtitles_without_extra_translation(client, app_module, non_mkv_media, monkeypatch):
    fid, video = non_mkv_media()
    calls = []
    monkeypatch.setattr(app_module, '_translation_backend_ready', lambda: (True, ''))
    def translate(path, lang, **kwargs):
        calls.append((lang, kwargs['target_lang']))
        return Path(path).read_text(encoding='utf-8').replace('Hello', 'Ciao')
    monkeypatch.setattr(app_module, 'translate_subtitle_file', translate)
    result = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'target_lang': 'ita'}}).get_json()
    app_module.run_translation_job(result['queued'][0])
    assert calls == [('eng', 'ita')]
    _, _, subtitles = app_module._streams_from_ffprobe(app_module.run_ffprobe(str(video.with_suffix('.mkv'))))
    assert [(s['lang'], s['codec']) for s in subtitles] == [('ita', 'ass'), ('eng', 'ass'), ('spa', 'ass')]


def test_existing_destination_is_never_overwritten(client, insert_media, tmp_path):
    destination = tmp_path / 'movie.mkv'
    destination.write_bytes(b'existing media')
    fid = insert_media(filepath=str(tmp_path / 'movie.mp4'), filename='movie.mp4', subtitle_tracks=tracks('spa'))
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    assert result['count'] == 0
    assert 'already exists' in result['files'][0]['reason']
    assert destination.read_bytes() == b'existing media'


def test_destination_created_during_processing_is_never_overwritten(client, app_module, non_mkv_media, monkeypatch):
    fid, video = non_mkv_media()
    original = video.read_bytes()
    destination = video.with_suffix('.mkv')
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    real_probe = app_module.run_ffprobe
    def probe(path):
        data = real_probe(path)
        if str(path).endswith('output.tmp'):
            destination.write_bytes(b'created after planning')
        return data
    monkeypatch.setattr(app_module, 'run_ffprobe', probe)
    app_module.run_translation_job(result['queued'][0])
    assert video.read_bytes() == original
    assert destination.read_bytes() == b'created after planning'
    assert client.get('/api/translate/jobs').get_json()['jobs'][0]['status'] == 'failed'


def test_cancel_container_conversion_keeps_original_and_does_not_publish(client, app_module, non_mkv_media, monkeypatch):
    fid, video = non_mkv_media()
    original = video.read_bytes()
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    real_probe = app_module.run_ffprobe
    def probe(path):
        data = real_probe(path)
        if str(path).endswith('output.tmp'):
            client.post(f'/api/translate/cancel/{result["queued"][0]}')
        return data
    monkeypatch.setattr(app_module, 'run_ffprobe', probe)
    app_module.run_translation_job(result['queued'][0])
    assert video.read_bytes() == original
    assert not video.with_suffix('.mkv').exists()
    assert client.get('/api/translate/jobs').get_json()['jobs'][0]['status'] == 'cancelled'


def test_registry_failure_rolls_back_new_output_and_keeps_original(client, app_module, non_mkv_media):
    fid, video = non_mkv_media()
    original = video.read_bytes()
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    with app_module.db() as conn:
        conn.execute("CREATE TRIGGER reject_new_path BEFORE UPDATE OF filepath ON media_files BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    app_module.run_translation_job(result['queued'][0])
    assert video.read_bytes() == original
    assert not video.with_suffix('.mkv').exists()
    with app_module.db() as conn:
        assert conn.execute('SELECT filepath FROM media_files WHERE id=?', (fid,)).fetchone()['filepath'] == str(video)
    assert client.get('/api/translate/jobs').get_json()['jobs'][0]['status'] == 'failed'


def test_source_cleanup_failure_preserves_both_files_and_reports_warning(client, app_module, non_mkv_media, monkeypatch):
    fid, video = non_mkv_media()
    original = video.read_bytes()
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    real_remove = app_module.os.remove
    def remove(path, *args, **kwargs):
        if str(path) == str(video):
            raise PermissionError('Source is in use')
        return real_remove(path, *args, **kwargs)
    monkeypatch.setattr(app_module.os, 'remove', remove)
    app_module.run_translation_job(result['queued'][0])
    assert video.read_bytes() == original
    assert video.with_suffix('.mkv').is_file()
    job = client.get('/api/translate/jobs').get_json()['jobs'][0]
    assert job['status'] == 'done'
    assert 'original retained' in job['progress_detail']


def test_duplicate_output_names_are_reported_before_queueing(client, insert_media, tmp_path):
    ids = [insert_media(filepath=str(tmp_path / ('movie' + ext)), filename='movie' + ext, subtitle_tracks=tracks('spa'))
           for ext in ('.mp4', '.avi')]
    for route in ('plan', 'queue'):
        result = client.post('/api/anime/' + route, json={'file_ids': ids}).get_json()
        assert result['files'][0]['reason'] is None
        assert result['files'][1]['reason']
    assert result['count'] == 1
