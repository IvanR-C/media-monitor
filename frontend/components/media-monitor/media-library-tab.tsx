"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { MediaTypeSwitch } from "./media-type-switch";
import { FilterBar } from "./filter-bar";
import { MediaTable } from "./media-table";
import { CombinedQueue } from "./encode-queue";
import { AppLogs } from "./app-logs";
import { toast } from "sonner";

export type MediaType = "movie" | "show";
export type FilterType =
  | "all"
  | "needs_encoding"
  | "needs_remux"
  | "missing_lang"
  | "queued"
  | "done"
  | "alerts";

export interface MediaFile {
  id: number;
  folder_name: string;
  filename: string;
  size_bytes?: number;
  size_gb: number;
  estimated_size_gb?: number;
  video_width?: number;
  video_height?: number;
  video_codec?: string;
  audio_tracks: AudioTrack[];
  subtitle_tracks: SubtitleTrack[];
  status: string;
  encode_status?: string;
  encode_progress?: number;
  encode_job_type?: "encode" | "remux" | "rip";
  translate_status?: string;
  translate_progress?: number;
  poster_url?: string;
  media_type: "movie" | "show";
  show_name?: string;
  season_episode?: string;
  has_sibling_videos?: number;
  // Disc images (.iso/.img): set when the file is an analyzable DVD/Blu-ray.
  disc_type?: "dvd" | "bluray" | null;
  disc_title?: number | null;
  disc_playlist?: number | null;
}

export interface AudioTrack {
  audio_idx: number;
  codec: string;
  lang?: string;
  channels?: number;
  title?: string;
  action?: "keep" | "drop";
}

export interface SubtitleTrack {
  sub_idx: number;
  codec: string;
  lang?: string;
  title?: string;
  action?: "keep" | "drop";
}

interface LibraryStatsData {
  total_files: number;
  total_bytes: number;
  needs_encoding: number;
  needs_remux: number;
  missing_lang: number;
  encoding_active: number;
  done_count: number;
  alerts_count: number;
}

interface MediaLibraryTabProps {
  scan: {
    isScanning: boolean;
    scanProgress?: { scanned: number; total: number };
    lastScanResult?: { scanned: number; total: number };
    onScan: () => void;
    onFolderScan: (fileIds: number[]) => void;
  };
}

