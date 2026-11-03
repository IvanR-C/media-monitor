"""Translation settings, queue snapshots, and language metadata contracts."""
import json
import shutil
import subprocess

import pytest


def test_fresh_install_has_no_translation_language_or_dialect(client, app_module):
    settings = client.get('/api/config').get_json()
    assert settings['translation_target_lang'] == ''
    assert settings['translation_variant'] == ''
    assert settings['translation_instructions'] == ''
    assert client.get('/api/anime/settings').get_json()['settings']['target_lang'] == ''
    with pytest.raises(ValueError, match='Choose a target language'):
        app_module.translate_srt_chunk('1\n00:00:01,000 --> 00:00:02,000\nHello')


@pytest.mark.parametrize('payload', [
    {'translation_target_lang': 'xxx'}, {'translation_target_lang': 'mul'},
    {'translation_target_lang': None}, {'translation_target_lang': []},
    {'translation_temperature': -1}, {'translation_temperature': 2.1},
    {'translation_temperature': float('nan')}, {'translation_temperature': float('inf')},
    {'translation_temperature': True}, {'translation_temperature': '0.3'},
    {'translation_variant': 'x' * 121}, {'translation_variant': None},
    {'translation_instructions': 'x' * 4001}, {'translation_instructions': []},
    {'translation_instructions': 'bad\x00text'}, {'local_ai_thinking': 'magic'},
    {'local_ai_thinking': []}, {'translation_cache_enabled': 'false'},
])
def test_invalid_translation_settings_are_atomic(client, app_module, payload):
    before = dict(app_module.config)
    response = client.post('/api/config', json={**payload, 'openai_model': 'must-not-save'})
    assert response.status_code == 400
    assert app_module.config == before


def test_preferences_persist_and_normalize_language(client, app_module):
    payload = dict(translation_target_lang='fr', translation_variant=' Canadian ',
        translation_instructions=' Preserve names. ', translation_temperature=0,
        local_ai_thinking='none', translation_cache_enabled=False)
    assert client.post('/api/config', json=payload).status_code == 200
    app_module.config.update(translation_target_lang='', translation_variant='')
    app_module.load_config()
    assert app_module.config['translation_target_lang'] == 'fra'
    assert app_module.config['translation_variant'] == 'Canadian'
    assert app_module.config['translation_instructions'] == 'Preserve names.'
    assert app_module.config['translation_temperature'] == 0
    assert app_module.config['local_ai_thinking'] == 'none'
    assert app_module.config['translation_cache_enabled'] is False
    assert client.get('/api/anime/settings').get_json()['settings']['target_lang'] == 'fra'
    assert client.post('/api/config', json={'translation_target_lang': ''}).status_code == 200


