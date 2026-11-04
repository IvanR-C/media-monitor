from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


def test_restore_srt_structure_preserves_numbers_and_timestamps(app_module):
    source = """1
00:56:33,974 --> 00:56:35,183
...fondue?

2
00:56:36,143 --> 00:56:38,395
This is your transponder.
Activate it when you're ready"""

    translated = """99
00:56:33,974 --> 01:56:35,183
...fondue?

100
02:00:00,000 --> 02:00:01,000
Este es tu transpondedor.
Actívalo cuando estés listo"""

    repaired = app_module.restore_srt_structure(source, translated)

    assert repaired == """1
00:56:33,974 --> 00:56:35,183
...fondue?

2
00:56:36,143 --> 00:56:38,395
Este es tu transpondedor.
Actívalo cuando estés listo"""


def test_restore_srt_structure_rejects_changed_block_count(app_module):
    source = """1
00:00:01,000 --> 00:00:02,000
One

2
00:00:03,000 --> 00:00:04,000
Two"""

    translated = """1
00:00:01,000 --> 00:00:02,000
Uno"""

    with pytest.raises(ValueError, match="block count changed"):
        app_module.restore_srt_structure(source, translated)


SOURCE = ('7\n00:00:01,000 --> 00:00:02,000\n<i>Hello.</i>\nAgain.\n\n'
          '19\n00:00:03,000 --> 00:00:04,000\nAre you ready?')
PAIRS = [[1, '<i>Hola.</i>\nOtra vez.'], [2, '¿Ya puedes empezar?']]


@pytest.fixture
def translator(app_module, monkeypatch):
    """Exercise the real translation/cache path without making paid API calls."""
    calls = []
    state = SimpleNamespace(reply=json.dumps(PAIRS), finish_reason='stop', fail_on=None)

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) == state.fail_on:
            raise RuntimeError('Connection interrupted')
        return SimpleNamespace(
            choices=[SimpleNamespace(
                message=SimpleNamespace(content=state.reply), finish_reason=state.finish_reason)],
            usage=SimpleNamespace(prompt_tokens=100, completion_tokens=30),
        )

    def client_and_model(settings=None):
        settings = settings or app_module.config
        local = settings['translate_backend'] == 'local_ai'
        return SimpleNamespace(
            base_url=settings['local_ai_base_url'] if local else 'https://api.openai.com/v1/',
            chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
        ), settings['local_ai_model' if local else 'openai_model']

    app_module.config['openai_api_key'] = 'test-key'
    app_module.config['translation_target_lang'] = 'spa'
    monkeypatch.setattr(app_module, '_translation_client_and_model', client_and_model)
    return calls, state


@pytest.mark.parametrize('backend', ['openai', 'local_ai'])
def test_dialogue_only_request_preserves_source_structure(app_module, translator, backend):
    calls, state = translator
    app_module.config.update(translate_backend=backend, local_ai_base_url='http://local/v1',
                             local_ai_model='local-model')
    # Response order must not determine which cue gets which text.
    state.reply = '```json\n' + json.dumps(list(reversed(PAIRS))) + '\n```'
    result = app_module.translate_srt_chunk(SOURCE, 'eng')
    assert result == ('7\n00:00:01,000 --> 00:00:02,000\n<i>Hola.</i>\nOtra vez.\n\n'
                      '19\n00:00:03,000 --> 00:00:04,000\n¿Ya puedes empezar?')
    request = calls[0]
    prompt = request['messages'][1]['content']
    assert json.loads(prompt.split('\n', 1)[1]) == [
        [1, '<i>Hello.</i>\nAgain.'], [2, 'Are you ready?']]
    assert '-->' not in prompt
    assert '00:00:' not in prompt
    assert 'Target language: Spanish' in request['messages'][0]['content']
    assert 'Cuban' not in request['messages'][0]['content']
    if backend == 'openai':
        assert 'response_format' not in request
    else:
        schema = request['response_format']['json_schema']['schema']
        assert schema['minItems'] == schema['maxItems'] == 2


@pytest.mark.parametrize('backend', ['openai', 'local_ai'])
@pytest.mark.parametrize('source,reply,expected', [
    # Seen from qwen2.5:7b in production: each pair JSON-encoded as a string.
    (SOURCE, json.dumps([json.dumps(p, ensure_ascii=False) for p in PAIRS], ensure_ascii=False),
     '¿Ya puedes empezar?'),
    # Seen from qwen2.5:7b in production: a single cue answered as a bare pair.
    ('1\n00:00:01,000 --> 00:00:02,000\nHello', '[1,"Hola"]', 'Hola'),
])
def test_common_local_model_shapes_are_repaired(app_module, translator, backend, source, reply, expected):
    calls, state = translator
    app_module.config.update(translate_backend=backend, local_ai_base_url='http://local/v1',
                             local_ai_model='local-model')
    state.reply = reply
    assert expected in app_module.translate_srt_chunk(source)
    assert app_module.translate_srt_chunk(source) == app_module.translate_srt_chunk(source)
    assert len(calls) == 1  # The repaired pairs were cached in the canonical shape.


