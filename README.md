# 🎬 Media Monitor

A modern, multithreaded media library monitor that sends beautiful notifications when new content is added. Perfect for monitoring your Plex, Jellyfin, or any media server library.

## ✨ Features

### 🚀 Core Features
- **Multithreaded Processing**: Process multiple files simultaneously without waiting for copies to complete
- **Web UI**: Beautiful configuration interface accessible via browser
- **Dual Notifications**: Support for both Ntfy and Discord notifications
- **Rich Discord Embeds**: Includes file details, media info, codec details, and more
- **Smart File Tracking**: SQLite database prevents duplicate notifications
- **File Stability Detection**: Waits for files to finish copying before processing
- **Automatic Analysis**: Extracts codec info, resolution, audio tracks, duration, etc.

### 📊 Analysis Features
- Detects files that need re-encoding (>20GB)
- Identifies files missing language tags (need remuxing)
- Extracts comprehensive media metadata (codecs, resolution, audio tracks, subtitles)
- Calculates file size and duration

### 🎨 Notification Styles
- **Ntfy**: Simple, lightweight push notifications
- **Discord**: Rich embeds with:
  - Media type detection (Movie vs Episode)
  - Status indicators (OK, REMUX, RE-ENCODE)
  - File size in GB
  - Video codec and resolution
  - Audio codec and track count
  - Duration in minutes
  - Timestamps
  - (Optional) TVDB poster images

## 🏗️ Architecture Improvements

### Multithreading
The new Python-based implementation uses:
- `ThreadPoolExecutor` for parallel file processing (default: 4 workers)
- `watchdog` for efficient file system monitoring
- Non-blocking processing queue
- Each file gets its own thread, so large files don't block small ones

### Database
- SQLite database tracks processed files
- Prevents duplicate notifications
- Stores processing history with timestamps
- Query statistics via web UI

## 📦 Installation

### Using Docker Compose (Recommended)

1. Clone or download these files to a directory
2. Edit `docker-compose.yml` to set your media path:
   ```yaml
   volumes:
     - /path/to/your/media:/watch:ro
   ```
3. Build and start:
   ```bash
   docker-compose up -d
   ```
4. Access web UI at `http://localhost:5000`

### Using Docker

```bash
# Build the image
docker build -t media-monitor .

# Run the container
docker run -d \
  --name media-monitor \
  -p 5000:5000 \
  -v /path/to/your/media:/watch:ro \
  -v ./config:/config \
  media-monitor
```

## ⚙️ Configuration

### Web UI (Recommended)
1. Open `http://localhost:5000` in your browser
2. Configure your notification settings:
   - **Ntfy**: Server URL and topic name
   - **Discord**: Webhook URL from your Discord server
   - **TVDB**: API key for poster images (optional)
3. Test your notifications with the test buttons
4. Save your configuration

### Environment Variables
You can also configure via environment variables:

```bash
# Monitoring settings
WATCH_DIR=/watch                    # Directory to monitor
MAX_WORKERS=4                       # Number of parallel processing threads
STABILIZE_INTERVAL=10               # Seconds between file size checks
STABILIZE_CHECKS=3                  # Number of stable checks required

# Ntfy settings
NTFY_SERVER=https://ntfy.sh
NTFY_TOPIC=my-media-notifications

# Discord settings
DISCORD_WEBHOOK=https://discord.com/api/webhooks/...

# TVDB settings (optional)
TVDB_API_KEY=your-api-key

# Web UI
PORT=5000
```

## 🔔 Setting Up Notifications

### Ntfy Setup
1. Choose a unique topic name (e.g., `my-media-library-xyz123`)
2. Download the ntfy app on your phone
3. Subscribe to your topic
4. Enter the topic in the web UI

### Discord Setup
1. Go to your Discord server settings
2. Navigate to Integrations → Webhooks
3. Click "New Webhook"
4. Choose a channel for notifications
5. Copy the webhook URL
6. Paste it in the web UI

