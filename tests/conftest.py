"""
Pytest fixtures for the media-monitor backend.

Each test gets an isolated SQLite DB + config file under a tmp dir so we can
exercise the real Flask routes (and the real init_db schema) without touching
the production /config volume. The app module is imported lazily inside the
fixture so env vars set here win over the defaults baked in at import time.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    db_file = tmp_path / "processed.db"
    watch = tmp_path / "watch"
    watch.mkdir()

    monkeypatch.setenv("CONFIG_FILE", str(cfg))
    monkeypatch.setenv("DB_FILE", str(db_file))
    monkeypatch.setenv("WATCH_DIR", str(watch))
    monkeypatch.setenv("REENCODE_SIZE_GB", "20")

    # Force a fresh import so module-level constants pick up the env above.
    if "app" in sys.modules:
        del sys.modules["app"]
    mod = importlib.import_module("app")

    mod.init_db()
    mod._migrate_db()
    yield mod

    # Best-effort: drop the app from sys.modules so the next test reimports
    # against its own tmp paths.
    sys.modules.pop("app", None)


@pytest.fixture
def client(app_module):
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


def _insert_media(app_module, **overrides):
    """Insert a media_files row directly. Returns the row id."""
    import json as _json

    defaults = dict(
        filepath=f"/watch/movies/{overrides.get('filename', 'sample.mkv')}",
        folder_name="Sample",
        filename=overrides.get("filename", "sample.mkv"),
        size_bytes=2 * 1024**3,
        duration_seconds=3600.0,
        video_codec="hevc",
        video_width=1920,
        video_height=1080,
        video_bitrate=5_000_000,
        audio_tracks=_json.dumps([{"lang": "eng", "codec": "ac3"}]),
        subtitle_tracks=_json.dumps(
            [{"lang": "eng", "codec": "srt"}, {"lang": "spa", "codec": "srt"}]
        ),
        format_name="matroska",
        status="OK",
        encode_status=None,
        has_sibling_videos=0,
        media_type="movie",
    )
    defaults.update(overrides)
    with app_module.db() as conn:
        cur = conn.execute(
            """
            INSERT INTO media_files
                (filepath, folder_name, filename, size_bytes, duration_seconds,
                 video_codec, video_width, video_height, video_bitrate,
                 audio_tracks, subtitle_tracks, format_name, status,
                 encode_status, has_sibling_videos, media_type, scanned_at)
            VALUES
                (:filepath, :folder_name, :filename, :size_bytes, :duration_seconds,
                 :video_codec, :video_width, :video_height, :video_bitrate,
                 :audio_tracks, :subtitle_tracks, :format_name, :status,
                 :encode_status, :has_sibling_videos, :media_type, datetime('now'))
            """,
            defaults,
        )
        return cur.lastrowid


@pytest.fixture
def insert_media(app_module):
    def _do(**overrides):
        return _insert_media(app_module, **overrides)

    return _do
