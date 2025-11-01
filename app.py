#!/usr/bin/env python3
"""
Media Monitor - Monitors media directories and sends notifications
"""
import os
import json
import time
import threading
import sqlite3
import subprocess
from pathlib import Path
from queue import Queue
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import Flask, render_template, request, jsonify
import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

app = Flask(__name__)

# Configuration
CONFIG_FILE = os.environ.get('CONFIG_FILE', '/config/config.json')
DB_FILE = os.environ.get('DB_FILE', '/config/processed.db')
WATCH_DIR = os.environ.get('WATCH_DIR', '/watch')
STABILIZE_INTERVAL = int(os.environ.get('STABILIZE_INTERVAL', '10'))
STABILIZE_CHECKS = int(os.environ.get('STABILIZE_CHECKS', '3'))
MAX_WORKERS = int(os.environ.get('MAX_WORKERS', '4'))

# Global configuration
config = {
    'ntfy_server': os.environ.get('NTFY_SERVER', 'https://ntfy.sh'),
    'ntfy_topic': os.environ.get('NTFY_TOPIC', ''),
    'discord_webhook': os.environ.get('DISCORD_WEBHOOK', ''),
    'tvdb_api_key': os.environ.get('TVDB_API_KEY', ''),
    'enable_discord': True,
    'enable_ntfy': True,
    'enable_posters': True,
}

# Thread pool for file processing
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
processing_queue = Queue()


def load_config():
    """Load configuration from file"""
    global config
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r') as f:
                saved_config = json.load(f)
                config.update(saved_config)
                print(f"Loaded configuration from {CONFIG_FILE}")
    except Exception as e:
        print(f"Error loading config: {e}")


def save_config():
    """Save configuration to file"""
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        print(f"Saved configuration to {CONFIG_FILE}")
    except Exception as e:
        print(f"Error saving config: {e}")


def init_db():
    """Initialize the processed files database"""
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS processed_files (
            filepath TEXT PRIMARY KEY,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT,
            size INTEGER
        )
    ''')
    conn.commit()
    conn.close()


def is_already_processed(filepath):
    """Check if file has already been processed"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT filepath FROM processed_files WHERE filepath = ?', (filepath,))
    result = cursor.fetchone()
    conn.close()
    return result is not None


def mark_as_processed(filepath, status, size):
    """Mark file as processed in database"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO processed_files (filepath, status, size, processed_at)
        VALUES (?, ?, ?, ?)
    ''', (filepath, status, size, datetime.now()))
    conn.commit()
    conn.close()


def wait_for_stable_file(filepath):
    """Wait for file to stop changing (copying completed)"""
    last_size = -1
    stable_count = 0
    
    while stable_count < STABILIZE_CHECKS:
        try:
            current_size = os.path.getsize(filepath)
            if current_size == last_size:
                stable_count += 1
            else:
                stable_count = 0
                last_size = current_size
            time.sleep(STABILIZE_INTERVAL)
        except FileNotFoundError:
            return False
    return True


def get_media_info(filepath):
    """Extract media information using ffprobe"""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams', filepath
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return json.loads(result.stdout)
    except Exception as e:
        print(f"Error getting media info: {e}")
        return None


def parse_media_title(filepath):
    """Parse media title from filepath"""
    path = Path(filepath)
    # Try to extract show/movie name from parent directory
    parent = path.parent.name
    filename = path.stem
    
    # Basic parsing - can be enhanced
    return {
        'title': parent if parent != '.' else filename,
        'filename': filename,
        'type': 'episode' if any(x in filename.lower() for x in ['s0', 'e0', 'season', 'episode']) else 'movie'
    }


def search_tvdb(title, media_type):
    """Search TVDB for media poster"""
    if not config.get('tvdb_api_key') or not config.get('enable_posters'):
        return None
    
    try:
        # This is a simplified version - TVDB API requires authentication
        # You would need to implement proper TVDB v4 API authentication
        # For now, we'll use a placeholder
        return None
    except Exception as e:
        print(f"Error searching TVDB: {e}")
        return None


