"""Tests for /api/media, /api/media/stats, and /api/health."""

from __future__ import annotations


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200


def test_media_list_empty(client):
    r = client.get("/api/media")
    assert r.status_code == 200
    body = r.get_json()
    assert body == {"files": [], "total": 0}


def test_common_media_extensions_are_supported(app_module):
    expected = {
        ".mkv",
        ".mp4",
        ".avi",
        ".mov",
        ".m4v",
        ".m2ts",
        ".mts",
        ".mpg",
        ".mpeg",
        ".vob",
        ".webm",
        ".wmv",
        ".flv",
        ".3gp",
    }
    assert expected.issubset(set(app_module.VIDEO_EXTENSIONS))


def test_media_list_filters_by_type(client, insert_media):
    insert_media(filename="movie-a.mkv", media_type="movie")
    insert_media(filename="show-b.mkv", media_type="show", filepath="/watch/shows/show-b.mkv")

    movies = client.get("/api/media?type=movie").get_json()
    shows = client.get("/api/media?type=show").get_json()

    assert {f["filename"] for f in movies["files"]} == {"movie-a.mkv"}
    assert {f["filename"] for f in shows["files"]} == {"show-b.mkv"}


def test_media_list_type_all_returns_everything(client, insert_media):
    insert_media(filename="movie-a.mkv", media_type="movie")
    insert_media(filename="show-b.mkv", media_type="show", filepath="/watch/shows/show-b.mkv")

    body = client.get("/api/media?type=all").get_json()
    assert {f["filename"] for f in body["files"]} == {"movie-a.mkv", "show-b.mkv"}


def test_media_list_unknown_type_falls_back_to_movie(client, insert_media):
    insert_media(filename="movie-a.mkv", media_type="movie")
    insert_media(filename="show-b.mkv", media_type="show", filepath="/watch/shows/show-b.mkv")

    # Bad value must NOT inject — route should silently coerce to 'movie'.
    r = client.get("/api/media?type=' OR 1=1 --")
    assert r.status_code == 200
    assert {f["filename"] for f in r.get_json()["files"]} == {"movie-a.mkv"}


def test_media_filter_needs_encoding(client, insert_media):
    insert_media(filename="big.mkv", status="RE-ENCODE", filepath="/watch/movies/big.mkv")
    insert_media(filename="ok.mkv", status="OK", filepath="/watch/movies/ok.mkv")

    body = client.get("/api/media?filter=needs_encoding").get_json()
    assert {f["filename"] for f in body["files"]} == {"big.mkv"}


def test_media_search(client, insert_media):
    insert_media(filename="alpha.mkv", filepath="/watch/movies/alpha.mkv")
    insert_media(filename="beta.mkv", filepath="/watch/movies/beta.mkv")

    body = client.get("/api/media?search=alph").get_json()
    assert [f["filename"] for f in body["files"]] == ["alpha.mkv"]


def test_media_stats_counts_by_type(client, insert_media):
    insert_media(filename="m1.mkv", status="RE-ENCODE", filepath="/watch/movies/m1.mkv")
    insert_media(
        filename="m2.mkv",
        status="REMUX | MISSING LANG",
        filepath="/watch/movies/m2.mkv",
    )
    insert_media(
        filename="s1.mkv",
        media_type="show",
        status="RE-ENCODE",
        filepath="/watch/shows/s1.mkv",
    )

    movie_stats = client.get("/api/media/stats?type=movie").get_json()
    assert movie_stats["total_files"] == 2
    assert movie_stats["needs_encoding"] == 1
    assert movie_stats["needs_remux"] == 1
    assert movie_stats["missing_lang"] == 1

    show_stats = client.get("/api/media/stats?type=show").get_json()
    assert show_stats["total_files"] == 1
    assert show_stats["needs_encoding"] == 1