def test_local_server_without_structured_output_falls_back_to_plain(app_module, monkeypatch):
    import httpx
    from openai import OpenAI

    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if 'response_format' in body:
            return httpx.Response(400, json={'error': {'message': 'unknown field response_format'}})
        return httpx.Response(200, json={
            'id': 'test', 'object': 'chat.completion', 'created': 0, 'model': body['model'],
            'choices': [{'index': 0, 'finish_reason': 'stop',
                         'message': {'role': 'assistant', 'content': json.dumps(PAIRS)}}],
        })

    app_module.config.update(translate_backend='local_ai', local_ai_base_url='http://local/v1',
                             local_ai_model='local-model', translation_target_lang='spa',
                             translation_cache_enabled=False)
    with OpenAI(api_key='ollama', base_url='http://local/v1', max_retries=0,
                http_client=httpx.Client(transport=httpx.MockTransport(respond))) as sdk:
        monkeypatch.setattr(app_module, '_translation_client_and_model',
                            lambda settings=None: (sdk, 'local-model'))
        assert '¿Ya puedes empezar?' in app_module.translate_srt_chunk(SOURCE)
        assert '¿Ya puedes empezar?' in app_module.translate_srt_chunk(SOURCE)
    # Rejected once, then remembered: later chunks skip straight to plain requests.
    assert ['response_format' in r for r in requests] == [True, False, False]


def test_local_server_errors_other_than_rejection_still_fail(app_module, translator):
    calls, state = translator
    app_module.config.update(translate_backend='local_ai', local_ai_base_url='http://local/v1',
                             local_ai_model='local-model')
    state.fail_on = 1
    with pytest.raises(RuntimeError, match='interrupted'):
        app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 1


@pytest.mark.parametrize('reply', [
    'not JSON', '{}', '[[1,"Hola"]]',
    '[[1,"Hola"],[1,"Otra"]]', '[[1,"Hola"],[3,"Otra"]]',
    '[[true,"Hola"],[2,"Otra"]]', '[["1","Hola"],[2,"Otra"]]',
    '[[1,"Hola"],[2,42]]', '[[1,"Hola"],[2,""]]',
    '[[1,"Hola"],[2,"a\\n\\nb"]]',
    '[[1,"Hola"],[2,"00:00:03,000 --> 00:00:04,000"]]',
    '[[1,"Hola","extra"],[2,"Otra"]]',
])
def test_invalid_translation_is_never_cached(app_module, translator, reply):
    _calls, state = translator
    state.reply = reply
    with pytest.raises(ValueError):
        app_module.translate_srt_chunk(SOURCE)
    with app_module.db() as conn:
        assert conn.execute('SELECT count(*) FROM subtitle_translation_cache').fetchone()[0] == 0


@pytest.mark.parametrize('reason,reply', [('length', '[[1,"Hola"],[2,"Otra"]]'),
                                         ('content_filter', None), ('stop', None)])
def test_incomplete_or_empty_response_is_not_cached(app_module, translator, reason, reply):
    _calls, state = translator
    state.finish_reason, state.reply = reason, reply
    with pytest.raises(ValueError):
        app_module.translate_srt_chunk(SOURCE)
    with app_module.db() as conn:
        assert conn.execute('SELECT count(*) FROM subtitle_translation_cache').fetchone()[0] == 0


def test_interrupted_file_reuses_completed_chunks_after_restart(app_module, translator, tmp_path, monkeypatch):
    calls, state = translator
    path = tmp_path / 'episode.srt'
    path.write_text(SOURCE, encoding='utf-8')
    app_module.config['openai_chunk_size'] = 1
    state.reply, state.fail_on = '[[1,"Hola"]]', 2
    with pytest.raises(RuntimeError, match='interrupted'):
        app_module.translate_subtitle_file(path, 'eng', job_id=10)
    # Reopening the persistent database, and a new job/temp path, must retain progress.
    app_module.init_db()
    moved_path = tmp_path / 'reextracted.srt'
    moved_path.write_text(SOURCE, encoding='utf-8')
    state.fail_on, state.reply = None, '[[1,"¿Ya puedes empezar?"]]'
    result = app_module.translate_subtitle_file(moved_path, 'eng', job_id=11)
    assert len(calls) == 3
    assert '7\n00:00:01,000 --> 00:00:02,000\nHola' in result
    assert '19\n00:00:03,000 --> 00:00:04,000\n¿Ya puedes empezar?' in result
    assert app_module.translate_subtitle_file(path, 'eng') == result
    assert len(calls) == 3


