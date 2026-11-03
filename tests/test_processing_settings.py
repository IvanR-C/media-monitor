"""Configurable processing: retention, encoding, outputs, notifications, rules."""
import json
import os
from pathlib import Path

import pytest

import processing as proc


def plan(app_module, audio, subs=(), disc=False, **settings):
    resolved = {**proc.job_settings(app_module.config), **settings}
    return app_module.track_plan(list(audio), list(subs), resolved, disc=disc)


A = lambda idx, lang, codec='ac3', **kw: {'audio_idx': idx, 'lang': lang, 'codec': codec, 'channels': kw.pop('channels', 2), **kw}
S = lambda idx, lang, **kw: {'sub_idx': idx, 'lang': lang, 'codec': 'subrip', **kw}


# ── Required subtitles ───────────────────────────────────────────────────────
def test_empty_required_subtitles_means_none_and_survives_reload(client, app_module, insert_media):
    fid = insert_media(subtitle_tracks=json.dumps([]))
    assert client.post('/api/config', json={'required_sub_langs': []}).status_code == 200
    app_module.config['required_sub_langs'] = ['eng']
    app_module.load_config()
    assert app_module.config['required_sub_langs'] == []
    assert app_module.determine_status(1, [], []) == 'OK'
    detail = client.get(f'/api/media/{fid}').get_json()
    assert detail['required_subtitle_langs'] == [] and detail['missing_subtitle_langs'] == []


def test_missing_required_subtitle_setting_uses_default(app_module):
    app_module.config['required_sub_langs'] = None
    assert app_module.required_sub_langs() == {'eng', 'spa'}
    assert 'MISSING LANG' in app_module.determine_status(1, [], [S(0, 'eng')])


# ── Language retention and audio selection ───────────────────────────────────
def test_default_rules_match_previous_behavior(app_module):
    audio = [A(0, 'eng', 'ac3'), A(1, 'eng', 'truehd'), A(2, 'fra'), A(3, 'jpn', 'aac')]
    result = plan(app_module, audio, [S(0, 'eng'), S(1, 'fra'), S(2, '')])
    assert [t['audio_idx'] for t in result['audio']] == [1, 3]
    assert [t['sub_idx'] for t in result['subtitles']] == [0]
    assert plan(app_module, [A(0, 'fra'), A(1, 'deu')])['audio'] == [A(0, 'fra'), A(1, 'deu')]


def test_keep_lists_keep_all_and_untagged(app_module):
    audio = [A(0, 'eng'), A(1, ''), A(2, 'kor')]
    subs = [S(0, 'kor'), S(1, ''), S(2, 'eng')]
    r = plan(app_module, audio, subs, keep_audio_langs=['kor'], keep_sub_langs=['kor'])
    assert [t['audio_idx'] for t in r['audio']] == [2] and [t['sub_idx'] for t in r['subtitles']] == [0]
    r = plan(app_module, audio, subs, keep_untagged_audio=True, keep_untagged_subs=True)
    assert [t['audio_idx'] for t in r['audio']] == [0, 1] and [t['sub_idx'] for t in r['subtitles']] == [1, 2]
    r = plan(app_module, audio, subs, keep_all_audio_langs=True, keep_all_sub_langs=True)
    assert len(r['audio']) == 3 and len(r['subtitles']) == 3
    # An empty subtitle list keeps no subtitles; an empty audio list falls back.
    r = plan(app_module, audio, subs, keep_audio_langs=[], keep_sub_langs=[])
    assert len(r['audio']) == 3 and r['subtitles'] == []
    r = plan(app_module, audio, subs, keep_audio_langs=[], audio_fallback='first')
    assert [t['audio_idx'] for t in r['audio']] == [0]
    assert 'No preferred language' in r['decisions'][0]['reason']


def test_selection_modes_codec_order_channels_and_commentary(app_module):
    audio = [A(0, 'eng', 'ac3', channels=6), A(1, 'eng', 'aac', channels=2),
             A(2, 'eng', 'ac3', channels=8), A(3, 'eng', 'truehd', title='Director Commentary')]
    assert [t['audio_idx'] for t in plan(app_module, audio)['audio']] == [2]
    assert [t['audio_idx'] for t in plan(app_module, audio, audio_codec_order=['aac', 'ac3'])['audio']] == [1]
    assert [t['audio_idx'] for t in plan(app_module, audio, audio_selection='all')['audio']] == [0, 1, 2]
    assert [t['audio_idx'] for t in plan(app_module, audio, commentary_audio='keep')['audio']] == [3]
    only_commentary = [A(0, 'eng', title='Commentary')]
    assert plan(app_module, only_commentary)['audio'] == only_commentary  # never silent