def send_ntfy_notification(title, message, tags=None):
    """Send notification via ntfy"""
    if not config.get('enable_ntfy') or not config.get('ntfy_topic'):
        return
    
    try:
        url = f"{config['ntfy_server']}/{config['ntfy_topic']}"
        headers = {'Title': title}
        if tags:
            headers['Tags'] = tags
        
        response = requests.post(url, data=message, headers=headers)
        print(f"Ntfy notification sent: {response.status_code}")
    except Exception as e:
        print(f"Error sending ntfy notification: {e}")


def send_discord_notification(filepath, status, size, media_info):
    """Send rich notification via Discord webhook"""
    if not config.get('enable_discord') or not config.get('discord_webhook'):
        return
    
    try:
        parsed = parse_media_title(filepath)
        
        # Build Discord embed
        embed = {
            'title': f"🎬 New Media Added: {parsed['title']}",
            'description': f"**File:** {parsed['filename']}",
            'color': 0x00ff00 if status == 'OK' else 0xff9900,
            'fields': [
                {
                    'name': '📊 Status',
                    'value': status,
                    'inline': True
                },
                {
                    'name': '💾 Size',
                    'value': f"{size / (1024**3):.2f} GB",
                    'inline': True
                },
                {
                    'name': '📁 Type',
                    'value': parsed['type'].title(),
                    'inline': True
                }
            ],
            'timestamp': datetime.utcnow().isoformat(),
            'footer': {
                'text': 'Media Monitor'
            }
        }
        
        # Add media details if available
        if media_info:
            format_info = media_info.get('format', {})
            video_streams = [s for s in media_info.get('streams', []) if s.get('codec_type') == 'video']
            audio_streams = [s for s in media_info.get('streams', []) if s.get('codec_type') == 'audio']
            
            if video_streams:
                video = video_streams[0]
                embed['fields'].append({
                    'name': '🎥 Video',
                    'value': f"{video.get('codec_name', 'unknown')} - {video.get('width', '?')}x{video.get('height', '?')}",
                    'inline': True
                })
            
            if audio_streams:
                audio = audio_streams[0]
                embed['fields'].append({
                    'name': '🔊 Audio',
                    'value': f"{audio.get('codec_name', 'unknown')} - {len(audio_streams)} track(s)",
                    'inline': True
                })
            
            embed['fields'].append({
                'name': '⏱️ Duration',
                'value': f"{float(format_info.get('duration', 0)) / 60:.1f} minutes",
                'inline': True
            })
        
        # Try to add poster
        poster_url = search_tvdb(parsed['title'], parsed['type'])
        if poster_url:
            embed['thumbnail'] = {'url': poster_url}
        
        payload = {
            'embeds': [embed]
        }
        
        response = requests.post(config['discord_webhook'], json=payload)
        print(f"Discord notification sent: {response.status_code}")
    except Exception as e:
        print(f"Error sending Discord notification: {e}")


