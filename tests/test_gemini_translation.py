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
    # Gemini honours the tuple schema; without it Flash-Lite sometimes quoted IDs or broke JSON.
    schema = sent['body']['response_format']['json_schema']['schema']
    assert schema['minItems'] == schema['maxItems'] == 2
    assert schema['items']['prefixItems'] == [{'type': 'integer'}, {'type': 'string'}]


def test_gemini_model_without_json_mode_falls_back_to_plain(app_module, gemini):
    app_module.config['gemini_model'] = 'gemma-4-31b-it'
    gemini['responses'] = [
        httpx.Response(400, json=[{'error': {'code': 400, 'message': 'JSON mode is not enabled for this model'}}]),
        None, None,
    ]
    assert '¿Ya puedes empezar?' in app_module.translate_srt_chunk(SOURCE)
    assert '¿Ya puedes empezar?' in app_module.translate_srt_chunk(SOURCE)
    # Rejected once, then remembered for this model.
    assert ['response_format' in r['body'] for r in gemini['requests']] == [True, False, False]


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


def _model(name, display, methods=('generateContent', 'countTokens')):
    return {'name': f'models/{name}', 'displayName': display, 'inputTokenLimit': 1048576,
            'outputTokenLimit': 65536, 'supportedGenerationMethods': list(methods), 'thinking': True}


NATIVE_MODELS = {'models': [
    _model('gemini-3.8-flash', 'Gemini 3.8 Flash'),
    _model('gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS'),
    _model('gemini-embedding-2', 'Gemini Embedding 2', ('embedContent',)),
    _model('gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite'),
    _model('gemini-future-flash', 'Gemini Future Flash'),
    _model('gemini-4-argon', 'Gemini 4 Argon'),
    _model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'),
    _model('gemma-4-31b-it', 'Gemma 4 31B IT'),
]}


@pytest.fixture
def native_models(app_module, monkeypatch):
    seen = {}

    def fake_get(url, headers=None, params=None, timeout=None):
        seen.update(url=url, auth=headers['x-goog-api-key'])
        return _Reply(200, NATIVE_MODELS)

    monkeypatch.setattr(app_module.requests, 'get', fake_get)
    return seen


def test_model_list_merges_prices_and_free_limits(client, app_module, native_models):
    assert client.get('/api/gemini/models').status_code == 400  # No key saved yet.
    app_module.config['gemini_api_key'] = 'k'
    data = client.get('/api/gemini/models').get_json()
    assert native_models == {'url': 'https://generativelanguage.googleapis.com/v1beta/models', 'auth': 'k'}
    assert data['as_of']
    # Text models only, in recommended order, models without known figures last.
    assert [m['id'] for m in data['models']] == [
        'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-future-flash']
    lite = data['models'][0]
    assert lite == {'id': 'gemini-3.5-flash-lite', 'name': 'Gemini 3.5 Flash Lite', 'input_tokens': 1048576,
                    'output_tokens': 65536, 'thinking': True, 'known': True,
                    'free': {'rpm': 15, 'tpm': 250000, 'rpd': 500},
                    'price': {'input': 0.30, 'output': 2.50}, 'note': ''}
    argon, unknown = data['models'][3:]
    assert argon['free'] is None and argon['price'] == {'input': 2.0, 'output': 10.0} and 'doubles' in argon['note']
    assert unknown['known'] is False and unknown['free'] is None and unknown['price'] is None


def test_key_check_lists_text_models(client, app_module, native_models):
    assert client.post('/api/test/gemini').status_code == 400  # No key saved yet.
    app_module.config.update(gemini_api_key='k', gemini_model='gemini-3.5-flash-lite')
    data = client.post('/api/test/gemini').get_json()
    assert data['status'] == 'success' and 'Key works' in data['message']
    assert 'gemini-3.5-flash-lite' in [m['id'] for m in data['models']]
    app_module.config['gemini_model'] = 'gemini-old'
    assert 'not available' in client.post('/api/test/gemini').get_json()['message']


def test_key_check_reports_rejected_key(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.requests, 'get', lambda *a, **k: _Reply(400))
    app_module.config['gemini_api_key'] = 'bad'
    response = client.post('/api/test/gemini')
    assert response.status_code == 400
    assert 'rejected the API key' in response.get_json()['message']
    assert 'rejected the API key' in client.get('/api/gemini/models').get_json()['error']
