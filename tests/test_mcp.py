"""Tests for the MCP endpoint (/mcp) and its access-token management."""

from __future__ import annotations

import json

import pytest


def _token(client, scope="full"):
    r = client.post("/api/mcp/token", json={"scope": scope})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["token"]


def _rpc(raw_client, token, method, params=None, msg_id=1, headers=None):
    body = {"jsonrpc": "2.0", "method": method}
    if msg_id is not None:
        body["id"] = msg_id
    if params is not None:
        body["params"] = params
    return raw_client.post(
        "/mcp", json=body,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream",
                 **(headers or {})},
    )


def _call(client, token, name, arguments=None):
    r = _rpc(client, token, "tools/call", {"name": name, "arguments": arguments or {}})
    assert r.status_code == 200, r.data
    result = r.get_json()["result"]
    return result, json.loads(result["content"][0]["text"]) if not result["isError"] else result["content"][0]["text"]


@pytest.fixture
def mcp_client(app_module):
    """A logged-out client: MCP requests must authenticate with the token alone."""
    with app_module.app.test_client() as c:
        yield c


# ── Token management ──────────────────────────────────────────────────────────
def test_token_routes_require_dashboard_login(raw_client):
    raw_client.post("/api/auth/setup", json={"username": "admin", "password": "testpassword123"})
    raw_client.post("/api/auth/logout")
    assert raw_client.post("/api/mcp/token", json={"scope": "full"}).status_code == 401


def test_token_is_shown_once_and_stored_hashed(client, app_module):
    assert client.get("/api/mcp/token").get_json()["enabled"] is False
    body = client.post("/api/mcp/token", json={"scope": "read"}).get_json()
    token = body["token"]
    assert token.startswith("mm_") and body["scope"] == "read" and body["hint"] == token[-4:]
    info = client.get("/api/mcp/token").get_json()
    assert info["enabled"] is True and "token" not in info
    stored = open(app_module.AUTH_FILE, encoding="utf-8").read()
    assert token not in stored and "mcp_token_hash" in stored


def test_invalid_scope_rejected(client):
    assert client.post("/api/mcp/token", json={"scope": "admin"}).status_code == 400


def test_regenerating_invalidates_old_token(client, mcp_client):
    old = _token(client)
    new = _token(client)
    assert _rpc(mcp_client, old, "ping").status_code == 401
    assert _rpc(mcp_client, new, "ping").status_code == 200


def test_revoke_disables_endpoint(client, mcp_client):
    token = _token(client)
    assert client.delete("/api/mcp/token").get_json()["enabled"] is False
    assert _rpc(mcp_client, token, "ping").status_code == 401


# ── Transport ─────────────────────────────────────────────────────────────────
def test_requires_bearer_token(client, mcp_client):
    _token(client)
    r = mcp_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"].startswith("Bearer")
    assert _rpc(mcp_client, "mm_wrong", "ping").status_code == 401


def test_disabled_until_a_token_exists(client, mcp_client):
    assert _rpc(mcp_client, "anything", "ping").status_code == 401