### TVDB Setup (Optional - for poster images)
1. Create account at [TheTVDB.com](https://thetvdb.com/)
2. Go to [API Information](https://thetvdb.com/api-information)
3. Subscribe to a plan (there's a free tier)
4. Get your API key
5. Enter it in the web UI

## 📁 File Structure

```
.
├── app.py                  # Main application
├── templates/
│   └── index.html         # Web UI
├── requirements.txt       # Python dependencies
├── Dockerfile            # Container definition
├── docker-compose.yml    # Docker Compose config
├── config/               # Persistent configuration (created automatically)
│   ├── config.json      # Saved settings
│   └── processed.db     # Processing history
└── README.md            # This file
```

## 🎯 How It Works

1. **File Detection**: Watchdog monitors the specified directory for new `.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v` files
2. **Stability Check**: Waits for file to stop changing (copy completed)
3. **Parallel Processing**: Spawns a new thread for analysis
4. **Media Analysis**: Uses ffprobe to extract metadata
5. **Status Determination**:
   - `OK`: File is good
   - `REMUX`: Missing language tags
   - `RE-ENCODE`: File is >20GB
6. **Notification Dispatch**: Sends to enabled notification services
7. **Database Update**: Marks file as processed to prevent duplicates

## 🔧 Customization

### Changing File Size Threshold
Edit `app.py` line containing:
```python
if size > 20 * 1024 * 1024 * 1024:  # 20GB
```

### Adding More File Types
Edit the file extensions in `MediaFileHandler`:
```python
if not event.is_directory and event.src_path.lower().endswith(('.mkv', '.mp4', '.avi', '.mov', '.m4v', '.wmv')):
```

### Adjusting Worker Threads
Set `MAX_WORKERS` environment variable or edit default in `app.py`

## 📊 Web UI Features

- **Real-time Statistics**: See total files processed, status breakdown, worker count
- **Configuration Management**: Update settings without container restart
- **Test Buttons**: Verify notification setup instantly
- **Persistent Storage**: Configuration saved to `/config` volume

## 🐛 Troubleshooting

### Notifications not sending
1. Check web UI configuration
2. Use test buttons to verify settings
3. Check container logs: `docker logs media-monitor`

### Files not being detected
1. Verify volume mount in docker-compose.yml
2. Check `WATCH_DIR` environment variable
3. Ensure file extensions are supported

### Performance issues
1. Reduce `MAX_WORKERS` if system is struggling
2. Increase `STABILIZE_INTERVAL` for slower network copies
3. Check Docker resource limits

## 📈 Performance

- **Concurrent Processing**: Process 4+ files simultaneously
- **Low Resource Usage**: Alpine Linux base (~200MB image)
- **Efficient Monitoring**: watchdog uses inotify (no polling)
- **Smart Caching**: Only processes each file once

## 🆚 Comparison with Original

| Feature | Original (Bash) | New (Python) |
|---------|----------------|--------------|
| Threading | ❌ Sequential | ✅ Parallel (4+ workers) |
| Web UI | ❌ No | ✅ Yes |
| Discord | ❌ No | ✅ Rich embeds |
| Database | Text file | SQLite |
| Config UI | ❌ No | ✅ Browser-based |
| Statistics | ❌ No | ✅ Real-time |
| Testing | ❌ Manual | ✅ Built-in test buttons |

## 🤝 Contributing

Feel free to submit issues, fork the repository, and create pull requests for any improvements.

## 📝 License

MIT License - feel free to use and modify as needed.

## 🎉 Example Notifications

### Discord Notification
```
🎬 New Media Added: Breaking Bad

File: Breaking.Bad.S01E01.1080p.mkv

📊 Status: OK
💾 Size: 2.34 GB  
📁 Type: Episode
🎥 Video: h264 - 1920x1080
🔊 Audio: aac - 2 track(s)
⏱️ Duration: 47.3 minutes
```

### Ntfy Notification
```
📦 File: Breaking.Bad.S01E01.1080p.mkv
🎯 Result: OK
```

---

Made with ❤️ for media enthusiasts
