"""Seed fictional media into the isolated local UI preview only.

Run after config/settings-preview/preview.py has initialized the demo database.
This never reads the real library DB and creates no media files or workers.
"""
import json
import sqlite3
from demo_artwork import poster_for
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / 'config' / 'settings-preview' / 'preview.db'


def seed(connection):
    def audio(*langs):
        return [dict(audio_idx=i, codec='eac3' if i == 0 else 'aac', channels=6 if i == 0 else 2,
                     lang=lang, title='Original audio' if i == 0 else 'Dub / commentary') for i, lang in enumerate(langs)]
    def subs(*langs):
        return [dict(sub_idx=i, codec='srt' if i % 3 else 'hdmv_pgs_subtitle', lang=lang,
                     title='Full subtitles' if i == 0 else 'SDH / alternate') for i, lang in enumerate(langs)]
    movies = [
        ('Aster Station (2025)', 38.6, 'h264', ['eng', 'nld', 'pol'], ['eng', 'nld', 'pol'], 'RE-ENCODE | MISSING LANG'),
        ('Blue Hour (2024)', 7.2, 'hevc', ['fra', 'eng'], ['eng', 'spa', 'fra'], 'OK'),
        ('City of Lanterns (2023)', 24.8, 'h264', ['zho', 'eng'], ['eng', 'zho'], 'RE-ENCODE | MISSING LANG'),
        ('Driftwood (2025)', 12.1, 'hevc', ['und', 'eng'], ['eng', 'spa'], 'REMUX'),
        ('Echoes of the North (2022)', 14.4, 'hevc', ['swe', 'nor'], ['eng', 'spa', 'swe', 'nor'], 'OK'),
        ('Far Beyond the Last Horizon - Extended Collector Edition (2026)', 56.3, 'h264', ['ger', 'eng', 'ces'], ['eng', 'deu', 'ces'], 'RE-ENCODE | MISSING LANG'),
        ('Glass River (2024)', 5.8, 'hevc', ['kor'], ['eng', 'spa', 'kor'], 'OK'),
        ('Harbor Lights (2023)', 18.5, 'h264', ['eng'], [], 'MISSING LANG'),
        ('Invisible Maps (2021)', 8.6, 'hevc', ['ukr', 'rus'], ['eng', 'ukr', 'rus'], 'MISSING LANG'),
        ('Juniper Road (2025)', 3.9, 'hevc', ['eng', 'spa'], ['eng', 'spa'], 'OK'),
        ('Kite Season (2024)', 11.3, 'hevc', ['hin', 'tam', 'tel'], ['eng', 'spa', 'hin'], 'OK'),
        ('Letters from Lisbon (2022)', 9.4, 'hevc', ['por', 'eng'], ['eng', 'spa', 'por'], 'OK'),
        ('Midnight Archive (1998)', 42.5, None, [], [], 'UNPROCESSABLE'),
        ('Northern Passage (2020)', 21.7, 'h264', ['fin', 'dan', 'isl'], ['eng', 'fin', 'dan', 'isl'], 'RE-ENCODE | MISSING LANG'),
    ]
    records = []
    for index, (title, size, codec, aud, sub, status) in enumerate(movies):
        filename = title.replace(' ', '.') + ('.iso' if status == 'UNPROCESSABLE' else '.2160p.BluRay.mkv')
        records.append(dict(filepath=f'/demo/Movies/{title}/{filename}', folder_name=title, filename=filename,
            size_bytes=int(size * 1024**3), duration_seconds=7200, video_codec=codec,
            video_width=3840 if size > 20 else 1920, video_height=2160 if size > 20 else 1080,
            video_bitrate=24000000 if size > 20 else 7000000, audio_tracks=json.dumps(audio(*aud)),
            subtitle_tracks=json.dumps(subs(*sub)), status=status, media_type='movie', show_name=None,
            season_episode=None, has_sibling_videos=1 if index == 11 else 0,
            encode_status='done' if index == 9 else None))
    shows = [('Aurora Bureau', ['eng', 'spa']), ('Beneath the Pines', ['nld', 'eng']),
             ('Metro Stories', ['jpn', 'eng']), ('The Quiet Coast', ['dan', 'swe'])]
    for show_index, (show, langs) in enumerate(shows):
        for season in (1, 2):
            for episode in range(1, 4):
                se = f'S{season:02}E{episode:02}'
                filename = f'{show.replace(" ", ".")}.{se}.1080p.WEB-DL.mkv'
                records.append(dict(filepath=f'/demo/Shows/{show}/Season {season:02}/{filename}',
                    folder_name=f'Season {season:02}', filename=filename, size_bytes=int((1.2 + episode * 0.65) * 1024**3),
                    duration_seconds=2700, video_codec='hevc' if episode != 2 else 'h264', video_width=1920,
                    video_height=1080, video_bitrate=6500000, audio_tracks=json.dumps(audio(*langs)),
                    subtitle_tracks=json.dumps(subs('eng', 'spa') if episode != 2 else subs(langs[0])),
                    status='MISSING LANG' if episode == 2 else 'OK', media_type='show', show_name=show,
                    season_episode=se, has_sibling_videos=0, encode_status='done' if episode == 3 else None))
    for record in records:
        columns = ', '.join(record)
        placeholders = ', '.join('?' for _ in record)
        connection.execute(f'INSERT OR IGNORE INTO media_files ({columns}) VALUES ({placeholders})', tuple(record.values()))
    connection.execute("UPDATE media_files SET format_name='matroska' WHERE filepath LIKE '/demo/%' AND filename LIKE '%.mkv' AND format_name IS NULL")
    for title, media_type in [(movie[0], 'movie') for movie in movies] + [(show[0], 'show') for show in shows]:
        poster = poster_for(title)
        if poster:
            field = 'show_name' if media_type == 'show' else 'folder_name'
            connection.execute(f"UPDATE media_files SET poster_url=? WHERE {field}=? AND media_type=? AND (poster_url IS NULL OR poster_url='')", (poster, title, media_type))
    connection.commit()
    print('Demo library:', [tuple(row) for row in connection.execute('SELECT media_type, COUNT(*) FROM media_files GROUP BY media_type')])


if __name__ == '__main__':
    if not DATABASE.is_file():
        raise SystemExit('Start the isolated preview first. No demo database exists.')
    with sqlite3.connect(DATABASE) as conn:
        seed(conn)