def test_explicit_editor_choices_override_rules(client, app_module, insert_media):
    fid = insert_media(audio_tracks=json.dumps([A(0, 'eng'), A(1, 'fra')]),
                       subtitle_tracks=json.dumps([S(0, 'eng'), S(1, 'fra')]))
    client.post(f'/api/media/{fid}/assign-tracks', json={
        'audio': [{'audio_idx': 0, 'lang': 'eng', 'action': 'drop'}, {'audio_idx': 1, 'lang': 'fra', 'action': 'keep'}],
        'subtitles': [{'sub_idx': 1, 'lang': 'fra', 'action': 'keep'}]})
    with app_module.db() as conn:
        row = conn.execute('SELECT * FROM media_files WHERE id=?', (fid,)).fetchone()
    audio = json.loads(row['audio_tracks'])
    assert audio[0]['action_user'] and 'action_user' not in audio[1]
    result = plan(app_module, audio, json.loads(row['subtitle_tracks']))
    # French audio was never explicitly kept, so the rules' fallback keeps it.
    assert [t['audio_idx'] for t in result['audio']] == [1]
    assert [t['sub_idx'] for t in result['subtitles']] == [0]


def test_disc_recommendations_follow_rules_until_user_changes_them(client, app_module, insert_media):
    audio = [A(0, 'eng'), A(1, 'kor')]
    for t in audio:
        t.update(action='keep' if t['lang'] == 'eng' else 'drop', action_auto=True)
    fid = insert_media(filename='disc.iso', audio_tracks=json.dumps(audio), subtitle_tracks='[]')
    with app_module.db() as conn:
        conn.execute("UPDATE media_files SET disc_type='bluray' WHERE id=?", (fid,))
    assert client.post('/api/config', json={'keep_audio_langs': ['kor']}).status_code == 200
    with app_module.db() as conn:
        stored = json.loads(conn.execute('SELECT audio_tracks FROM media_files WHERE id=?', (fid,)).fetchone()[0])
    assert [t['action'] for t in stored] == ['drop', 'keep']
    preview = client.get(f'/api/media/{fid}').get_json()['encoding_preview']
    assert [t['audio_idx'] for t in preview['audio_tracks']] == [1]


# ── Encoding profiles and encoders ───────────────────────────────────────────
ROW = dict(audio_tracks=json.dumps([A(0, 'eng')]), subtitle_tracks=json.dumps([S(0, 'eng')]),
           video_height=2160, duration_seconds=3600, video_codec='h264', video_bitrate=40_000_000, disc_type=None)


def test_default_encode_command_is_unchanged(app_module):
    cmd = app_module.build_ffmpeg_cmd('in.mkv', 'out.tmp', ROW)
    joined = ' '.join(cmd)
    assert '-c:v hevc_nvenc -preset:v p4 -cq:v 20 -profile:v main10 -rc-lookahead 20 -vf scale=-2:1080' in joined
    assert '-disposition' not in joined


def test_profiles_resolution_and_other_encoders(app_module):
    app_module.config.update(encode_profile='quality', encode_preset='p6', encode_max_height=0, encode_10bit=False)
    joined = ' '.join(app_module.build_ffmpeg_cmd('in.mkv', 'out.tmp', ROW))
    assert '-preset:v p6 -cq:v 18 -profile:v main' in joined and 'scale' not in joined
    app_module.config.update(video_encoder='libx265', encode_profile='custom', encode_quality=23, encode_max_height=720)
    joined = ' '.join(app_module.build_ffmpeg_cmd('in.mkv', 'out.tmp', ROW))
    assert '-c:v libx265 -preset slow -crf 23 -pix_fmt yuv420p -vf scale=-2:720' in joined
    app_module.config.update(video_encoder='hevc_qsv', encode_profile='balanced', encode_10bit=True)
    assert '-global_quality 23 -pix_fmt p010le' in ' '.join(app_module.build_ffmpeg_cmd('in.mkv', 'out.tmp', ROW))


def test_rip_uses_same_profile(app_module):
    app_module.config.update(encode_profile='compact', encode_max_height=0)
    cmd = ' '.join(app_module.build_rip_cmd({**ROW, 'disc_type': 'bluray', 'filepath': 'x.iso'}, 'out.tmp', '.'))
    assert '-cq:v 24' in cmd and 'scale' not in cmd


