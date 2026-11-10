# AI assistants (MCP)

Media Monitor has a [Model Context Protocol](https://modelcontextprotocol.io) endpoint, so
assistants such as Claude can search the library, read tracks and logs, and queue jobs for you.

- **Endpoint:** `http(s)://<your-host>:5000/mcp`
- **Transport:** Streamable HTTP (MCP spec 2025-03-26 and later). Each request gets a plain
  JSON reply; the server is stateless and doesn't open a server-to-client stream.
- **Auth:** `Authorization: Bearer <token>` header. The token is separate from your dashboard
  password and is stored only as a SHA-256 hash in `config/auth.json`.

## Turn it on

1. Open **Settings → AI assistants (MCP)**.
2. Choose an access level:
   - **Read-only**: only the tools marked _read_ below. Actions aren't listed and are refused.
   - **Full control**: every tool.
3. Select **Create access token** and copy it. It's shown only once.
4. Add the server to your assistant. The Settings page fills in your URL and token.

Claude Code:

```bash
claude mcp add --transport http media-monitor http://media-monitor.local:5000/mcp --header "Authorization: Bearer mm_…"
```

Clients that take a JSON config (Cursor, VS Code, and others):

```json
{
  "mcpServers": {
    "media-monitor": {
      "type": "http",
      "url": "http://media-monitor.local:5000/mcp",
      "headers": { "Authorization": "Bearer mm_…" }
    }
  }
}
```

There's one token at a time. **Create new token** replaces it (the old one stops working at
once), and the trash button turns MCP access off.

## Tools

Media files are addressed by the numeric `file_id` that `search_media` returns. Jobs run in the
background and return a job id that `list_jobs` follows.

| Tool | Access | What it does |
|---|---|---|
| `get_library_overview` | read | Counts by status for movies and shows, library size, queue state, scan progress |
| `search_media` | read | Filter (needs encoding / remux / missing language / alerts / …), type and text search, paged |
| `get_media_details` | read | All tracks, required and missing subtitle languages, sidecars, encode preview |
| `list_alerts` | read | Disc images, unprocessable files, movie folders with several videos |
| `list_jobs` | read | Encode-queue and translation-queue jobs with progress, ETA and errors |
| `get_recent_logs` | read | Server log ring buffer, filtered by level and text, with `since` polling |
| `list_external_subtitles` | read | Sidecar subtitle files next to a media file |
| `get_settings` | read | Current settings and working encoders. API keys, webhooks and the Ntfy topic show only as set / not set |
| `list_backups` | read | Backed-up originals and the retention period |
| `preview_fix_anime` | read | Fix Anime dry run: chosen tracks, output file, or why a file would be skipped |
| `scan_library` | full | Rescan one folder (by `file_ids`), or the whole library from scratch |
| `refresh_media_file` | full | Re-read one file with ffprobe |
| `recalculate_statuses` | full | Re-apply status rules without re-reading files |
| `queue_encode` | full | Queue re-encodes |
| `update_tracks` | full | Set track languages and keep/drop, then queue a remux |
| `rip_disc_image` | full | Queue a rip of an ISO/IMG into an MKV |
| `translate_subtitle` | full | Queue AI translation (OCR first for PGS) and mux the result in |
| `extract_subtitle` | full | Queue extraction of a track to SRT, OCR if needed |
| `get_extracted_subtitle` | full | Read a finished extraction's SRT text (works once per job) |
| `mux_external_subtitle` | full | Embed a sidecar subtitle file as a new track |
| `queue_fix_anime` | full | Queue Fix Anime for files, a season or a show |
| `cancel_job` | full | Cancel one encode or translation job |
| `control_queue` | full | Pause, resume, cancel all, or clear finished jobs on either queue |
| `lookup_poster` | full | Fetch TVDB poster artwork |
| `purge_backups` | full | Delete expired backups, or all of them |
| `send_test_notification` | full | Send a test message through Ntfy or Discord |

Each tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`), so clients can ask before running destructive ones. Settings can't be
changed over MCP, and actions are written to the server log as `[mcp] <tool> …`.

## Security notes

- Treat the token like a password. Anyone with a full-control token can rewrite and delete
  media files through the same actions the dashboard offers.
- Serve Media Monitor over HTTPS (a reverse proxy or Tailscale Serve) if an assistant connects
  from outside your LAN. Over plain HTTP the token travels unencrypted.
- Browser requests from another site are refused: a request carrying an `Origin` header must
  match the host it was sent to.
- claude.ai custom connectors need OAuth, which this endpoint doesn't offer. Use Claude Code,
  Claude Desktop through a remote-MCP bridge, or another client that can send a header.
