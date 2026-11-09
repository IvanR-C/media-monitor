"""Try Fix Anime on real episodes without touching the library.

    python scripts/fix_anime_samples.py fetch HOST "REMOTE/Show/Season 4" S04E01 S04E17 --out samples
    python scripts/fix_anime_samples.py run samples

`fetch` makes a slim copy of each episode on HOST over ssh: a black 320x180
video track, every audio track (AAC, so the timing is the source's), every
subtitle track except a styled "Anime ASS" one an earlier run added, and the
episode's sidecar subtitles. Copies are a few MB each, then pulled with scp.

`run` scans the copies into a throwaway config and database, queues Fix Anime
(target-language mode, the settings' target language, Spanish by default) and
reports for each episode: the job result and timing notes, the styled track's
cue count, leftover full-width escapes, and whether cues outlast the video.
AI translation is blocked; an episode that would need it says so instead.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def fetch(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    remote_dir = f'/tmp/fix-anime-samples-{os.getpid()}'
    ffmpeg, ffprobe = shlex.quote(args.remote_ffmpeg), shlex.quote(args.remote_ffprobe)
    script = [f'set -e; mkdir -p {remote_dir}; cd {shlex.quote(args.folder)}']
    for episode in args.episodes:
        script.append(f'''
f=$(ls *{shlex.quote(episode)}*.mkv | head -1)
base="${{f%.mkv}}"
drop=$({ffprobe} -v error -select_streams s -show_entries stream_tags=title -of csv=p=0 "$f" \\
       | grep -n "^Anime ASS" | cut -d: -f1 | while read n; do printf -- "-map -1:s:%d " $((n-1)); done)
length=$({ffprobe} -v error -show_entries format=duration -of csv=p=0 "$f")
# An explicit length, not -shortest: ffmpeg 7 can drop audio with -shortest.
{ffmpeg} -v error -y -f lavfi -t "$length" -i color=c=black:s=320x180:r=2 -i "$f" -map 0:v -map 1:a -map '1:s?' $drop \\
  -map_metadata 1 -c:v libx264 -preset ultrafast -crf 40 -c:a aac -b:a 64k -c:s copy \\
  "{remote_dir}/$f" &
for s in "$base".*.srt "$base".*.ass "$base".*.vtt; do [ -e "$s" ] && cp "$s" {remote_dir}/; done
''')
    script.append('wait')
    subprocess.run(['ssh', args.host, '\n'.join(script)], check=True)
    subprocess.run(['scp', '-q', f'{args.host}:{remote_dir}/*', str(out)], check=True)
    subprocess.run(['ssh', args.host, f'rm -rf {remote_dir}'], check=True)
    print(f'{len(args.episodes)} episode(s) in {out}')


def run(args):
    samples = Path(args.samples).resolve()
    work = Path(tempfile.mkdtemp(prefix='fix-anime-run-'))
    os.environ.update(CONFIG_FILE=str(work / 'config.json'), DB_FILE=str(work / 'processed.db'),
                      WATCH_DIR=str(samples), AUTH_FILE=str(work / 'auth.json'),
                      SECRET_KEY_FILE=str(work / 'secret_key'))
    sys.path.insert(0, str(REPO))
    import app  # noqa: E402  (reads the environment at import)
    from anime_subtitles import ass_cues  # noqa: E402

    app.init_db()
    app._migrate_db()
    app.load_auth()
    app.config['anime_settings'] = {**app.config.get('anime_settings', {}), 'target_lang': args.target}

    def no_ai(*_, **__):
        raise RuntimeError('needs AI translation (blocked in this harness)')

    app.translate_subtitle_file = no_ai
    app.app.config['TESTING'] = True
    client = app.app.test_client()
    client.post('/api/auth/setup', json={'username': 'harness', 'password': 'harness-password-1'})
    for video in sorted(samples.glob('*.mkv')):
        info = app.parse_media_info(str(video))
        app.upsert_media_file(info)
        with app.db() as conn:
            fid = conn.execute('SELECT id FROM media_files WHERE filepath=?', (str(video),)).fetchone()['id']
        queued = client.post('/api/anime/queue', json={'file_ids': [fid]}).get_json()
        if not queued.get('count'):
            reason = (queued.get('files') or [{}])[0].get('reason') or queued.get('error')
            print(f'{video.name}\n  not queued: {reason}\n')
            continue
        app.run_translation_job(queued['queued'][0])
        with app.db() as conn:
            job = conn.execute('SELECT * FROM translation_jobs WHERE id=?', (queued['queued'][0],)).fetchone()
        print(video.name)
        print(f'  source: {job["source_lang"]} {job["source_codec"]}  status: {job["status"]}')
        print(f'  {job["progress_detail"] or job["error_text"]}')
        if job['status'] == 'done':
            probe = app.run_ffprobe(str(video))
            duration = float(probe['format']['duration'])
            subs = [s for s in probe['streams'] if s['codec_type'] == 'subtitle']
            index = next(i for i, s in enumerate(subs) if (s.get('tags') or {}).get('title', '').startswith('Anime ASS'))
            text = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-map', f'0:s:{index}', '-f', 'ass', '-'],
                                  capture_output=True, text=True, encoding='utf-8', check=True).stdout
            cues = ass_cues(text)
            last = max(end for _, end in cues)
            print(f'  styled track: {len(cues)} cues, full-width escapes {text.count("＼") + text.count("｛")}, '
                  f'last cue ends {last:.2f} s of {duration:.2f} s{" (PAST END)" if last > duration + 0.05 else ""}')
        print()
    print(f'Scratch config and database: {work}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fetch', help='make slim copies of episodes on a server and download them')
    f.add_argument('host', help='ssh destination, e.g. user@nas')
    f.add_argument('folder', help='season folder on the server')
    f.add_argument('episodes', nargs='+', help='episode tags such as S04E01')
    f.add_argument('--out', default='anime-samples')
    f.add_argument('--remote-ffmpeg', default='ffmpeg')
    f.add_argument('--remote-ffprobe', default='ffprobe')
    r = sub.add_parser('run', help='run Fix Anime on downloaded copies in a scratch library')
    r.add_argument('samples')
    r.add_argument('--target', default='spa', help='target subtitle language (default spa)')
    args = parser.parse_args()
    (fetch if args.command == 'fetch' else run)(args)


if __name__ == '__main__':
    main()