def test_estimate_reflects_profile_and_resolution(app_module):
    base = app_module.estimate_output_size(ROW)
    app_module.config['encode_profile'] = 'compact'
    smaller = app_module.estimate_output_size(ROW)
    app_module.config.update(encode_profile='balanced', encode_max_height=0)
    preserved = app_module.estimate_output_size(ROW)
    assert smaller < base < preserved


def test_default_audio_language_sets_dispositions(app_module):
    row = {**ROW, 'audio_tracks': json.dumps([A(0, 'eng'), A(1, 'jpn')])}
    app_module.config['default_audio_lang'] = 'jpn'
    joined = ' '.join(app_module.build_ffmpeg_cmd('in.mkv', 'out.tmp', row))
    assert '-disposition:a:0 0 -disposition:a:1 default' in joined


def test_queued_job_keeps_settings_snapshot(client, app_module, insert_media):
    fid = insert_media()
    job_id = client.post('/api/encode/queue', json={'file_id': fid}).get_json()['queued'][0]
    app_module.config.update(encode_profile='compact', video_encoder='libx264')
    with app_module.db() as conn:
        job = conn.execute('SELECT * FROM encode_jobs WHERE id=?', (job_id,)).fetchone()
    settings = app_module.job_snapshot(job)
    assert settings['encode_profile'] == 'balanced' and settings['video_encoder'] == 'hevc_nvenc'


def test_encoder_detection_and_unavailable_encoder_blocks_queue(client, app_module, insert_media, monkeypatch):
    class Done:
        def __init__(self, rc=0, out='', err=''):
            self.returncode, self.stdout, self.stderr = rc, out, err

    def run(cmd, **kwargs):
        if cmd[-1] == '-encoders':
            return Done(out=' V....D hevc_nvenc  NVIDIA\n V....D libx265  x265\n')
        return Done(rc=0 if 'libx265' in cmd else 1, err='No capable devices found')

    monkeypatch.setattr(app_module.subprocess, 'run', run)
    encoders = client.get('/api/encoders?refresh=1').get_json()['encoders']
    assert encoders['libx265']['available'] and not encoders['hevc_nvenc']['available']
    assert 'No capable devices found' in encoders['hevc_nvenc']['reason']
    assert encoders['av1_qsv']['reason'] == 'Not included in this ffmpeg build.'
    response = client.post('/api/encode/queue', json={'file_id': insert_media()})
    assert response.status_code == 409 and 'Settings → Encoding' in response.get_json()['error']


# ── Output files and backups ─────────────────────────────────────────────────
def test_replace_with_backup_and_retention(app_module, tmp_path):
    source, tmp = tmp_path / 'Movie.mkv', tmp_path / 'Movie.mkv.encoding.tmp'
    source.write_bytes(b'original')
    tmp.write_bytes(b'encoded')
    settings = {**proc.job_settings(app_module.config), 'backup_originals': True}
    assert app_module.place_output(str(tmp), str(source), settings, 'encode') == (str(source), False)
    assert source.read_bytes() == b'encoded' and (tmp_path / 'Movie.mkv.bak').read_bytes() == b'original'
    unrelated = tmp_path / 'Other.mkv.bak'
    unrelated.write_bytes(b'not ours')
    with app_module.db() as conn:
        conn.execute('UPDATE file_backups SET created_at=0')
    assert app_module.purge_expired_backups() == (1, 8)
    assert not (tmp_path / 'Movie.mkv.bak').exists() and unrelated.exists()


def test_separate_output_never_overwrites(app_module, tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, 'WATCH_DIR', str(tmp_path))
    source = tmp_path / 'Show' / 'Ep.mkv'
    source.parent.mkdir()
    source.write_bytes(b'original')
    (source.parent / 'Ep.encoded.mkv').write_bytes(b'someone else')
    settings = {**proc.job_settings(app_module.config), 'output_policy': 'separate'}
    for n in (2, 3):
        tmp = tmp_path / 'x.tmp'
        tmp.write_bytes(b'new')
        destination, separate = app_module.place_output(str(tmp), str(source), settings, 'encode')
        assert separate and Path(destination).name == f'Ep.encoded ({n}).mkv'
    assert source.read_bytes() == b'original' and (source.parent / 'Ep.encoded.mkv').read_bytes() == b'someone else'
    settings.update(output_dir='Encoded', output_suffix='')
    tmp.write_bytes(b'new')
    destination, _ = app_module.place_output(str(tmp), str(source), settings, 'encode')
    assert Path(destination) == tmp_path / 'Encoded' / 'Show' / 'Ep.mkv'