def test_queue_requires_language_and_snapshots_preferences(client, app_module, insert_media):
    fid = insert_media(subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    app_module.config['openai_api_key'] = 'secret-do-not-store'
    url = f'/api/media/{fid}/translate-subtitle'
    response = client.post(url, json={'sub_idx': 0})
    assert response.status_code == 400
    assert 'Choose a target language' in response.get_json()['error']
    client.post('/api/config', json={'translation_target_lang': 'fra', 'translation_variant': 'Canadian',
                                   'translation_temperature': 0.1})
    response = client.post(url, json={'sub_idx': 0})
    assert response.status_code == 200
    client.post('/api/config', json={'translation_target_lang': 'deu', 'openai_model': 'new-model'})
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs').fetchone()
    snapshot = json.loads(job['translation_settings'])
    assert job['target_lang'] == 'fra'
    assert snapshot['translation_variant'] == 'Canadian'
    assert snapshot['translation_temperature'] == 0.1
    assert snapshot['openai_model'] != 'new-model'
    assert 'secret-do-not-store' not in job['translation_settings']


def test_anime_target_requires_choice_but_conversion_does_not(client, insert_media):
    fid = insert_media(subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    plan = client.post('/api/anime/plan', json={'file_ids': [fid]}).get_json()['files'][0]
    assert 'Choose a target' in plan['reason']
    response = client.post('/api/anime/queue', json={'file_ids': [fid], 'settings': {'mode': 'all'}})
    assert response.status_code == 200
    assert response.get_json()['count'] == 1


def test_anime_planning_uses_saved_provider_readiness(app_module, insert_media):
    fid = insert_media(subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    app_module.config.update(translate_backend='local_ai', local_ai_base_url='http://local/v1', local_ai_model='model')
    preferences = app_module.translation_settings('fra')
    settings = app_module.anime_preferences({'target_lang': 'fra'})
    app_module.config.update(translate_backend='openai', openai_api_key='')
    with app_module.db() as conn:
        media = conn.execute('SELECT * FROM media_files WHERE id=?', (fid,)).fetchone()
    assert app_module.anime_file_plan(media, settings, preferences)['reason'] is None
    assert 'API key' in app_module.anime_file_plan(media, settings)['reason']


def test_existing_target_sidecar_is_preserved(client, app_module, insert_media, tmp_path):
    video = tmp_path / 'sample.mkv'
    sidecar = tmp_path / 'sample.fra.srt'
    sidecar.write_text('Existing subtitles', encoding='utf-8')
    fid = insert_media(filepath=str(video), filename=video.name,
        subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    app_module.config.update(openai_api_key='test-key', translation_target_lang='fra')
    response = client.post(f'/api/media/{fid}/translate-subtitle', json={'sub_idx': 0})
    job_id = response.get_json()['job_id']
    app_module.run_translation_job(job_id)
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (job_id,)).fetchone()
    assert job['status'] == 'failed'
    assert 'already exists' in job['error_text']
    assert sidecar.read_text(encoding='utf-8') == 'Existing subtitles'


def test_local_connection_returns_available_model_names(client, app_module, monkeypatch):
    class Reply:
        def raise_for_status(self):
            pass

        def json(self):
            return {'data': [{'id': 'model-a'}, {'id': 'model-b'}]}

    monkeypatch.setattr(app_module.requests, 'get', lambda *args, **kwargs: Reply())
    response = client.post('/api/test/local-ai', json={'local_ai_base_url': 'http://local/v1', 'local_ai_model': 'model-a'})
    assert response.get_json()['models'] == ['model-a', 'model-b']


def test_real_translation_job_tags_selected_language(client, app_module, insert_media, monkeypatch, tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg/ffprobe unavailable')
    source = tmp_path / 'source.srt'
    source.write_text('1\n00:00:00,100 --> 00:00:00,900\nHello world!\n', encoding='utf-8')
    video = tmp_path / 'sample.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=160x90:d=1',
        '-i', str(source), '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'srt',
        '-metadata:s:s:0', 'language=eng', str(video)], check=True, capture_output=True)
    fid = insert_media(filepath=str(video), filename=video.name,
        subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    app_module.config.update(openai_api_key='test-key', translation_target_lang='fra', translation_variant='Canadian')
    response = client.post(f'/api/media/{fid}/translate-subtitle', json={'sub_idx': 0})
    job_id = response.get_json()['job_id']
    captured = []

    def translate(path, source_lang, **kwargs):
        captured.append((path, kwargs))
        return source.read_text(encoding='utf-8').replace('Hello world!', 'Bonjour le monde !')

    monkeypatch.setattr(app_module, 'translate_subtitle_file', translate)
    app_module.config.update(translation_target_lang='deu', translation_variant='')
    app_module.run_translation_job(job_id)
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (job_id,)).fetchone()
    assert job['status'] == 'done', job['error_text']
    assert captured[0][1]['target_lang'] == 'fra'
    assert captured[0][1]['settings']['translation_variant'] == 'Canadian'
    subtitles = [s for s in app_module.run_ffprobe(str(video))['streams'] if s['codec_type'] == 'subtitle']
    assert [s['tags']['language'] for s in subtitles] == ['eng', 'fra']
    assert subtitles[-1]['tags']['title'] == 'French (Canadian)'
    assert not (tmp_path / 'sample.fra.srt').exists()  # Removed after successful mux.
