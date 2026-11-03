"""Details and artwork routes use local metadata and the existing TVDB integration."""
import json
from unittest.mock import Mock


def test_details_report_exact_missing_and_untagged_tracks(client, app_module, insert_media):
    file_id = insert_media(audio_tracks=json.dumps([{'audio_idx': 0, 'codec': 'aac', 'lang': 'und'}]),
        subtitle_tracks=json.dumps([{'sub_idx': 0, 'codec': 'srt', 'lang': 'eng'}, {'sub_idx': 1, 'codec': 'srt', 'lang': 'spa', 'action': 'drop'}]))
    app_module.config['tvdb_api_key'] = 'private-key-do-not-return'
    result = client.get(f'/api/media/{file_id}').get_json()
    assert result['missing_subtitle_langs'] == ['spa']
    assert result['reencode_threshold_gib'] == 20
    assert result['poster_lookup_available'] is True
    assert 'private-key-do-not-return' not in json.dumps(result)
    assert result['audio_tracks'][0]['lang'] == 'und'


def test_detail_counts_sidecar_languages(client, app_module, insert_media, tmp_path):
    video = tmp_path / 'Movie.mkv'
    (tmp_path / 'Movie.spa.srt').write_text('demo')
    file_id = insert_media(filepath=str(video), subtitle_tracks=json.dumps([{'lang': 'eng', 'codec': 'srt'}]))
    result = client.get(f'/api/media/{file_id}').get_json()
    assert result['sidecar_subtitle_langs'] == ['spa']
    assert result['missing_subtitle_langs'] == []


def test_detail_missing_file_returns_404(client):
    assert client.get('/api/media/999999').status_code == 404
    assert client.post('/api/media/999999/poster').status_code == 404


def test_details_and_artwork_require_authentication(raw_client):
    assert raw_client.get('/api/media/1').status_code == 401
    assert raw_client.post('/api/media/1/poster').status_code == 401


def test_poster_lookups_share_series_artwork_without_crossing_show_names(client, app_module, insert_media, monkeypatch):
    first = insert_media(filename='one.mkv', filepath='/watch/show/one.mkv', media_type='show', show_name='Demo Show', folder_name='Season 01')
    second = insert_media(filename='two.mkv', filepath='/watch/show/two.mkv', media_type='show', show_name='Demo Show', folder_name='Season 02')
    other = insert_media(filename='other.mkv', filepath='/watch/other/other.mkv', media_type='show', show_name='Other Show', folder_name='Season 01')
    app_module.config.update(enable_posters=True, tvdb_api_key='test-key')
    lookup = Mock(return_value='https://artworks.thetvdb.com/demo.jpg')
    monkeypatch.setattr(app_module, 'tvdb_search_poster', lookup)
    response = client.post(f'/api/media/{first}/poster')
    assert response.status_code == 200
    lookup.assert_called_once_with('Demo Show', True)
    assert client.get(f'/api/media/{second}').get_json()['poster_url'] == response.get_json()['poster_url']
    assert client.get(f'/api/media/{other}').get_json()['poster_url'] is None
    client.post(f'/api/media/{second}/poster')
    assert lookup.call_count == 1


def test_existing_sibling_artwork_is_available_without_api_credentials(client, insert_media, monkeypatch, app_module):
    insert_media(filename='cached.mkv', filepath='/watch/shared/cached.mkv', folder_name='Shared', poster_url='https://artworks.thetvdb.com/cached.jpg')
    missing = insert_media(filename='uncached.mkv', filepath='/watch/shared/uncached.mkv', folder_name='Shared')
    lookup = Mock(side_effect=AssertionError('must not query TVDB'))
    monkeypatch.setattr(app_module, 'tvdb_search_poster', lookup)
    assert client.get(f'/api/media/{missing}').get_json()['poster_url'].endswith('cached.jpg')
    assert client.post(f'/api/media/{missing}/poster').status_code == 200
    lookup.assert_not_called()


def test_poster_requires_enabled_setting_and_credentials(client, app_module, insert_media, monkeypatch):
    file_id = insert_media()
    lookup = Mock()
    monkeypatch.setattr(app_module, 'tvdb_search_poster', lookup)
    app_module.config.update(enable_posters=False, tvdb_api_key='test-key')
    assert client.post(f'/api/media/{file_id}/poster').status_code == 409
    app_module.config.update(enable_posters=True, tvdb_api_key='')
    assert client.post(f'/api/media/{file_id}/poster').status_code == 409
    lookup.assert_not_called()


def test_failed_refresh_keeps_existing_artwork(client, app_module, insert_media, monkeypatch):
    file_id = insert_media(poster_url='https://artworks.thetvdb.com/original.jpg')
    app_module.config.update(enable_posters=True, tvdb_api_key='test-key')
    monkeypatch.setattr(app_module, 'tvdb_search_poster', lambda *args: None)
    assert client.post(f'/api/media/{file_id}/poster', json={'refresh': True}).status_code == 404
    assert client.get(f'/api/media/{file_id}').get_json()['poster_url'].endswith('original.jpg')


def test_changing_tvdb_key_invalidates_cached_token(client, app_module):
    app_module._tvdb_token = 'cached-old-token'
    app_module._tvdb_token_expires = 9999999999
    client.post('/api/config', json={'tvdb_api_key': 'new-key'})
    assert app_module._tvdb_token is None
    assert app_module._tvdb_token_expires == 0


def test_poster_search_uses_title_year_and_correct_media_type(app_module, monkeypatch):
    app_module.config.update(enable_posters=True, tvdb_api_key='test-key')
    monkeypatch.setattr(app_module, 'tvdb_get_token', lambda: 'test-token')
    response = Mock(ok=True)
    response.json.return_value = {'data': [
        {'type': 'series', 'image_url': 'https://artworks.thetvdb.com/wrong.jpg'},
        {'type': 'movie', 'image_url': 'https://artworks.thetvdb.com/right.jpg'},
    ]}
    get = Mock(return_value=response)
    monkeypatch.setattr(app_module.requests, 'get', get)
    assert app_module.tvdb_search_poster('Blue Hour (2024)') == 'https://artworks.thetvdb.com/right.jpg'
    assert get.call_args.kwargs['params'] == {'query': 'Blue Hour', 'type': 'movie', 'year': '2024', 'limit': 3}


def test_details_expose_the_real_encoding_track_selection(client, insert_media):
    audio = [{'audio_idx': 0, 'lang': 'eng', 'codec': 'aac'},
             {'audio_idx': 1, 'lang': 'eng', 'codec': 'truehd'},
             {'audio_idx': 2, 'lang': 'nld', 'codec': 'aac'}]
    subtitles = [{'sub_idx': 0, 'lang': 'eng', 'codec': 'srt'},
                 {'sub_idx': 1, 'lang': 'nld', 'codec': 'srt'}]
    file_id = insert_media(audio_tracks=json.dumps(audio), subtitle_tracks=json.dumps(subtitles))
    preview = client.get(f'/api/media/{file_id}').get_json()['encoding_preview']
    assert [track['audio_idx'] for track in preview['audio_tracks']] == [1]
    assert [track['sub_idx'] for track in preview['subtitle_tracks']] == [0]
    assert preview['excluded_tracks'] == 3
