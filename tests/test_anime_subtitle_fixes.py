"""Fix Anime: ASS escapes, clean-up, sidecar language and timing against the audio.

Covers what Attack on Titan Seasons 1–4 turned up: SRT `\\h`/`\\n` codes shown as
full-width text, cues outlasting the video, duplicate and stray-script lines,
Spanish `.hi.srt` sidecars that were never used, and sidecars that were early,
or written for another episode, with no embedded track to check them against.
"""
import json
import random
import shutil
import struct
import subprocess
import wave

import pytest

from anime_subtitles import (AUDIO_MISMATCH_CONFIDENCE, DEFAULT_SETTINGS, SUBTITLE_LEAD_IN, audio_offset,
                             guess_subtitle_language, remove_stray_script, restyle_ass, speech_envelope,
                             srt_cues, srt_to_ass)

pytestmark = pytest.mark.usefixtures('spanish_anime_preferences')

RATE = 8000
SECONDS = 125


def dialogue(seed, count=40):
    """Lines of 0.8–2.6 s in runs, with a few longer pauses, like an episode."""
    rng = random.Random(seed)
    cues, t = [], 2.0
    for _ in range(count):
        length = rng.uniform(0.8, 2.6)
        cues.append((round(t, 2), round(t + length, 2)))
        t += length + (rng.uniform(3, 7) if rng.random() < 0.2 else rng.uniform(0.15, 0.9))
    return cues


CUES = dialogue(1)      # ends at 115.8 s
OTHER = dialogue(2)     # another episode: same density, different rhythm
SPANISH = 'Que no es lo que se dice de la vida'


def fmt(t):
    ms = round(t * 1000)
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


def srt(cues, offset=0.0, text='Línea'):
    return '\n\n'.join(f'{i + 1}\n{fmt(s + offset)} --> {fmt(e + offset)}\n{text} {i}'
                       for i, (s, e) in enumerate(cues)) + '\n'


def speech_pcm(cues, seconds=SECONDS):
    """Loud noise while someone talks, a quiet bed otherwise. Voices start a
    moment after the subtitle appears, as on real releases."""
    rng = random.Random(7)
    loud = [0] * (seconds * RATE)
    for s, e in cues:
        for i in range(int((s + SUBTITLE_LEAD_IN) * RATE), min(len(loud), int((e + SUBTITLE_LEAD_IN) * RATE))):
            loud[i] = 1
    samples = [int(rng.gauss(0, 6000 if on else 250)) for on in loud]
    return struct.pack(f'<{len(samples)}h', *(max(-32768, min(32767, v)) for v in samples))


# ── ASS conversion ───────────────────────────────────────────────────────────
def test_srt_ass_escapes_stay_real_and_other_backslashes_stay_literal():
    ass = srt_to_ass('1\n00:00:01,000 --> 00:00:05,000\n'
                     '\\h\\h\\hInformación pública\\nRifles antititanes\\NC:\\carpeta\n', DEFAULT_SETTINGS)
    assert r',\h\h\hInformación pública\NRifles antititanes\NC:＼carpeta' in ass
    assert '＼h' not in ass and '＼n' not in ass


def test_restyle_repairs_full_width_escapes_from_earlier_versions():
    broken = srt_to_ass('1\n00:00:01,000 --> 00:00:02,000\nX\n', DEFAULT_SETTINGS).replace(
        ',X', ',＼h＼hInformación＼nRifles＼NFin')
    assert r',\h\hInformación\NRifles\NFin' in restyle_ass(broken, DEFAULT_SETTINGS)


