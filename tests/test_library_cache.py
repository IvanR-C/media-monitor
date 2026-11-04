"""Tests for /api/media caching: version triggers, ETag/304, progress overlay, gzip."""

from __future__ import annotations

import gzip
import json


def _version(client):
    return client.get("/api/media/progress").get_json()["version"]


def test_media_list_sends_etag_and_304_when_unchanged(client, insert_media):
    insert_media(filename="a.mkv")
    first = client.get("/api/media?type=all")
    assert first.status_code == 200
    etag = first.headers["ETag"]
    assert first.headers["X-Library-Version"] in etag
    assert first.headers["Cache-Control"] == "no-cache"

    again = client.get("/api/media?type=all", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.data == b""


def test_new_file_invalidates_etag(client, insert_media):
    insert_media(filename="a.mkv")
    etag = client.get("/api/media?type=all").headers["ETag"]

    insert_media(filename="b.mkv")
    r = client.get("/api/media?type=all", headers={"If-None-Match": etag})
    assert r.status_code == 200
    assert {f["filename"] for f in r.get_json()["files"]} == {"a.mkv", "b.mkv"}


def test_updates_and_deletes_bump_version(client, app_module, insert_media):
    fid = insert_media(filename="a.mkv")
    v0 = _version(client)
    with app_module.db() as conn:
        conn.execute("UPDATE media_files SET status='RE-ENCODE' WHERE id=?", (fid,))
    v1 = _version(client)
    assert v1 != v0
    with app_module.db() as conn:
        conn.execute("DELETE FROM media_files WHERE id=?", (fid,))
    assert _version(client) != v1
    assert client.get("/api/media?type=all").get_json()["files"] == []


def test_job_status_changes_bump_version_but_progress_does_not(client, app_module, insert_media):
    fid = insert_media(filename="a.mkv")
    with app_module.db() as conn:
        job = conn.execute(
            "INSERT INTO encode_jobs (media_file_id, filepath, status) VALUES (?, ?, 'queued')",
            (fid, "/watch/movies/a.mkv"),
        ).lastrowid
        tjob = conn.execute(
            "INSERT INTO translation_jobs (media_file_id, filepath, status) VALUES (?, ?, 'pending')",
            (fid, "/watch/movies/a.mkv"),
        ).lastrowid
    v0 = _version(client)

    with app_module.db() as conn:
        conn.execute("UPDATE encode_jobs SET progress=42.5, speed='2x' WHERE id=?", (job,))
        conn.execute("UPDATE translation_jobs SET progress=10 WHERE id=?", (tjob,))
        # Re-writing an unchanged status (as progress loops do) is not a change.
        conn.execute("UPDATE translation_jobs SET status='pending', progress=11 WHERE id=?", (tjob,))
    assert _version(client) == v0

    progress = client.get("/api/media/progress").get_json()
    assert progress["encode"] == [{"id": fid, "progress": 42.5, "job_type": "encode"}]
    assert progress["translate"] == [{"id": fid, "status": "pending", "progress": 11.0}]

    with app_module.db() as conn:
        conn.execute("UPDATE encode_jobs SET status='encoding' WHERE id=?", (job,))
    v1 = _version(client)
    assert v1 != v0
    with app_module.db() as conn:
        conn.execute("UPDATE translation_jobs SET status='translating' WHERE id=?", (tjob,))
    assert _version(client) != v1


def test_settings_change_invalidates_size_estimates(client, app_module, insert_media):
    insert_media(filename="a.mkv", status="RE-ENCODE")
    v0 = _version(client)
    settings = app_module.proc.job_settings(app_module.config)
    key, value = next((k, v) for k, v in settings.items() if isinstance(v, bool))
    app_module.config[key] = not value
    assert _version(client) != v0


def test_cached_body_matches_fresh_body_and_respects_query(client, insert_media):
    insert_media(filename="movie-a.mkv", media_type="movie")
    insert_media(filename="show-b.mkv", media_type="show", filepath="/watch/shows/show-b.mkv")
    for _ in range(2):  # second round is served from the cache
        movies = client.get("/api/media?type=movie").get_json()
        shows = client.get("/api/media?type=show").get_json()
        assert [f["filename"] for f in movies["files"]] == ["movie-a.mkv"]
        assert [f["filename"] for f in shows["files"]] == ["show-b.mkv"]
        assert client.get("/api/media?type=all&search=show").get_json()["total"] == 1


def test_large_json_is_gzipped_when_accepted(client, insert_media):
    for i in range(30):
        insert_media(filename=f"file-{i:02}.mkv", filepath=f"/watch/movies/file-{i:02}.mkv")

    plain = client.get("/api/media?type=all")
    assert "Content-Encoding" not in plain.headers

    zipped = client.get("/api/media?type=all", headers={"Accept-Encoding": "gzip, br"})
    assert zipped.headers["Content-Encoding"] == "gzip"
    assert "Accept-Encoding" in zipped.headers["Vary"]
    assert len(zipped.data) < len(plain.data)
    assert json.loads(gzip.decompress(zipped.data)) == plain.get_json()

    # Other JSON endpoints go through the generic after_request hook.
    jobs = client.get("/api/encode/jobs", headers={"Accept-Encoding": "gzip"})
    assert jobs.status_code == 200
    assert "Content-Encoding" not in jobs.headers  # tiny body, below the threshold
