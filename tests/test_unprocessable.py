"""Tests for ISO/IMG (UNPROCESSABLE) disc-image handling under Alerts."""

from __future__ import annotations

import json
import os


def _make_iso(app_module, name="Some.Movie.iso", subdir="movies"):
    """Create a real file under WATCH_DIR so getsize()/detect_media_type work."""
    folder = os.path.join(app_module.WATCH_DIR, subdir)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as f:
        f.write(b"\0" * 1024)
    return path


def test_record_unprocessable_inserts_row(app_module):
    path = _make_iso(app_module)
    size = app_module.record_unprocessable_file(path)

    assert size == 1024
    with app_module.db() as conn:
        row = conn.execute(
            "SELECT * FROM media_files WHERE filepath=?", (path,)
        ).fetchone()

    assert row is not None
    assert row["status"] == "UNPROCESSABLE"
    assert row["filename"] == "Some.Movie.iso"
    assert row["format_name"] == "iso"
    assert row["video_codec"] is None
    assert json.loads(row["audio_tracks"]) == []
    assert row["has_sibling_videos"] == 0


def test_alerts_filter_includes_unprocessable(client, insert_media):
    insert_media(
        filename="disc.iso",
        status="UNPROCESSABLE",
        filepath="/watch/movies/disc.iso",
    )
    insert_media(
        filename="dup.mkv",
        has_sibling_videos=1,
        filepath="/watch/movies/dup.mkv",
    )
    insert_media(filename="ok.mkv", status="OK", filepath="/watch/movies/ok.mkv")

    body = client.get("/api/media?filter=alerts").get_json()
    assert {f["filename"] for f in body["files"]} == {"disc.iso", "dup.mkv"}


def test_stats_alerts_count_includes_unprocessable(client, insert_media):
    insert_media(
        filename="disc.iso",
        status="UNPROCESSABLE",
        filepath="/watch/movies/disc.iso",
    )
    insert_media(
        filename="dup.mkv",
        has_sibling_videos=1,
        filepath="/watch/movies/dup.mkv",
    )
    insert_media(filename="ok.mkv", status="OK", filepath="/watch/movies/ok.mkv")

    stats = client.get("/api/media/stats?type=movie").get_json()
    assert stats["alerts_count"] == 2


def test_unprocessable_not_in_needs_encoding(client, insert_media):
    insert_media(
        filename="disc.iso",
        status="UNPROCESSABLE",
        filepath="/watch/movies/disc.iso",
    )
    body = client.get("/api/media?filter=needs_encoding").get_json()
    assert body["files"] == []


def test_recalculate_preserves_unprocessable(client, insert_media):
    # An ISO row with no stream data — determine_status() would return 'OK',
    # so the recalculate endpoint must skip it.
    iso_id = insert_media(
        filename="disc.iso",
        status="UNPROCESSABLE",
        filepath="/watch/movies/disc.iso",
        audio_tracks=json.dumps([]),
        subtitle_tracks=json.dumps([]),
    )
    # A normal row that SHOULD be recomputed (no langs → REMUX/MISSING LANG).
    normal_id = insert_media(
        filename="normal.mkv",
        status="WRONG",
        filepath="/watch/movies/normal.mkv",
        audio_tracks=json.dumps([{"codec": "ac3"}]),
        subtitle_tracks=json.dumps([]),
    )

    r = client.post("/api/media/recalculate-status")
    assert r.status_code == 200

    body = client.get("/api/media?type=all").get_json()
    by_id = {f["id"]: f for f in body["files"]}
    assert by_id[iso_id]["status"] == "UNPROCESSABLE"
    assert by_id[normal_id]["status"] != "WRONG"
