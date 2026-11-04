"""Gemini translation backend: request shape, pacing, quota handling, settings and key test."""
from __future__ import annotations

import json

import httpx
import pytest

SOURCE = ('7\n00:00:01,000 --> 00:00:02,000\n<i>Hello.</i>\nAgain.\n\n'
          '19\n00:00:03,000 --> 00:00:04,000\nAre you ready?')
PAIRS = [[1, '<i>Hola.</i>\nOtra vez.'], [2, '¿Ya puedes empezar?']]


def _completion(body, content=None, finish_reason='stop'):
    return httpx.Response(200, json={
        'id': 'test', 'object': 'chat.completion', 'created': 0, 'model': body['model'],
        'choices': [{'index': 0, 'finish_reason': finish_reason,
                     'message': {'role': 'assistant', 'content': content or json.dumps(PAIRS)}}],
    })


def _rate_limited(message):
    return httpx.Response(429, json=[{'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'message': message}}])


@pytest.fixture
def gemini(app_module, monkeypatch):
    """Route the real Gemini client through a mock transport; record requests and sleeps."""
    from openai import OpenAI

    state = {'requests': [], 'sleeps': [], 'responses': []}

    def respond(request):
        body = json.loads(request.content)
        state['requests'].append({'url': str(request.url), 'auth': request.headers['authorization'], 'body': body})
        reply = state['responses'].pop(0) if state['responses'] else None
        return reply(body) if callable(reply) else reply or _completion(body)

    real = app_module._translation_client_and_model

    def client_and_model(settings=None):
        client, model = real(settings)
        # Keep the real base URL and key; only swap the transport. No SDK retries,
        # so each mock response maps to exactly one attempt of our own loop.
        return OpenAI(api_key=client.api_key, base_url=client.base_url, max_retries=0,
                      http_client=httpx.Client(transport=httpx.MockTransport(respond))), model

    monkeypatch.setattr(app_module, '_translation_client_and_model', client_and_model)
    monkeypatch.setattr(app_module.time, 'sleep', state['sleeps'].append)
    app_module.config.update(translate_backend='gemini', gemini_api_key='test-gemini-key',
                             translation_target_lang='spa', translation_cache_enabled=False)
    return state


def test_gemini_request_uses_openai_compatible_endpoint(app_module, gemini):
    app_module.config['gemini_thinking'] = 'minimal'
    result = app_module.translate_srt_chunk(SOURCE, 'eng')
    assert '¿Ya puedes empezar?' in result and '00:00:03,000 --> 00:00:04,000' in result
    sent = gemini['requests'][0]
    assert sent['url'] == 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    assert sent['auth'] == 'Bearer test-gemini-key'
    assert sent['body']['model'] == 'gemini-3.5-flash-lite'
    assert sent['body']['reasoning_effort'] == 'minimal'
    # Gemini's schema subset lacks tuple arrays; the prompt alone defines the shape.
    assert 'response_format' not in sent['body']


def test_gemini_default_thinking_sends_no_reasoning_control(app_module, gemini):
    app_module.translate_srt_chunk(SOURCE)
    assert 'reasoning_effort' not in gemini['requests'][0]['body']


def test_per_minute_limit_waits_for_requested_delay_then_succeeds(app_module, gemini):
    gemini['responses'] = [
        lambda _body: _rate_limited('Quota exceeded for metric GenerateRequestsPerMinutePerProjectPerModel-FreeTier. '
                                    'Please retry in 17.2s.'),
        None,
    ]
    assert '¿Ya puedes empezar?' in app_module.translate_srt_chunk(SOURCE)
    assert len(gemini['requests']) == 2
    assert 18.2 in gemini['sleeps']


def test_daily_quota_fails_fast_with_clear_message(app_module, gemini):
    gemini['responses'] = [lambda _body: _rate_limited(
        'Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 500')]
    with pytest.raises(ValueError, match='daily quota.*midnight Pacific'):
        app_module.translate_srt_chunk(SOURCE)
    assert len(gemini['requests']) == 1


def test_persistent_rate_limit_gives_up_after_retries(app_module, gemini):
    gemini['responses'] = [lambda _body: _rate_limited('Resource exhausted')] * 10
    with pytest.raises(ValueError, match='Requests per minute'):
        app_module.translate_srt_chunk(SOURCE)
    assert len(gemini['requests']) == app_module._GEMINI_RATE_LIMIT_RETRIES + 1


def test_safety_block_is_reported(app_module, gemini):
    gemini['responses'] = [lambda body: _completion(body, finish_reason='content_filter')]
    with pytest.raises(ValueError, match='safety filter'):
        app_module.translate_srt_chunk(SOURCE)


def test_requests_are_spaced_to_the_per_minute_budget(app_module, monkeypatch):
    clock = {'now': 1000.0}
    sleeps = []
    monkeypatch.setattr(app_module.time, 'monotonic', lambda: clock['now'])
    monkeypatch.setattr(app_module.time, 'sleep', sleeps.append)
    app_module.config['gemini_requests_per_minute'] = 15
    for _ in range(3):
        app_module._pace_gemini_request()
    assert sleeps == [4.0, 8.0]
    clock['now'] += 60  # Idle long enough: the next request goes straight out.
    app_module._pace_gemini_request()
    assert sleeps == [4.0, 8.0]


def test_file_uses_gemini_chunk_size(app_module, gemini, tmp_path):
    blocks = [f'{i}\n00:00:{i:02d},000 --> 00:00:{i:02d},500\nLine {i}' for i in range(1, 6)]
    srt = tmp_path / 'in.srt'
    srt.write_text('\n\n'.join(blocks), encoding='utf-8')
    app_module.config['gemini_chunk_size'] = 2
    gemini['responses'] = [
        lambda body: _completion(body, json.dumps([[i, f'Línea {i}'] for i in range(1, len(
            json.loads(body['messages'][1]['content'].split('\n', 1)[1])) + 1)]))
    ] * 3
    result = app_module.translate_subtitle_file(str(srt))
    assert len(gemini['requests']) == 3
    assert result.count('Línea') == 5


def test_readiness_requires_key_and_model(app_module):
    app_module.config.update(translate_backend='gemini', gemini_api_key='')
    assert 'Gemini API key' in app_module._translation_backend_ready()[1]
    app_module.config.update(gemini_api_key='k', gemini_model='')
    assert 'Gemini model' in app_module._translation_backend_ready()[1]
    app_module.config['gemini_model'] = 'gemini-3.5-flash-lite'
    assert app_module._translation_backend_ready() == (True, None)


def test_config_accepts_gemini_settings_and_rejects_bad_values(client, app_module):
    ok = client.post('/api/config', json={
        'translate_backend': 'gemini', 'gemini_api_key': ' key ', 'gemini_model': 'gemini-3.1-flash-lite',
        'gemini_chunk_size': 300, 'gemini_requests_per_minute': 10, 'gemini_thinking': 'low'})
    assert ok.status_code == 200
    assert app_module.config['gemini_api_key'] == 'key'
    for bad in ({'translate_backend': 'agy'}, {'gemini_chunk_size': 0}, {'gemini_chunk_size': 1001},
                {'gemini_requests_per_minute': True}, {'gemini_thinking': 'none'}, {'gemini_model': 5}):
        assert client.post('/api/config', json=bad).status_code == 400, bad


def test_job_snapshot_never_stores_gemini_key(client, app_module, insert_media):
    fid = insert_media(subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': 'eng', 'codec': 'subrip'}]))
    client.post('/api/config', json={'translate_backend': 'gemini', 'gemini_api_key': 'secret-gemini-key',
                                     'translation_target_lang': 'fra'})
    assert client.post(f'/api/media/{fid}/translate-subtitle', json={'sub_idx': 0}).status_code == 200
    with app_module.db() as conn:
        snapshot = conn.execute('SELECT translation_settings FROM translation_jobs').fetchone()[0]
    assert json.loads(snapshot)['translate_backend'] == 'gemini'
    assert 'secret-gemini-key' not in snapshot


class _Reply:
    def __init__(self, status, payload=None):
        self.status_code, self._payload = status, payload or {}
        self.ok = status < 400

    def json(self):
        return self._payload


def test_key_check_lists_text_models(client, app_module, monkeypatch):
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen.update(url=url, auth=headers['Authorization'])
        return _Reply(200, {'data': [{'id': 'models/gemini-3.5-flash-lite'}, {'id': 'models/gemini-3.8-flash-tts'},
                                     {'id': 'models/gemini-embedding-2'}, {'id': 'models/gemma-4-31b-it'}]})

    monkeypatch.setattr(app_module.requests, 'get', fake_get)
    assert client.post('/api/test/gemini').status_code == 400  # No key saved yet.
    app_module.config.update(gemini_api_key='k', gemini_model='gemini-3.5-flash-lite')
    data = client.post('/api/test/gemini').get_json()
    assert seen == {'url': 'https://generativelanguage.googleapis.com/v1beta/openai/models', 'auth': 'Bearer k'}
    assert data['status'] == 'success'
    assert data['models'] == ['gemini-3.5-flash-lite', 'gemma-4-31b-it']
    app_module.config['gemini_model'] = 'gemini-old'
    assert 'not available' in client.post('/api/test/gemini').get_json()['message']


def test_key_check_reports_rejected_key(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.requests, 'get', lambda *a, **k: _Reply(400))
    app_module.config['gemini_api_key'] = 'bad'
    response = client.post('/api/test/gemini')
    assert response.status_code == 400
    assert 'rejected the API key' in response.get_json()['message']