def test_cues_are_clipped_to_the_video_and_exact_duplicates_dropped():
    content = ('1\n00:00:01,000 --> 00:00:02,000\nHola\n\n2\n00:00:01,000 --> 00:00:02,000\nHola\n\n'
               '3\n00:00:01,000 --> 00:00:02,000\nAdiós\n\n'
               '4\n00:23:58,000 --> 00:24:03,500\nFin\n\n5\n00:24:01,000 --> 00:24:04,000\nTarde\n')
    ass = srt_to_ass(content, DEFAULT_SETTINGS, end_limit=1440.4)
    dialogue = [line for line in ass.splitlines() if line.startswith('Dialogue:')]
    assert [line.split(',', 9)[9] for line in dialogue] == ['Hola', 'Adiós', 'Fin']
    assert dialogue[-1].split(',')[2] == '0:24:00.40'
    restyled = restyle_ass(ass, DEFAULT_SETTINGS, offset=1.0, end_limit=1440.4)
    assert restyled.count('Dialogue:') == 3 and ',0:23:59.00,0:24:00.40,' in restyled


# ── Translation and sidecar clean-up ─────────────────────────────────────────
def test_stray_script_from_the_model_is_removed_but_source_names_survive():
    lines = [('We are the hunters.', 'Somos los cazadores.')] * 60 + [
        ('Go, Levi!', '¡Vamos, Levi পির!'), ('Mikasa (ミカサ) is here.', 'Mikasa (ミカサ) está aquí পির.')]
    source = '\n\n'.join(f'{i + 1}\n00:00:{i:02d},000 --> 00:00:{i:02d},500\n{a}' for i, (a, _) in enumerate(lines))
    translated = '\n\n'.join(f'{i + 1}\n00:00:{i:02d},000 --> 00:00:{i:02d},500\n{b}' for i, (_, b) in enumerate(lines))
    cleaned, removed = remove_stray_script(source, translated)
    assert removed == 6 and 'পির' not in cleaned
    assert '¡Vamos, Levi!' in cleaned and 'Mikasa (ミカサ) está aquí.' in cleaned
    assert remove_stray_script(source, source) == (source, 0)


def test_sidecar_language_is_read_from_its_dialogue():
    assert guess_subtitle_language(srt(CUES, text=SPANISH)) == 'spa'
    assert guess_subtitle_language(srt(CUES, text='What is that you have, and why is it here?')) == 'eng'
    assert guess_subtitle_language(srt(CUES[:3], text=SPANISH)) == ''   # too little to tell


def test_hi_sidecar_counts_as_spanish_and_plain_sidecar_is_preferred(app_module, tmp_path):
    video = tmp_path / 'Show - S01E01.mkv'
    video.touch()
    (tmp_path / 'Show - S01E01.hi.srt').write_text(srt(CUES, text=SPANISH), encoding='utf-8')
    mf = {'filepath': str(video), 'media_type': 'show'}
    assert [(s['lang'], s['hearing_impaired']) for s in app_module.anime_sidecars(mf)] == [('spa', True)]
    (tmp_path / 'Show - S01E01.es.srt').write_text(srt(CUES, text=SPANISH), encoding='utf-8')
    sidecars = app_module.anime_sidecars(mf)
    assert sorted((s['title'], s['hearing_impaired']) for s in sidecars) == [
        ('Show - S01E01.es.srt', False), ('Show - S01E01.hi.srt', True)]


# ── Timing against the audio ─────────────────────────────────────────────────
def test_audio_offset_finds_an_early_sidecar_and_rejects_another_episode():
    envelope = speech_envelope(speech_pcm(CUES))
    offset, confidence = audio_offset([(s - 1.05, e - 1.05) for s, e in CUES], envelope)
    assert offset == pytest.approx(1.05, abs=0.03) and confidence > 6
    assert audio_offset(CUES, envelope)[0] == pytest.approx(0.0, abs=0.03)
    assert audio_offset(OTHER, envelope)[1] < AUDIO_MISMATCH_CONFIDENCE
    assert audio_offset(CUES[:10], envelope) is None
    # A steady tone has no speech to line up with: no verdict, not a mismatch.
    tone = struct.pack(f'<{SECONDS * RATE}h', *(int(8000 * (i % 18 < 9)) for i in range(SECONDS * RATE)))
    assert speech_envelope(tone) == []


