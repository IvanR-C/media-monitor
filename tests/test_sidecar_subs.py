"""
Tests for sidecar-subtitle awareness in determine_status().

A required subtitle language that's missing from the embedded tracks should NOT
be flagged MISSING LANG when a matching external .srt sits next to the video.
Matching rules: movies accept any language-tagged sub in the folder; shows
require the sidecar to share the episode's filename; untagged subs never count.
"""

GB = 1024 ** 3
AUDIO_ENG = [{"lang": "eng", "codec": "ac3"}]
SUBS_ENG_ONLY = [{"lang": "eng", "codec": "srt"}]  # spa is the missing required lang


def _video(dirpath, name):
    dirpath.mkdir(parents=True, exist_ok=True)
    v = dirpath / name
    v.write_bytes(b"")
    return v


def _touch(dirpath, name):
    (dirpath / name).write_text("")


def test_no_filepath_keeps_legacy_behavior(app_module):
    # Regression guard: without a filepath the directory is never scanned.
    status = app_module.determine_status(1 * GB, AUDIO_ENG, SUBS_ENG_ONLY)
    assert "MISSING LANG" in status


def test_movie_sidecar_named_after_video_clears_missing_lang(app_module, tmp_path):
    d = tmp_path / "Movies" / "Eternals (2021)"
    v = _video(d, "Eternals (2021).mkv")
    assert "MISSING LANG" in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")

    _touch(d, "Eternals (2021).spa.srt")
    assert "MISSING LANG" not in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")


def test_movie_language_named_sidecar_clears_missing_lang(app_module, tmp_path):
    d = tmp_path / "Movies" / "Some Film (2020)"
    v = _video(d, "Some Film (2020).mkv")
    _touch(d, "Spanish.srt")  # named after the language, not the movie
    assert "MISSING LANG" not in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")


def test_movie_unrelated_title_sidecar_is_ignored(app_module, tmp_path):
    d = tmp_path / "Movies" / "Heist (2019)"
    v = _video(d, "Heist (2019).mkv")
    # An unrelated sub whose title merely contains a language word must NOT count.
    _touch(d, "The Spanish Apartment.srt")
    assert "MISSING LANG" in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")


def test_movie_untagged_sidecar_is_ignored(app_module, tmp_path):
    d = tmp_path / "Movies" / "Drive (2011)"
    v = _video(d, "Drive (2011).mkv")
    _touch(d, "Drive (2011).srt")  # no language in the name → unknown
    assert "MISSING LANG" in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")


def test_show_episode_named_sidecar_clears_missing_lang(app_module, tmp_path):
    d = tmp_path / "Shows" / "Foo" / "Season 01"
    v = _video(d, "Foo.S01E01.mkv")
    _touch(d, "Foo.S01E01.spa.srt")
    assert "MISSING LANG" not in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "show")


def test_show_language_named_sidecar_does_not_clear(app_module, tmp_path):
    # In a multi-episode folder a bare language-named sub is ambiguous, so for
    # shows it must NOT clear the flag (avoids cross-episode bleed).
    d = tmp_path / "Shows" / "Foo" / "Season 01"
    v = _video(d, "Foo.S01E02.mkv")
    _touch(d, "Spanish.srt")
    assert "MISSING LANG" in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "show")


def test_sidecar_with_forced_modifier_token(app_module, tmp_path):
    d = tmp_path / "Movies" / "Sicario (2015)"
    v = _video(d, "Sicario (2015).mkv")
    _touch(d, "Sicario (2015).es.forced.srt")  # 2-letter + modifier
    assert "MISSING LANG" not in app_module.determine_status(
        1 * GB, AUDIO_ENG, SUBS_ENG_ONLY, str(v), "movie")