export function MediaLibraryTab({ scan }: MediaLibraryTabProps) {
  const { isScanning, scanProgress, lastScanResult, onScan, onFolderScan } =
    scan;
  const [mediaType, setMediaType] = useState<MediaType>("movie");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showLogs, setShowLogs] = useState(false);
  // Single source of truth: the entire library for both movies and shows. Tab
  // switches, filter pills, and search all derive from this in-memory list, so
  // no network round-trip is needed for any of those interactions.
  const [allFiles, setAllFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input — only the in-memory filter recomputes, no network.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 150);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Track the most recent in-flight fetch so a stale poll response can't
  // clobber a fresh user-action refresh.
  const inflightRef = useRef<AbortController | null>(null);
  const allFilesRef = useRef<MediaFile[]>([]);
  allFilesRef.current = allFiles;

  const fetchMedia = useCallback(async (silent = false) => {
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
    const showSpinner = !silent && allFilesRef.current.length === 0;
    if (showSpinner) setLoading(true);
    try {
      const r = await fetch(`/api/media?type=all`, { signal: ac.signal });
      const data = await r.json();
      if (inflightRef.current !== ac) return;
      setAllFiles(data.files ?? []);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      if (!silent) toast.error("Failed to load media library");
    } finally {
      if (inflightRef.current === ac) {
        inflightRef.current = null;
        if (showSpinner) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchMedia();
    return () => {
      inflightRef.current?.abort();
      inflightRef.current = null;
    };
  }, [fetchMedia]);

  // Files for the currently-selected media type (derives stats and table rows)
  const typedFiles = useMemo(
    () => allFiles.filter(f => f.media_type === mediaType),
    [allFiles, mediaType],
  );

  // Per-mediaType aggregates — all computed from the in-memory list so
  // switching tabs, typing in search, or clicking filter pills costs nothing.
  const stats = useMemo<LibraryStatsData>(() => {
    let needs_encoding = 0, needs_remux = 0, missing_lang = 0;
    let encoding_active = 0, done_count = 0, alerts_count = 0;
    let total_bytes = 0;
    for (const f of typedFiles) {
      const status = f.status ?? "";
      const enc = f.encode_status;
      const queueable = enc == null || enc === "failed";
      if (status.includes("RE-ENCODE") && queueable)  needs_encoding++;
      if (status.includes("REMUX") && queueable)       needs_remux++;
      if (status.includes("MISSING LANG"))             missing_lang++;
      if (enc === "queued" || enc === "encoding")      encoding_active++;
      if (enc === "done")                              done_count++;
      if (f.has_sibling_videos === 1 || status === "UNPROCESSABLE") alerts_count++;
      total_bytes += f.size_bytes ?? 0;
    }
    return {
      total_files: typedFiles.length,
      total_bytes,
      needs_encoding,
      needs_remux,
      missing_lang,
      encoding_active,
      done_count,
      alerts_count,
    };
  }, [typedFiles]);

  // Apply the active filter pill + search to typedFiles. All in-memory.
  const files = useMemo(() => {
    let f = typedFiles;
    switch (filter) {
      case "needs_encoding":
        f = f.filter(x => x.status?.includes("RE-ENCODE")
                       && (x.encode_status == null || x.encode_status === "failed"));
        break;
      case "needs_remux":
        f = f.filter(x => x.status?.includes("REMUX")
                       && (x.encode_status == null || x.encode_status === "failed"));
        break;
      case "missing_lang":
        f = f.filter(x => x.status?.includes("MISSING LANG"));
        break;
      case "queued":
        f = f.filter(x => x.encode_status === "queued" || x.encode_status === "encoding");
        break;
      case "done":
        f = f.filter(x => x.encode_status === "done");
        break;
      case "alerts":
        f = f.filter(x => x.has_sibling_videos === 1 || x.status === "UNPROCESSABLE");
        break;
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      f = f.filter(x =>
        (x.folder_name?.toLowerCase().includes(q)) ||
        (x.filename?.toLowerCase().includes(q)) ||
        (x.show_name?.toLowerCase().includes(q))
      );
    }
    return f;
  }, [typedFiles, filter, debouncedSearch]);

  // Auto-refresh every 3 s while any encode or translation job is active.
  // Polls the full library (silent) so all derived state stays current.
  const hasActiveJobs = useMemo(
    () => allFiles.some(f =>
      f.encode_status === "encoding" ||
      f.encode_status === "queued" ||
      (f.translate_status != null &&
        !["done", "failed", "cancelled"].includes(f.translate_status))),
    [allFiles],
  );
  useEffect(() => {
    if (!hasActiveJobs) return;
    const id = setInterval(() => fetchMedia(true), 3000);
    return () => clearInterval(id);
  }, [hasActiveJobs, fetchMedia]);

  const filterCounts = useMemo(
    () => ({
      all:            stats.total_files,
      needs_encoding: stats.needs_encoding,
      needs_remux:    stats.needs_remux,
      missing_lang:   stats.missing_lang,
      queued:         stats.encoding_active,
      done:           stats.done_count,
      alerts:         stats.alerts_count,
    }),
    [stats],
  );

  // When the scan finishes (isScanning flips true→false) reload the table so
  // the clean-rescan results are immediately visible.
  const prevScanningRef = useRef(false);
  useEffect(() => {
    if (prevScanningRef.current && !isScanning) {
      fetchMedia();
    }
    prevScanningRef.current = isScanning;
  }, [isScanning, fetchMedia]);

  const handleEnqueueSelected = async () => {
    if (selectedIds.size === 0) return;
    try {
      const r = await fetch("/api/encode/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: Array.from(selectedIds) }),
      });
      const data = await r.json();
      toast.success(`Queued ${data.count} file(s) for encoding`);
      setSelectedIds(new Set());
      fetchMedia();
    } catch {
      toast.error("Failed to queue files");
    }
  };

  const handleEnqueueSingle = async (id: number) => {
    try {
      const r = await fetch("/api/encode/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: [id] }),
      });
      const data = await r.json();
      if (data.count > 0) {
        toast.success("Queued for encoding");
        fetchMedia();
      } else {
        toast.info("Already queued");
      }
    } catch {
      toast.error("Failed to queue file");
    }
  };

  const handleRipDisc = async (id: number) => {
    try {
      const r = await fetch(`/api/media/${id}/rip`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        toast.success(`Rip queued → ${data.output}`);
        setFilter("queued");
        fetchMedia(true);
      } else {
        toast.error(data.error || "Failed to queue rip");
      }
    } catch {
      toast.error("Failed to queue rip");
    }
  };

  const handleTranslateSingle = async (id: number, subIdx: number) => {
    try {
      const r = await fetch(`/api/media/${id}/translate-subtitle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub_idx: subIdx }),
      });
      const data = await r.json();
      if (r.ok) {
        toast.success("Translation queued");
        fetchMedia(true);
      } else {
        toast.error(data.error || "Failed to queue translation");
      }
    } catch {
      toast.error("Failed to queue translation");
    }
  };

  const handleAssignTracks = async (
    fileId: number,
    audio: any[],
    subs: any[],
  ) => {
    let r: Response;
    try {
      r = await fetch(`/api/media/${fileId}/assign-tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, subtitles: subs }),
      });
    } catch {
      toast.error("Failed to save track languages");
      throw new Error("network");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) {
      toast.error(data.error || "Failed to save track languages");
      throw new Error(data.error || "save failed");
    }
    if (r.status === 207) {
      // Assignments saved but remux queue failed
      toast.warning(
        data.error || "Languages saved but remux could not be queued",
      );
    } else if (data.status === "saved") {
      // Disc image: choices saved, no remux (rip applies them instead)
      toast.success("Track selection saved — use Rip to apply");
    } else {
      toast.success("Languages saved — remux queued to apply changes to file");
    }
    // Switch to the "queued" filter so the user can watch the just-queued
    // remux progress, then pull the freshest server state in.
    setFilter("queued");
    fetchMedia(true);
  };

  const TEXT_SUB_CODECS_EXCLUDE = new Set([
    "hdmv_pgs_subtitle",
    "dvd_subtitle",
    "dvb_subtitle",
    "dvb_teletext",
    "eia_608",
  ]);

  const handleTranslateSelected = async () => {
    if (selectedIds.size === 0) return;
    let queued = 0;
    let skipped = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) {
        skipped++;
        continue;
      }
      const textSubs = file.subtitle_tracks.filter(
        (t) => !TEXT_SUB_CODECS_EXCLUDE.has(t.codec),
      );
      if (textSubs.length === 0) {
        skipped++;
        continue;
      }
      // Prefer first non-eng/spa track, fall back to first text track
      const target =
        textSubs.find(
          (t) => !["eng", "spa"].includes((t.lang ?? "").toLowerCase()),
        ) ?? textSubs[0];
      try {
        const r = await fetch(`/api/media/${id}/translate-subtitle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sub_idx: target.sub_idx }),
        });
        if (r.ok) queued++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (queued > 0) {
      toast.success(`Queued ${queued} file(s) for translation`);
      fetchMedia(true);
    }
    if (skipped > 0)
      toast.info(`${skipped} file(s) skipped (no translatable subtitle)`);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk select/deselect without stale-closure issues
  const selectMany = (ids: number[], select: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === files.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(files.map((f) => f.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  return (
    <div className="flex min-h-[420px] flex-col md:h-[calc(100vh-152px)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <MediaTypeSwitch value={mediaType} onChange={setMediaType} />
          <LibrarySummary stats={stats} />
        </div>
        <FilterBar
          value={filter}
          onChange={setFilter}
          counts={filterCounts}
          isScanning={isScanning}
          scanProgress={scanProgress}
          lastScanResult={lastScanResult}
          onScan={onScan}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      </div>

      {/* Scrollable table area */}
      <div className="mt-4 min-h-0 flex-1 overflow-hidden">
        <MediaTable
          files={files}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          onToggleSelectAll={toggleSelectAll}
          onClearSelection={clearSelection}
          onEnqueue={handleEnqueueSingle}
          onEnqueueSelected={handleEnqueueSelected}
          onRip={handleRipDisc}
          onTranslate={handleTranslateSingle}
          onTranslateSelected={handleTranslateSelected}
          onAssignTracks={handleAssignTracks}
          onFolderScan={onFolderScan}
          onScanLibrary={onScan}
          mediaType={mediaType}
          loading={loading}
          totalFiles={stats.total_files}
          isScanning={isScanning}
        />
      </div>

      {/* Terminal-style bottom panel */}
      <div className="mt-3 shrink-0">
        <CombinedQueue />
        <AppLogs show={showLogs} onToggle={() => setShowLogs(!showLogs)} />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes < 1e12) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${(bytes / 1e12).toFixed(2)} TB`;
}

function LibrarySummary({ stats }: { stats: LibraryStatsData }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        Total files{" "}
        <span className="font-medium text-foreground">
          {stats.total_files.toLocaleString()}
        </span>
      </span>
      <span className="hidden h-3 w-px bg-border/70 sm:block" />
      <span>
        Size{" "}
        <span className="font-medium text-foreground">
          {formatBytes(stats.total_bytes)}
        </span>
      </span>
    </div>
  );
}