@pytest.fixture
def audio_only_episode(tmp_path, app_module, insert_media):
    """Japanese audio with speech on CUES' timeline; no embedded subtitles,
    like the KAZETV Season 4 releases."""
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg/ffprobe not installed')
    speech = tmp_path / 'speech.wav'
    with wave.open(str(speech), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(speech_pcm(CUES))
    video = tmp_path / 'Show - S04E01.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=2', '-i', str(speech),
                    '-map', '0:v', '-map', '1:a', '-t', str(SECONDS), '-c:v', 'mpeg4', '-c:a', 'pcm_s16le',
                    '-metadata:s:a:0', 'language=jpn', str(video)], check=True, capture_output=True, timeout=60)
    info = app_module.parse_media_info(str(video))
    fid = insert_media(filepath=str(video), filename=video.name, media_type='show', show_name='Show',
                       audio_tracks=info['audio_tracks'], subtitle_tracks=info['subtitle_tracks'])
    return fid, video


def run_job(client, app_module, fid):
    result = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
    assert result['count'] == 1, result
    app_module.run_translation_job(result['queued'][0])
    with app_module.db() as conn:
        return conn.execute('SELECT * FROM translation_jobs WHERE id=?', (result['queued'][0],)).fetchone()


def styled_dialogue(video):
    probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(video)],
                                      capture_output=True, text=True, check=True).stdout)['streams']
    subs = [s for s in probe if s['codec_type'] == 'subtitle']
    if not subs:
        return []
    content = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-map', '0:s:0', '-f', 'ass', '-'],
                             capture_output=True, text=True, encoding='utf-8', check=True).stdout
    return [line for line in content.splitlines() if line.startswith('Dialogue:')]


def test_real_early_sidecar_without_embedded_track_is_retimed_from_audio(client, app_module, monkeypatch, audio_only_episode):
    fid, video = audio_only_episode
    monkeypatch.setattr(app_module, 'translate_subtitle_file', lambda *a, **k: pytest.fail('AI must not run'))
    early = srt(CUES, offset=-1.0, text=SPANISH)
    # An info card with \h padding, and a last cue that runs past the video's end.
    early += f'\n41\n{fmt(116)} --> {fmt(119)}\n\\h\\hInformación pública\n\n42\n{fmt(122)} --> {fmt(131)}\nFin\n'
    (video.parent / 'Show - S04E01.es.srt').write_text(early, encoding='utf-8')
    job = run_job(client, app_module, fid)
    assert job['status'] == 'done', job['error_text']
    assert 'shifted +1.00 s to match the dialogue audio' in job['progress_detail']
    lines = styled_dialogue(video)
    assert lines[0].split(',')[1] == f'0:00:{CUES[0][0]:05.2f}'
    assert any(line.endswith(r',\h\hInformación pública') for line in lines)
    assert lines[-1].split(',')[1:3] == ['0:02:03.00', '0:02:05.00']   # clipped to the 125 s video


def test_real_sidecar_for_another_episode_fails_and_keeps_the_original(client, app_module, monkeypatch, audio_only_episode):
    fid, video = audio_only_episode
    before = video.stat().st_mtime_ns
    (video.parent / 'Show - S04E01.es.srt').write_text(srt(OTHER, text=SPANISH), encoding='utf-8')
    job = run_job(client, app_module, fid)
    assert job['status'] == 'failed'
    assert 'does not match this video' in job['error_text']
    assert video.stat().st_mtime_ns == before and styled_dialogue(video) == []


def test_real_spanish_hi_sidecar_is_used_instead_of_translating(client, app_module, monkeypatch, audio_only_episode):
    fid, video = audio_only_episode
    monkeypatch.setattr(app_module, 'translate_subtitle_file', lambda *a, **k: pytest.fail('AI must not run'))
    (video.parent / 'Show - S04E01.hi.srt').write_text(srt(CUES, text=SPANISH), encoding='utf-8')
    job = run_job(client, app_module, fid)
    assert job['status'] == 'done', job['error_text']
    assert 'in sync' in job['progress_detail']
    assert SPANISH in styled_dialogue(video)[0]


def test_srt_cues_reads_start_and_end():
    assert srt_cues(srt([(1.5, 2.25), (3.0, 4.0)])) == [(1.5, 2.25), (3.0, 4.0)]