def analyze_file(filepath):
    """Analyze a media file and send notifications"""
    print(f"[{threading.current_thread().name}] Analyzing: {filepath}")
    
    # Skip if already processed
    if is_already_processed(filepath):
        print(f"Already processed: {filepath}")
        return
    
    # Wait for file to be stable
    print(f"Waiting for file to stabilize: {filepath}")
    if not wait_for_stable_file(filepath):
        print(f"File disappeared: {filepath}")
        return
    
    try:
        # Get file info
        size = os.path.getsize(filepath)
        media_info = get_media_info(filepath)
        
        if not media_info:
            print(f"Could not get media info for: {filepath}")
            return
        
        # Analyze status
        status = []
        needs_remux = False
        
        # Check for missing language tags
        audio_missing = sum(1 for s in media_info.get('streams', [])
                          if s.get('codec_type') == 'audio' and not s.get('tags', {}).get('language'))
        sub_missing = sum(1 for s in media_info.get('streams', [])
                        if s.get('codec_type') == 'subtitle' and not s.get('tags', {}).get('language'))
        
        if audio_missing > 0 or sub_missing > 0:
            needs_remux = True
        
        # Check file size (>20GB)
        if size > 20 * 1024 * 1024 * 1024:
            status.append('RE-ENCODE')
        
        if needs_remux:
            status.append('REMUX')
        
        if not status:
            status.append('OK')
        
        status_str = ' | '.join(status)
        
        # Send notifications
        parsed = parse_media_title(filepath)
        format_name = media_info.get('format', {}).get('format_name', 'unknown')
        
        # Ntfy notification
        ntfy_message = f"📦 File: {os.path.basename(filepath)}\n🎯 Result: {status_str}"
        send_ntfy_notification(parsed['title'], ntfy_message, format_name)
        
        # Discord notification
        send_discord_notification(filepath, status_str, size, media_info)
        
        # Mark as processed
        mark_as_processed(filepath, status_str, size)
        
        print(f"✓ Processed: {filepath} - {status_str}")
        
    except Exception as e:
        print(f"Error analyzing file {filepath}: {e}")


class MediaFileHandler(FileSystemEventHandler):
    """Handler for file system events"""
    
    def on_created(self, event):
        if not event.is_directory and event.src_path.lower().endswith(('.mkv', '.mp4', '.avi', '.mov', '.m4v')):
            print(f"Detected new file: {event.src_path}")
            executor.submit(analyze_file, event.src_path)
    
    def on_moved(self, event):
        if not event.is_directory and event.dest_path.lower().endswith(('.mkv', '.mp4', '.avi', '.mov', '.m4v')):
            print(f"Detected moved file: {event.dest_path}")
            executor.submit(analyze_file, event.dest_path)


def start_monitoring():
    """Start the file system monitoring"""
    print(f"Starting monitor on: {WATCH_DIR}")
    event_handler = MediaFileHandler()
    observer = Observer()
    observer.schedule(event_handler, WATCH_DIR, recursive=True)
    observer.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


# Flask routes
@app.route('/')
def index():
    """Main configuration page"""
    return render_template('index.html', config=config)


@app.route('/api/config', methods=['GET'])
def get_config():
    """Get current configuration"""
    return jsonify(config)


@app.route('/api/config', methods=['POST'])
def update_config():
    """Update configuration"""
    global config
    data = request.json
    config.update(data)
    save_config()
    return jsonify({'status': 'success', 'config': config})


@app.route('/api/test/ntfy', methods=['POST'])
def test_ntfy():
    """Test ntfy notification"""
    send_ntfy_notification('Test Notification', '🎬 This is a test from Media Monitor!', 'test')
    return jsonify({'status': 'success', 'message': 'Test notification sent'})


@app.route('/api/test/discord', methods=['POST'])
def test_discord():
    """Test Discord notification"""
    try:
        embed = {
            'title': '🎬 Test Notification',
            'description': 'This is a test from Media Monitor!',
            'color': 0x00ff00,
            'timestamp': datetime.utcnow().isoformat(),
            'footer': {'text': 'Media Monitor'}
        }
        response = requests.post(config['discord_webhook'], json={'embeds': [embed]})
        return jsonify({'status': 'success', 'message': f'Test sent (HTTP {response.status_code})'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Get processing statistics"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM processed_files')
    total = cursor.fetchone()[0]
    cursor.execute('SELECT status, COUNT(*) FROM processed_files GROUP BY status')
    by_status = dict(cursor.fetchall())
    conn.close()
    
    return jsonify({
        'total': total,
        'by_status': by_status,
        'watch_dir': WATCH_DIR,
        'max_workers': MAX_WORKERS
    })


if __name__ == '__main__':
    # Initialize
    init_db()
    load_config()
    
    # Start monitoring in a separate thread
    monitor_thread = threading.Thread(target=start_monitoring, daemon=True)
    monitor_thread.start()
    
    # Start Flask web UI
    port = int(os.environ.get('PORT', '5000'))
    app.run(host='0.0.0.0', port=port, debug=False)