@pytest.mark.parametrize('change', ['model', 'prompt', 'temperature', 'backend', 'endpoint',
                                   'source_lang', 'target_lang', 'source', 'chunk_size'])
def test_cache_invalidates_when_translation_inputs_change(app_module, translator, tmp_path, monkeypatch, change):
    calls, state = translator
    path = tmp_path / 'episode.srt'
    path.write_text(SOURCE, encoding='utf-8')
    app_module.config.update(local_ai_base_url='http://local/v1', local_ai_model='local-model')
    if change == 'endpoint':
        app_module.config['translate_backend'] = 'local_ai'
    app_module.translate_subtitle_file(path, 'eng')
    source_lang, target_lang = 'eng', None
    if change == 'model':
        app_module.config['openai_model'] = 'different-model'
    elif change == 'prompt':
        monkeypatch.setattr(app_module, '_SRT_SYSTEM_PROMPT', app_module._SRT_SYSTEM_PROMPT + '\nNew rule.')
    elif change == 'temperature':
        app_module.config['translation_temperature'] = 0.2
    elif change == 'backend':
        app_module.config['translate_backend'] = 'local_ai'
    elif change == 'endpoint':
        app_module.config['local_ai_base_url'] = 'http://different/v1'
    elif change == 'source_lang':
        source_lang = 'jpn'
    elif change == 'target_lang':
        target_lang = 'fra'
    elif change == 'source':
        path.write_text(SOURCE.replace('Again.', 'Once more.'), encoding='utf-8')
    elif change == 'chunk_size':
        app_module.config['openai_chunk_size'] = 349
    app_module.translate_subtitle_file(path, source_lang, target_lang=target_lang)
    assert len(calls) == 2
    if change == 'target_lang':
        system_prompt = calls[-1]['messages'][0]['content']
        assert 'Cuban' not in system_prompt
        assert 'French' in system_prompt


def test_changes_outside_a_chunk_invalidate_its_cache(app_module, translator, tmp_path):
    calls, state = translator
    path = tmp_path / 'episode.srt'
    app_module.config['openai_chunk_size'] = 1
    state.reply = '[[1,"Hola"]]'
    path.write_text(SOURCE, encoding='utf-8')
    app_module.translate_subtitle_file(path)
    path.write_text(SOURCE.replace('Are you ready?', 'Is she ready?'), encoding='utf-8')
    app_module.translate_subtitle_file(path)
    assert len(calls) == 4  # First cue unchanged; its surrounding file context changed.


@pytest.mark.parametrize('bad_cache', ['not JSON', '[[1,"Wrong cue count"]]'])
def test_corrupt_cache_is_retranslated(app_module, translator, bad_cache):
    calls, _state = translator
    expected = app_module.translate_srt_chunk(SOURCE)
    with app_module.db() as conn:
        conn.execute('UPDATE subtitle_translation_cache SET dialogue=?', (bad_cache,))
    assert app_module.translate_srt_chunk(SOURCE) == expected
    assert len(calls) == 2


def test_expired_cache_is_retranslated_and_pruned(app_module, translator):
    calls, _state = translator
    app_module.translate_srt_chunk(SOURCE)
    with app_module.db() as conn:
        conn.execute('UPDATE subtitle_translation_cache SET created_at=0')
        conn.execute("INSERT INTO subtitle_translation_cache VALUES ('old','[]',0)")
    app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 2
    with app_module.db() as conn:
        assert conn.execute('SELECT count(*) FROM subtitle_translation_cache').fetchone()[0] == 1


def test_unavailable_cache_does_not_break_translation(app_module, translator):
    calls, _state = translator
    with app_module.db() as conn:
        conn.execute('DROP TABLE subtitle_translation_cache')
    assert 'Hola' in app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 1


def test_anime_translation_keeps_repeated_cue_timing(app_module, translator, tmp_path):
    calls, state = translator
    state.reply = '[[1,"Hola"],[2,"Letrero"]]'
    source = ('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n'
              '2\n00:00:01,000 --> 00:00:02,000\nSign\n\n'
              '3\n00:00:02,000 --> 00:00:03,000\nHello')
    path = tmp_path / 'anime.srt'
    path.write_text(source, encoding='utf-8')
    result = app_module.translate_anime_subtitle_file(path, 'eng', layouts=[{'cue_id': i} for i in (1, 2, 3)])
    assert result.count('Hola') == 2
    assert '3\n00:00:02,000 --> 00:00:03,000\nHola' in result
    assert len(calls) == 1
    prompt = calls[0]['messages'][1]['content']
    assert json.loads(prompt.split('\n', 1)[1]) == [[1, 'Hello'], [2, 'Sign']]


