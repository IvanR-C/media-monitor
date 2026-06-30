"""Tests for /api/config — especially the new threshold validation."""

from __future__ import annotations


def test_get_config_returns_defaults(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    cfg = r.get_json()
    assert cfg["reencode_size_gb"] == 20.0
    assert cfg["required_sub_langs"] == ["eng", "spa"]


def test_post_config_updates_thresholds(client):
    r = client.post(
        "/api/config",
        json={"reencode_size_gb": 35.5, "required_sub_langs": ["eng", "spa", "jpn"]},
    )
    assert r.status_code == 200
    cfg = r.get_json()["config"]
    assert cfg["reencode_size_gb"] == 35.5
    assert cfg["required_sub_langs"] == ["eng", "jpn", "spa"]


def test_post_config_rejects_negative_size(client):
    r = client.post("/api/config", json={"reencode_size_gb": -1})
    assert r.status_code == 400


def test_post_config_rejects_huge_size(client):
    r = client.post("/api/config", json={"reencode_size_gb": 9999})
    assert r.status_code == 400


def test_post_config_rejects_non_numeric_size(client):
    r = client.post("/api/config", json={"reencode_size_gb": "twenty"})
    assert r.status_code == 400


def test_post_config_rejects_bad_sub_langs(client):
    r = client.post("/api/config", json={"required_sub_langs": "eng,spa"})
    assert r.status_code == 400


def test_determine_status_uses_runtime_thresholds(client, app_module):
    # Set a tiny threshold so a 2 GiB file becomes RE-ENCODE.
    client.post("/api/config", json={"reencode_size_gb": 1})
    audio = [{"lang": "eng", "codec": "ac3"}]
    subs = [{"lang": "eng", "codec": "srt"}, {"lang": "spa", "codec": "srt"}]
    status = app_module.determine_status(2 * 1024**3, audio, subs)
    assert "RE-ENCODE" in status

    # Bump it back up — 2 GiB should be OK now.
    client.post("/api/config", json={"reencode_size_gb": 50})
    status = app_module.determine_status(2 * 1024**3, audio, subs)
    assert status == "OK"


def test_determine_status_required_sub_langs_drives_missing_lang(client, app_module):
    audio = [{"lang": "eng", "codec": "ac3"}]
    subs_only_eng = [{"lang": "eng", "codec": "srt"}]

    # With default eng+spa required, eng-only is MISSING LANG.
    status = app_module.determine_status(1 * 1024**3, audio, subs_only_eng)
    assert "MISSING LANG" in status

    # Drop spa from the required set — same file should be OK now.
    client.post("/api/config", json={"required_sub_langs": ["eng"]})
    status = app_module.determine_status(1 * 1024**3, audio, subs_only_eng)
    assert status == "OK"
