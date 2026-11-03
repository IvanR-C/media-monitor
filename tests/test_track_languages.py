"""Track language editing must round-trip aliases, unknowns, and non-default languages."""
import json

import pytest


@pytest.mark.parametrize('source,expected', [('ger', 'deu'), ('fre', 'fra'), ('dut', 'nld'),
    ('chi', 'zho'), ('cze', 'ces'), ('nl', 'nld'), ('und', ''), ('pol', 'pol'), ('tam', 'tam')])
def test_language_normalization(app_module, source, expected):
    assert app_module.normalize_lang(source) == expected


def tracks():
    return [dict(audio_idx=0, codec='aac', lang='eng'), dict(audio_idx=1, codec='aac', lang='dut')], [dict(sub_idx=0, codec='srt', lang='pol')]


def test_assignments_round_trip_unknown_and_alias_languages(client, app_module, insert_media, monkeypatch):
    audio, subtitles = tracks()
    file_id = insert_media(audio_tracks=json.dumps(audio), subtitle_tracks=json.dumps(subtitles))
    monkeypatch.setattr(app_module, 'queue_remux_job', lambda *args: 123)
    response = client.post(f'/api/media/{file_id}/assign-tracks', json={
        'audio': [{'audio_idx': 0, 'lang': '', 'action': 'keep'}, {'audio_idx': 1, 'lang': 'dut', 'action': 'drop'}],
        'subtitles': [{'sub_idx': 0, 'lang': 'tam', 'action': 'keep'}],
    })
    assert response.status_code == 200
    body = response.get_json()
    assert body['remux_job_id'] == 123
    assert body['audio_tracks'][0]['lang'] == ''
    assert body['audio_tracks'][1]['lang'] == 'nld'
    assert body['audio_tracks'][1]['action'] == 'drop'
    assert body['subtitle_tracks'][0]['lang'] == 'tam'
    assert 'REMUX' in body['new_status']
    persisted = client.get('/api/media').get_json()['files'][0]
    assert persisted['audio_tracks'][0]['lang'] == ''
    assert persisted['subtitle_tracks'][0]['lang'] == 'tam'


def test_remux_clears_copied_language_metadata_and_reindexes_kept_tracks(app_module):
    audio, subtitles = tracks()
    audio[0]['action'] = 'drop'
    audio[1]['lang'] = ''
    subtitles[0]['lang'] = 'ger'
    command = app_module.build_remux_cmd('/demo/input.mkv', '/demo/output.mkv', audio, subtitles)
    assert '0:a:0' not in command
    assert '0:a:1' in command
    index = command.index('-metadata:s:a:0')
    assert command[index + 1] == 'language=und'
    index = command.index('-metadata:s:s:0')
    assert command[index + 1] == 'language=deu'
    assert command[command.index('-c') + 1] == 'copy'


def test_undetermined_tracks_are_flagged_for_language_assignment(app_module):
    status = app_module.determine_status(1024, [{'lang': 'und'}], [{'lang': 'eng'}, {'lang': 'spa'}])
    assert 'REMUX' in status