@pytest.mark.parametrize('payload', [
    {'output_policy': 'separate', 'output_suffix': '', 'output_dir': ''},
    {'output_dir': '/somewhere/else'}, {'output_dir': '../outside'}, {'output_suffix': 'a/b'},
    {'keep_audio_langs': ['zzz']}, {'keep_sub_langs': 'eng'}, {'audio_fallback': 'none'},
    {'video_encoder': 'magic'}, {'encode_quality': 52, 'encode_profile': 'custom'},
    {'encode_max_height': 1000}, {'encode_lookahead': 40}, {'backup_retention_days': -1},
    {'ntfy_events': ['bogus']}, {'ntfy_priorities': {'job_failed': 'loud'}},
    {'stabilize_interval': 0}, {'stabilize_checks': 31}, {'stabilize_interval': True},
    {'translation_cache_days': 0}, {'local_ai_timeout': 10}, {'ocr_fallback_lang': ''},
    {'movie_roots': ['Media'], 'show_roots': ['media']}, {'excluded_folders': ['../x']},
])
def test_invalid_processing_settings_are_atomic(client, app_module, payload):
    before = json.dumps(app_module.config, sort_keys=True)
    response = client.post('/api/config', json={**payload, 'openai_model': 'must-not-save'})
    assert response.status_code == 400, payload
    assert json.dumps(app_module.config, sort_keys=True) == before


def test_processing_settings_persist(client, app_module):
    payload = {'keep_audio_langs': ['ja', 'en'], 'audio_selection': 'all', 'encode_profile': 'quality',
               'encode_max_height': 0, 'output_policy': 'separate', 'output_dir': 'Encoded',
               'ntfy_priorities': {'job_failed': 'urgent'}, 'stabilize_interval': 5, 'excluded_folders': ['Extras/']}
    assert client.post('/api/config', json=payload).status_code == 200
    app_module.config.update(keep_audio_langs=[], encode_profile='balanced')
    app_module.load_config()
    assert app_module.config['keep_audio_langs'] == ['eng', 'jpn']
    assert app_module.config['ntfy_priorities']['job_failed'] == 'urgent'
    assert app_module.config['ntfy_priorities']['new_media'] == 'default'
    assert app_module.config['excluded_folders'] == ['Extras']


# ── Notifications ────────────────────────────────────────────────────────────
def test_events_and_priorities_per_provider(app_module, monkeypatch):
    sent = []
    monkeypatch.setattr(app_module, 'send_ntfy_notification',
                        lambda title, message, **kw: sent.append(('ntfy', title, kw['priority'])) or (True, ''))
    monkeypatch.setattr(app_module, 'send_discord_embed', lambda embed: sent.append(('discord', embed['title'])) or (True, ''))
    app_module.config.update(ntfy_events=['attention', 'new_media', 'job_failed'], discord_events=['new_media'],
                             ntfy_priorities={**app_module.config['ntfy_priorities'], 'attention': 'urgent'})
    app_module.notify(['attention', 'new_media'], 'Flagged', 'body')
    app_module.notify('job_complete', 'Done', 'body')
    app_module.notify('job_failed', 'Failed', 'body')
    assert sent == [('ntfy', 'Flagged', 'urgent'), ('discord', 'Flagged'), ('ntfy', 'Failed', 'high')]


def test_notification_tests_report_saved_configuration(client, app_module, monkeypatch):
    app_module.config.update(enable_ntfy=False, enable_discord=True, discord_webhook='https://discord.test/hook')
    assert client.post('/api/test/ntfy').status_code == 400

    class Reply:
        status_code = 404

    monkeypatch.setattr(app_module.requests, 'post', lambda *a, **kw: Reply())
    response = client.post('/api/test/discord')
    assert response.status_code == 400 and 'HTTP 404' in response.get_json()['error']


# ── File detection timing ────────────────────────────────────────────────────
def test_files_still_copying_are_not_stable(app_module, monkeypatch, tmp_path):
    sizes = iter([1, 2, 3, 3, 3, 3])
    checks = []

    class Stat:
        def __init__(self, size):
            self.st_size, self.st_mtime_ns = size, size

    monkeypatch.setattr(app_module.os, 'stat', lambda path: Stat(next(sizes)))
    monkeypatch.setattr(app_module.time, 'sleep', lambda seconds: checks.append(seconds))
    app_module.config.update(stabilize_interval=7, stabilize_checks=3)
    assert app_module.wait_for_stable_file('copying.mkv')
    assert checks == [7, 7, 7, 7, 7]  # three growth checks, then three unchanged


