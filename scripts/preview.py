"""Run an isolated, fictional UI preview on http://127.0.0.1:5001.

Build frontend/ first. No production files, media workers, or account credentials
are loaded. State is kept only in config/settings-preview/.
"""
import os
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'config' / 'settings-preview'
DATA.mkdir(parents=True, exist_ok=True)
(DATA / 'watch').mkdir(exist_ok=True)
os.environ.update(CONFIG_FILE=str(DATA / 'config.json'), DB_FILE=str(DATA / 'preview.db'),
                  AUTH_FILE=str(DATA / 'auth.json'), SECRET_KEY_FILE=str(DATA / 'secret_key'),
                  WATCH_DIR=str(DATA / 'watch'), STATIC_DIR=str(ROOT / 'frontend' / 'out'))
sys.path.insert(0, str(ROOT))
import app as mod
from flask import session
from seed_demo import seed


def main():
    mod.init_db()
    mod._migrate_db()
    mod.load_config()
    # Ephemeral sign-in for loopback-only demo data; no real account is loaded.
    mod.auth_state.update(username='Demo preview', password_hash='isolated-preview')
    with mod.db() as connection:
        seed(connection)
        for row in connection.execute("SELECT * FROM media_files WHERE status != 'UNPROCESSABLE'").fetchall():
            status = mod.determine_status(row['size_bytes'], json.loads(row['audio_tracks'] or '[]'),
                json.loads(row['subtitle_tracks'] or '[]'), row['filepath'], row['media_type'])
            connection.execute('UPDATE media_files SET status=? WHERE id=?', (status, row['id']))

    def preview_session():
        session['authenticated'] = True

    mod.app.before_request_funcs[None].insert(0, preview_session)
    mod.app.run(host='127.0.0.1', port=5001, debug=False)


if __name__ == '__main__':
    main()
