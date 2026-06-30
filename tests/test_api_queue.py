"""Tests for the encode/translate queue endpoints (without spawning ffmpeg)."""

from __future__ import annotations


def test_queue_encode_requires_file_ids(client):
    r = client.post("/api/encode/queue", json={})
    assert r.status_code == 400


def test_queue_encode_creates_jobs(client, insert_media, app_module):
    fid = insert_media(filename="big.mkv", status="RE-ENCODE", filepath="/watch/movies/big.mkv")
    r = client.post("/api/encode/queue", json={"file_ids": [fid]})
    assert r.status_code == 200
    body = r.get_json()
    assert body["count"] == 1

    with app_module.db() as conn:
        jobs = conn.execute(
            "SELECT status, media_file_id FROM encode_jobs WHERE media_file_id=?",
            (fid,),
        ).fetchall()
    assert len(jobs) == 1
    assert jobs[0]["status"] == "queued"


def test_queue_encode_dedupes_when_already_queued(client, insert_media):
    fid = insert_media(filename="big.mkv", status="RE-ENCODE", filepath="/watch/movies/big.mkv")
    first = client.post("/api/encode/queue", json={"file_ids": [fid]}).get_json()
    second = client.post("/api/encode/queue", json={"file_ids": [fid]}).get_json()
    assert first["count"] == 1
    assert second["count"] == 0


def test_pause_resume_encode(client, app_module):
    assert not app_module.encode_paused.is_set()
    r = client.post("/api/encode/pause")
    assert r.status_code == 200 and r.get_json()["paused"] is True
    assert app_module.encode_paused.is_set()

    r = client.post("/api/encode/resume")
    assert r.status_code == 200 and r.get_json()["paused"] is False
    assert not app_module.encode_paused.is_set()


def test_encode_jobs_reports_paused_state(client, app_module):
    app_module.encode_paused.set()
    body = client.get("/api/encode/jobs").get_json()
    assert body["paused"] is True
    app_module.encode_paused.clear()
    body = client.get("/api/encode/jobs").get_json()
    assert body["paused"] is False


def test_pause_resume_translate(client, app_module):
    client.post("/api/translate/pause")
    assert app_module.translation_paused.is_set()
    client.post("/api/translate/resume")
    assert not app_module.translation_paused.is_set()


def test_cancel_unknown_encode_job_404(client):
    r = client.post("/api/encode/cancel/9999")
    assert r.status_code == 404


def test_recalculate_status_runs(client, insert_media):
    insert_media(filename="a.mkv", status="OK")
    r = client.post("/api/media/recalculate-status")
    assert r.status_code == 200
    body = r.get_json()
    assert "updated" in body or "status" in body