def test_stability_edits_apply_to_waits_in_progress(app_module, monkeypatch):
    class Stat:
        st_size = st_mtime_ns = 1

    def sleep(seconds):
        app_module.config['stabilize_checks'] = 1

    monkeypatch.setattr(app_module.os, 'stat', lambda path: Stat())
    monkeypatch.setattr(app_module.time, 'sleep', sleep)
    app_module.config['stabilize_checks'] = 30
    assert app_module.wait_for_stable_file('x.mkv')


# ── Translation and OCR ──────────────────────────────────────────────────────
def test_cache_retention_and_local_timeout(app_module):
    app_module.config['translation_cache_days'] = 2
    assert app_module.translation_cache_ttl() == 2 * 86400
    settings = {**app_module.config, 'translate_backend': 'local_ai', 'local_ai_base_url': 'http://x/v1',
                'local_ai_model': 'm', 'local_ai_timeout': 1200}
    client, _ = app_module._translation_client_and_model(settings)
    assert client.timeout == 1200


def test_ocr_language_override_and_fallback(client, app_module, insert_media):
    assert app_module.ocr_language('') == 'eng'
    assert app_module.ocr_language('zz') == 'eng'
    app_module.config['ocr_fallback_lang'] = 'jpn'
    assert app_module.ocr_language('und') == 'jpn'
    assert app_module.ocr_language('fra', override='spa') == 'spa'
    fid = insert_media(subtitle_tracks=json.dumps([{'sub_idx': 0, 'lang': '', 'codec': 'hdmv_pgs_subtitle'}]))
    bad = client.post(f'/api/media/{fid}/subtitle/0/extract', json={'ocr_lang': 'tlh'})
    assert bad.status_code == 400
    job_id = client.post(f'/api/media/{fid}/subtitle/0/extract', json={'ocr_lang': 'de'}).get_json()['job_id']
    with app_module.db() as conn:
        job = conn.execute('SELECT ocr_lang, processing_settings FROM translation_jobs WHERE id=?', (job_id,)).fetchone()
    assert job['ocr_lang'] == 'deu' and json.loads(job['processing_settings'])['ocr_fallback_lang'] == 'jpn'


# ── Library rules ────────────────────────────────────────────────────────────
def test_explicit_roots_and_exclusions(client, app_module, insert_media, monkeypatch, tmp_path):
    watch = Path(app_module.WATCH_DIR)
    app_module.config.update(show_roots=['Kids/Cartoons'], movie_roots=['Kids'])
    assert app_module.detect_media_type(str(watch / 'Kids' / 'Cartoons' / 'Bluey' / 'S01E01.mkv'))[:2] == ('show', 'Bluey')
    assert app_module.detect_media_type(str(watch / 'Kids' / 'Film S01E01.mkv'))[0] == 'movie'
    assert app_module.detect_media_type(str(watch / 'shows' / 'X' / 'a.mkv'))[0] == 'show'  # heuristics still apply
    moved = insert_media(filepath=str(watch / 'Kids' / 'Cartoons' / 'Bluey' / 'S01E02.mkv'), media_type='movie')
    extra = insert_media(filepath=str(watch / 'Movies' / 'A' / 'Extras' / 'b.mkv'))
    kept = insert_media(filepath=str(watch / 'Movies' / 'A' / 'a.mkv'))
    assert client.post('/api/config', json={'excluded_folders': ['extras']}).status_code == 200
    with app_module.db() as conn:
        rows = {r['id']: r for r in conn.execute('SELECT id, media_type, show_name FROM media_files')}
    assert extra not in rows and kept in rows
    assert (rows[moved]['media_type'], rows[moved]['show_name']) == ('show', 'Bluey')
    assert app_module.is_excluded_media_path(str(watch / 'TV' / 'EXTRAS' / 'x.mkv'))
    app_module.config['excluded_folders'] = ['TV/*/Specials']
    assert app_module.is_excluded_media_path(str(watch / 'TV' / 'Show' / 'Specials' / 'x.mkv'))
    assert not app_module.is_excluded_media_path(str(watch / 'Specials' / 'x.mkv'))