def test_real_sdk_roundtrip_with_mock_transport(app_module, monkeypatch):
    import httpx
    from openai import OpenAI

    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        assert json.loads(body['messages'][1]['content'].split('\n', 1)[1])[1] == [2, 'Are you ready?']
        return httpx.Response(200, json={
            'id': 'test', 'object': 'chat.completion', 'created': 0, 'model': body['model'],
            'choices': [{'index': 0, 'finish_reason': 'stop',
                         'message': {'role': 'assistant', 'content': json.dumps(PAIRS)}}],
        })

    app_module.config['openai_api_key'] = 'test-key'
    app_module.config['translation_target_lang'] = 'spa'
    with OpenAI(api_key='test-key', http_client=httpx.Client(transport=httpx.MockTransport(respond))) as sdk:
        monkeypatch.setattr(app_module, '_translation_client_and_model', lambda settings=None: (sdk, 'test-model'))
        result = app_module.translate_srt_chunk(SOURCE)
        assert '¿Ya puedes empezar?' in result
        assert app_module.translate_srt_chunk(SOURCE) == result
    assert len(requests) == 1


def test_style_temperature_and_local_thinking_reach_request(app_module, translator):
    calls, _state = translator
    app_module.config.update(translate_backend='local_ai', local_ai_base_url='http://local/v1',
        local_ai_model='qwen3:14b', local_ai_thinking='none', translation_temperature=0,
        translation_variant='Cuban', translation_instructions='Keep the name Aurora unchanged.')
    app_module.translate_srt_chunk(SOURCE)
    request = calls[0]
    assert request['temperature'] == 0
    assert request['reasoning_effort'] == 'none'
    assert 'Regional style or dialect: Cuban' in request['messages'][0]['content']
    assert 'Aurora' in request['messages'][0]['content']
    app_module.config['local_ai_thinking'] = 'low'
    app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 2
    assert calls[-1]['reasoning_effort'] == 'low'


def test_thinking_defaults_and_openai_do_not_send_local_controls(app_module, translator):
    calls, _state = translator
    app_module.config['local_ai_thinking'] = 'none'
    app_module.translate_srt_chunk(SOURCE)
    assert 'reasoning_effort' not in calls[0]
    app_module.config.update(translate_backend='local_ai', local_ai_base_url='http://local/v1',
                             local_ai_model='model', local_ai_thinking='default')
    app_module.translate_srt_chunk(SOURCE)
    assert 'reasoning_effort' not in calls[-1]


@pytest.mark.parametrize('field,value', [('translation_variant', 'Canadian'),
                                        ('translation_instructions', 'Preserve names.')])
def test_style_changes_invalidate_cache(app_module, translator, field, value):
    calls, _state = translator
    app_module.translate_srt_chunk(SOURCE)
    app_module.config[field] = value
    app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 2


def test_cache_can_be_disabled_and_cleared(client, app_module, translator):
    calls, _state = translator
    app_module.translate_srt_chunk(SOURCE)
    app_module.config['translation_cache_enabled'] = False
    app_module.translate_srt_chunk(SOURCE)
    app_module.translate_srt_chunk(SOURCE)
    assert len(calls) == 3
    assert client.post('/api/translate/cache/clear').get_json() == {'deleted': 1}
    with app_module.db() as conn:
        assert conn.execute('SELECT count(*) FROM subtitle_translation_cache').fetchone()[0] == 0


def test_entire_file_keeps_same_preferences_during_config_changes(app_module, translator, tmp_path):
    calls, state = translator
    path = tmp_path / 'episode.srt'
    path.write_text(SOURCE, encoding='utf-8')
    app_module.config['openai_chunk_size'] = 1
    state.reply = '[[1,"Hola"]]'

    def change_preferences(pct, detail):
        app_module.config.update(translation_target_lang='fra', translation_variant='Canadian',
                                 translation_temperature=1.5, openai_model='changed-model')

    app_module.translate_subtitle_file(path, progress_cb=change_preferences)
    assert len(calls) == 2
    for call in calls:
        assert call['model'] != 'changed-model'
        assert call['temperature'] == 0.3
        assert 'Target language: Spanish' in call['messages'][0]['content']
        assert 'Canadian' not in call['messages'][0]['content']

