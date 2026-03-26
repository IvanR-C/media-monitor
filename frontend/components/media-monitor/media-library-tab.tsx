"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { LibraryStats } from "./library-stats";
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
  encode_job_type?: "encode" | "remux";
  translate_status?: string;
  translate_progress?: number;
  poster_url?: string;
  media_type: "movie" | "show";
  show_name?: string;
  season_episode?: string;
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
  encoding_active: number;
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
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [stats, setStats] = useState<LibraryStatsData>({
    total_files: 0,
    total_bytes: 0,
    needs_encoding: 0,
    encoding_active: 0,
  });
  const [loading, setLoading] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input — only trigger fetchMedia 300 ms after the user stops typing
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchMedia = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams({ type: mediaType, filter });
        if (debouncedSearch) params.set("search", debouncedSearch);
        const data = await fetch(`/api/media?${params}`).then((r) => r.json());
        setFiles(data.files ?? []);
        if (data.stats) setStats(data.stats);
      } catch {
        if (!silent) toast.error("Failed to load media library");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [mediaType, filter, debouncedSearch],
  );

  useEffect(() => {
    fetchMedia();
  }, [fetchMedia]);

  // Auto-refresh every 3 s while any encode or translation job is active — silent so the table never blinks
  const hasActiveJobs = files.some(
    (f) =>
      f.encode_status === "encoding" ||
      f.encode_status === "queued" ||
      (f.translate_status != null &&
        !["done", "failed", "cancelled"].includes(f.translate_status)),
  );
  useEffect(() => {
    if (!hasActiveJobs) return;
    const id = setInterval(() => fetchMedia(true), 3000);
    return () => clearInterval(id);
  }, [hasActiveJobs, fetchMedia]);

  // Recompute filter counts from current file list (approximate — full counts need separate query)
  const filterCounts = useMemo(() => {
    const all = files;
    return {
      all: all.length,
      needs_encoding: all.filter((f) => f.status?.includes("RE-ENCODE")).length,
      needs_remux: all.filter((f) => f.status?.includes("REMUX")).length,
      missing_lang: all.filter((f) => f.status?.includes("MISSING LANG"))
        .length,
      queued: all.filter(
        (f) => f.encode_status === "queued" || f.encode_status === "encoding",
      ).length,
      done: all.filter((f) => f.encode_status === "done").length,
      alerts: all.filter(
        (f) =>
          f.audio_tracks.some((t) => !t.lang) ||
          f.subtitle_tracks.some((t) => !t.lang),
      ).length,
    };
  }, [files]);

  // When the scan finishes (isScanning flips true→false) reload the table so
  // the clean-rescan results are immediately visible.
  const prevScanningRef = useRef(false);
  useEffect(() => {
    if (prevScanningRef.current && !isScanning) fetchMedia();
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
    try {
      const r = await fetch(`/api/media/${fileId}/assign-tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, subtitles: subs }),
      });
      const data = await r.json();
      if (!r.ok && r.status !== 207) throw new Error(data.error || "Failed");
      if (r.status === 207) {
        // Assignments saved but remux queue failed
        toast.warning(
          data.error || "Languages saved but remux could not be queued",
        );
      } else {
        toast.success(
          "Languages saved — remux queued to apply changes to file",
        );
      }
      // Switch to the "queued" filter — it includes encode_status='queued' rows,
      // so the newly remuxed file will be visible there. This avoids the race
      // where fetchMedia(true) fetches the current filter (e.g. missing_lang)
      // and overwrites our optimistic update because the file no longer matches.
      setFilter("queued");
    } catch {
      toast.error("Failed to save track languages");
    }
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
    <div className="flex min-h-[420px] flex-col md:h-[calc(100vh-200px)]">
      <LibraryStats stats={stats} />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <MediaTypeSwitch value={mediaType} onChange={setMediaType} />
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
          onTranslate={handleTranslateSingle}
          onTranslateSelected={handleTranslateSelected}
          onAssignTracks={handleAssignTracks}
          onFolderScan={onFolderScan}
          mediaType={mediaType}
          loading={loading}
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