def test_initialize_handshake(client, mcp_client):
    token = _token(client)
    r = _rpc(mcp_client, token, "initialize", {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "pytest", "version": "1"},
    })
    result = r.get_json()["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert "tools" in result["capabilities"]
    assert result["serverInfo"]["name"] == "media-monitor"
    assert "file_id" in result["instructions"]

    # Unknown versions are answered with the latest one we support.
    r = _rpc(mcp_client, token, "initialize", {"protocolVersion": "1999-01-01", "capabilities": {}})
    assert r.get_json()["result"]["protocolVersion"] == "2025-11-25"

    # The initialized notification has no reply.
    r = _rpc(mcp_client, token, "notifications/initialized", msg_id=None)
    assert r.status_code == 202 and not r.data


def test_get_is_not_offered(client, mcp_client):
    token = _token(client)
    r = mcp_client.get("/mcp", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 405


def test_rejects_foreign_origin(client, mcp_client):
    token = _token(client)
    r = _rpc(mcp_client, token, "ping", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    r = _rpc(mcp_client, token, "ping", headers={"Origin": "http://localhost"})
    assert r.status_code == 200


def test_unsupported_protocol_header(client, mcp_client):
    token = _token(client)
    r = _rpc(mcp_client, token, "ping", headers={"MCP-Protocol-Version": "1999-01-01"})
    assert r.status_code == 400


def test_parse_error_and_unknown_method(client, mcp_client):
    token = _token(client)
    r = mcp_client.post("/mcp", data="{nope", content_type="application/json",
                        headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == -32700
    r = _rpc(mcp_client, token, "resources/list")
    assert r.get_json()["error"]["code"] == -32601


def test_batch_requests(client, mcp_client):
    token = _token(client)
    r = mcp_client.post("/mcp", json=[
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ], headers={"Authorization": f"Bearer {token}"})
    replies = r.get_json()
    assert [m["id"] for m in replies] == [1, 2]


# ── Tool visibility and access ────────────────────────────────────────────────
def test_read_only_token_lists_only_read_tools(client, mcp_client):
    token = _token(client, "read")
    tools = _rpc(mcp_client, token, "tools/list").get_json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert "search_media" in names and "queue_encode" not in names
    assert all(t["annotations"]["readOnlyHint"] for t in tools)


def test_full_token_lists_actions_with_annotations(client, mcp_client):
    token = _token(client, "full")
    tools = {t["name"]: t for t in _rpc(mcp_client, token, "tools/list").get_json()["result"]["tools"]}
    assert {"queue_encode", "update_tracks", "queue_fix_anime", "control_queue", "purge_backups"} <= set(tools)
    assert tools["purge_backups"]["annotations"]["destructiveHint"] is True
    for t in tools.values():
        assert t["inputSchema"]["type"] == "object"


def test_read_only_token_cannot_call_actions(client, mcp_client, app_module):
    token = _token(client, "read")
    result, message = _call(mcp_client, token, "control_queue", {"queue": "encode", "action": "pause"})
    assert result["isError"] and "read-only" in message
    assert not app_module.encode_paused.is_set()


def test_unknown_tool_is_protocol_error(client, mcp_client):
    token = _token(client)
    r = _rpc(mcp_client, token, "tools/call", {"name": "format_disk", "arguments": {}})
    assert r.get_json()["error"]["code"] == -32602


def test_argument_validation_is_a_tool_error(client, mcp_client):
    token = _token(client)
    result, message = _call(mcp_client, token, "get_media_details", {})
    assert result["isError"] and "file_id is required" in message
    result, message = _call(mcp_client, token, "get_media_details", {"file_id": "7"})
    assert result["isError"] and "integer" in message
    result, message = _call(mcp_client, token, "search_media", {"filter": "everything"})
    assert result["isError"] and "one of" in message
    result, message = _call(mcp_client, token, "search_media", {"bogus": 1})
    assert result["isError"] and "bogus" in message


# ── Read tools ────────────────────────────────────────────────────────────────
def test_search_and_details(client, mcp_client, insert_media):
    big = insert_media(filename="Big.mkv", folder_name="Big Movie", status="RE-ENCODE",
                       filepath="/watch/movies/Big Movie/Big.mkv", size_bytes=40 * 1024**3)
    insert_media(filename="Small.mkv", folder_name="Small Movie", filepath="/watch/movies/Small Movie/Small.mkv")
    token = _token(client, "read")

    result, data = _call(mcp_client, token, "search_media", {"filter": "needs_encoding"})
    assert not result["isError"] and result["structuredContent"] == data
    assert [f["id"] for f in data["files"]] == [big]
    row = data["files"][0]
    assert row["title"] == "Big Movie" and row["video"] == "hevc 1080p"
    assert row["subtitle_langs"] == ["eng", "spa"] and row["estimated_size_gb"] is not None

    _, data = _call(mcp_client, token, "search_media", {"query": "small"})
    assert data["total"] == 1

    _, data = _call(mcp_client, token, "search_media", {"limit": 1})
    assert data["returned"] == 1 and data["has_more"] is True

    _, detail = _call(mcp_client, token, "get_media_details", {"file_id": big})
    assert detail["filename"] == "Big.mkv" and "encoding_preview" in detail

    result, message = _call(mcp_client, token, "get_media_details", {"file_id": 999})
    assert result["isError"] and "not found" in message.lower()


def test_overview_and_jobs(client, mcp_client, insert_media):
    fid = insert_media(filename="big.mkv", status="RE-ENCODE", filepath="/watch/movies/big.mkv")
    client.post("/api/encode/queue", json={"file_ids": [fid]})
    token = _token(client, "read")

    _, overview = _call(mcp_client, token, "get_library_overview")
    assert overview["library"]["movie"]["total_files"] == 1
    assert overview["queues"]["encode"]["active"] == 1
    assert overview["scan"]["running"] is False

    _, jobs = _call(mcp_client, token, "list_jobs", {"queue": "encode"})
    assert jobs["encode"]["total"] == 1 and "translation" not in jobs
    assert jobs["encode"]["jobs"][0]["media_file_id"] == fid
    _, jobs = _call(mcp_client, token, "list_jobs", {"status": "failed"})
    assert jobs["encode"]["total"] == 0 and jobs["translation"]["total"] == 0


def test_settings_never_expose_secrets(client, mcp_client, app_module):
    app_module.config.update(openai_api_key="sk-secret", discord_webhook="https://discord/hook", ntfy_topic="")
    token = _token(client, "read")
    result, data = _call(mcp_client, token, "get_settings")
    text = result["content"][0]["text"]
    assert "sk-secret" not in text and "discord/hook" not in text
    assert data["settings"]["openai_api_key"] == "(set)"
    assert data["settings"]["ntfy_topic"] == "(not set)"
    assert "anime_settings" in data["settings"]


def test_logs_filtering(client, mcp_client, app_module):
    app_module.log("info", "hello from test")
    app_module.log("error", "boom in test")
    token = _token(client, "read")
    _, data = _call(mcp_client, token, "get_recent_logs", {"level": "error", "contains": "BOOM"})
    assert [e["msg"] for e in data["entries"]] == ["boom in test"]
    _, later = _call(mcp_client, token, "get_recent_logs", {"since": data["last_seq"]})
    assert all(e["seq"] > data["last_seq"] for e in later["entries"])


def test_alerts_split_by_kind(client, mcp_client, insert_media):
    insert_media(filename="broken.avi", status="UNPROCESSABLE", filepath="/watch/movies/broken.avi")
    token = _token(client, "read")
    _, data = _call(mcp_client, token, "list_alerts")
    assert [f["filename"] for f in data["unprocessable"]] == ["broken.avi"]
    assert data["disc_images"] == []


# ── Actions ───────────────────────────────────────────────────────────────────
def test_queue_encode_and_cancel(client, mcp_client, insert_media, app_module):
    fid = insert_media(filename="big.mkv", status="RE-ENCODE", filepath="/watch/movies/big.mkv")
    token = _token(client)
    result, data = _call(mcp_client, token, "queue_encode", {"file_ids": [fid]})
    assert not result["isError"] and data["count"] == 1
    job_id = data["queued"][0]["job_id"] if isinstance(data["queued"][0], dict) else data["queued"][0]

    _, data = _call(mcp_client, token, "cancel_job", {"queue": "encode", "job_id": job_id})
    assert data["status"] == "cancelled"
    with app_module.db() as conn:
        assert conn.execute("SELECT status FROM encode_jobs WHERE id=?", (job_id,)).fetchone()[0] == "cancelled"


def test_control_queue(client, mcp_client, app_module):
    token = _token(client)
    _call(mcp_client, token, "control_queue", {"queue": "translation", "action": "pause"})
    assert app_module.translation_paused.is_set()
    _call(mcp_client, token, "control_queue", {"queue": "translation", "action": "resume"})
    assert not app_module.translation_paused.is_set()
    _, data = _call(mcp_client, token, "control_queue", {"queue": "encode", "action": "clear_finished"})
    assert data == {"deleted": 0}


def test_update_tracks_keeps_existing_action_when_only_language_changes(client, mcp_client, insert_media, app_module):
    fid = insert_media(
        filename="m.mkv", filepath="/watch/movies/m.mkv",
        audio_tracks=json.dumps([{"audio_idx": 0, "lang": "", "codec": "ac3"},
                                 {"audio_idx": 1, "lang": "jpn", "codec": "aac", "action": "drop"}]),
        subtitle_tracks=json.dumps([{"sub_idx": 0, "lang": "eng", "codec": "subrip"}]),
    )
    app_module.queue_remux_job = lambda file_id, filepath: 41
    token = _token(client)
    result, data = _call(mcp_client, token, "update_tracks", {
        "file_id": fid, "audio": [{"audio_idx": 0, "lang": "eng"}, {"audio_idx": 1, "lang": "jpn"}],
    })
    assert not result["isError"], data
    assert data["remux_job_id"] == 41
    with app_module.db() as conn:
        audio = json.loads(conn.execute("SELECT audio_tracks FROM media_files WHERE id=?", (fid,)).fetchone()[0])
    assert audio[0]["lang"] == "eng" and audio[0]["action"] == "keep"
    assert audio[1]["action"] == "drop"

    result, message = _call(mcp_client, token, "update_tracks", {"file_id": fid, "subtitles": [{"sub_idx": 5}]})
    assert result["isError"] and "sub_idx 5" in message
    result, message = _call(mcp_client, token, "update_tracks", {"file_id": fid})
    assert result["isError"]


def test_mux_external_subtitle_resolves_filename_in_media_folder(client, mcp_client, insert_media, app_module, tmp_path):
    folder = tmp_path / "watch" / "movies" / "Film"
    folder.mkdir(parents=True)
    media = folder / "Film.mkv"
    media.write_bytes(b"x")
    (folder / "Film.es.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nHola\n", encoding="utf-8")
    fid = insert_media(filename="Film.mkv", filepath=str(media))
    captured = {}
    app_module.queue_mux_sub_job = lambda file_id, filepath, sub_path, lang: captured.update(sub=sub_path, lang=lang) or 7
    token = _token(client)

    _, data = _call(mcp_client, token, "list_external_subtitles", {"file_id": fid})
    assert data["subs"] == [{"filename": "Film.es.srt", "ext": ".srt"}]

    _, data = _call(mcp_client, token, "mux_external_subtitle", {"file_id": fid, "filename": "Film.es.srt", "lang": "spa"})
    assert data["job_id"] == 7 and captured == {"sub": str(folder / "Film.es.srt"), "lang": "spa"}

    result, message = _call(mcp_client, token, "mux_external_subtitle", {"file_id": fid, "filename": "../../etc/passwd"})
    assert result["isError"]


def test_extracted_subtitle_is_returned_once(client, mcp_client, insert_media, app_module, tmp_path):
    fid = insert_media(filename="m.mkv", filepath="/watch/movies/m.mkv")
    srt = tmp_path / "out.srt"
    srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello\n", encoding="utf-8")
    with app_module.db() as conn:
        job_id = conn.execute(
            "INSERT INTO translation_jobs (media_file_id, filepath, source_sub_idx, source_lang, status, srt_path, extract_only) "
            "VALUES (?, '/watch/movies/m.mkv', 0, 'eng', 'done', ?, 1)", (fid, str(srt)),
        ).lastrowid
    token = _token(client)
    result, data = _call(mcp_client, token, "get_extracted_subtitle", {"job_id": job_id})
    assert not result["isError"] and "Hello" in data["content"]
    assert data["filename"] == "m.sub0.eng.srt"
    result, _ = _call(mcp_client, token, "get_extracted_subtitle", {"job_id": job_id})
    assert result["isError"]


def test_fix_anime_requires_exactly_one_target(client, mcp_client, insert_media):
    fid = insert_media(filename="ep.mkv", filepath="/watch/shows/ep.mkv")
    token = _token(client)
    result, message = _call(mcp_client, token, "preview_fix_anime", {})
    assert result["isError"] and "file_ids or scope" in message
    result, message = _call(mcp_client, token, "preview_fix_anime",
                            {"file_ids": [fid], "scope": {"kind": "file", "file_id": fid}})
    assert result["isError"]


def test_scan_refusal_surfaces_as_tool_error(client, mcp_client, app_module):
    app_module.scan_status["running"] = True
    try:
        token = _token(client)
        result, message = _call(mcp_client, token, "scan_library")
        assert result["isError"] and "already" in message
    finally:
        app_module.scan_status["running"] = False
