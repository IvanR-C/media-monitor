# GPU Encoding

Media Monitor can re-encode video files to HEVC (H.265) in-place using your NVIDIA GPU via `hevc_nvenc`. This dramatically reduces file size (typically 60–80% smaller than a BluRay remux) while preserving quality.

---

## Requirements

| Requirement | Notes |
|---|---|
| NVIDIA GPU | GTX 10xx (Pascal) or newer |
| NVIDIA driver | Installed on the **host** machine |
| NVIDIA Container Toolkit | Required to expose the GPU inside Docker — [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) |

The `docker-compose.yml` must include the GPU reservation block:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - count: all
          capabilities: [gpu, video]
```

> CPU encoding (libx265) is **not currently supported** but is planned for a future release.

---

## How to Queue an Encode

1. Open the **Library** view
2. Find the file you want to encode — files flagged `RE-ENCODE` are candidates
3. Click the **···** menu on the row → **Queue Encode**
4. The job appears in the **Encode Queue** panel at the bottom of the page

You can also select multiple files with the checkboxes and use the bulk **Queue Encode** button in the toolbar.

---

## What the Encoder Does

For each queued file, the encoder:

1. Builds an ffmpeg command with these settings:
   - Video: `hevc_nvenc`, preset `p4`, CQ `20`, profile `main10`
   - Audio: copies the **highest-quality track per approved language** (see Language Filtering below)
   - Subtitles: copies all tracks in approved languages
   - Resolution: downscales to 1080p if the source is 4K
2. Writes output to a `.encoding.tmp` file alongside the original
3. Streams ffmpeg's structured progress output to track percentage, speed, and ETA
4. On success: replaces the original file with the encoded output
5. On failure or cancellation: deletes the temp file, marks the job failed

Encoding is **sequential** — one job at a time to maximise GPU utilisation.

---

## Encode Settings

| Setting | Value |
|---|---|
| Video codec | `hevc_nvenc` (NVIDIA H.265) |
| Quality | CQ 20 (constant quality, visually lossless for most content) |
| Preset | `p4` (balanced speed/quality) |
| Profile | `main10` |
| RC lookahead | 20 frames |
| Max resolution | 1080p (4K sources are downscaled) |
| Audio | Copy (passthrough, no re-encode) |
| Subtitles | Copy (passthrough) |
| Container | Matroska (`.mkv`) |

---

## Language Filtering

During encoding, only tracks in the approved sets are included in the output:

| Track type | Kept |
|---|---|
| Audio | English (`eng`), Spanish (`spa`), Japanese (`jpn`) |
| Subtitles | English (`eng`), Spanish (`spa`) |

For audio, **only the highest-quality track per language** is kept. Quality ranking (highest first): TrueHD · FLAC · DTS · E-AC3 · AC-3 · AAC · MP3. For example, if a file has both TrueHD 7.1 and AC-3 5.1 in English, only the TrueHD is kept.

> These language lists are hardcoded. Configurable language selection from the UI is planned for a future release.

---

## Estimated Size

For files not yet encoded, the Library table shows an estimated post-encode size in green (e.g. `→ 4.2 GB`). This estimate is calculated from the source bitrate, codec, resolution, and audio tracks — actual results will vary.

---

## Cancelling a Job

Click the **✕** button on any queued or in-progress job in the Encode Queue panel. The temp file is deleted immediately. If a job appears stuck (no progress for an extended period), it will be automatically killed and marked as failed.

---

## Troubleshooting Encoding

**"Failed to initialise NVENC" or similar ffmpeg error:**
Run `nvidia-smi` on the host to confirm the driver is working. Confirm the `deploy.resources` block is in your `docker-compose.yml`. Check the in-app log viewer for the full ffmpeg stderr output.

**Job stuck at a fixed percentage:**
The encoder has a built-in hang detector. If no progress is received for 5 minutes, the job is automatically killed and marked failed. You should see an error in the logs.

**Output file is larger than the original:**
This can happen if the source is already well-compressed HEVC at a lower bitrate than CQ 20 produces. The encode job will still complete — you can keep the original in that case by not replacing it (but currently replacement is automatic on success).

**PGS subtitles show `[255][255][255][255]` codec tag in the output:**
This is a cosmetic artefact caused by the PGS stream not encoding display resolution in the MKV header (a known ffmpeg 4.4 limitation). The subtitles will play correctly in Plex, Jellyfin, VLC, and MPC-HC.
