"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { MediaTypeSwitch } from "./media-type-switch";
import { FilterBar } from "./filter-bar";
import { MediaTable } from "./media-table";
import { CombinedQueue } from "./encode-queue";
import { AppLogs } from "./app-logs";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { normalizeLanguage } from "@/lib/languages";

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
  onOpenPosterSettings?: () => void;
  scan: {
    isScanning: boolean;
    scanProgress?: { scanned: number; total: number };
    lastScanResult?: { scanned: number; total: number };
    onScan: () => void;
    onFolderScan: (fileIds: number[]) => void;
  };
}

export function MediaLibraryTab({ scan, onOpenPosterSettings }: MediaLibraryTabProps) {
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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
      if (!r.ok) throw new Error(`Library request failed (${r.status})`);
      const data = await r.json();
      if (inflightRef.current !== ac) return;
      setAllFiles(data.files ?? []);
      setLoadError(false);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setLoadError(true);
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

  // Bulk actions only act on visible rows; a filter or tab switch cannot retain hidden selections.
  useEffect(() => {
    const visible = new Set(files.map(file => file.id));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [files]);

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

  const handleDownloadSubtitle = (id: number, subIdx: number, isOcr: boolean) => {
    const run = async () => {
      // Queue the extract/OCR through the same job worker translations use — a
      // synchronous request here used to hold the connection open for the whole
      // OCR pass, which a proxy in front could reset ("socket hang up") on slow
      // (large/PGS) tracks. Queuing returns instantly; we just poll for it to finish.
      const q = await fetch(`/api/media/${id}/subtitle/${subIdx}/extract`, { method: "POST" });
      const qData = await q.json().catch(() => ({}));
      if (!q.ok) throw new Error(qData.error || `Failed to queue (HTTP ${q.status})`);
      const jobId = qData.job_id;

      let job: any = null;
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise((res) => setTimeout(res, 2000));
        const jr = await fetch("/api/translate/jobs");
        const jData = await jr.json().catch(() => ({}));
        job = (jData.jobs ?? []).find((j: any) => j.id === jobId);
        if (!job) throw new Error("Job disappeared from the queue");
        if (job.status === "done") break;
        if (job.status === "failed") throw new Error(job.error_text || "Extraction failed");
        if (job.status === "cancelled") throw new Error("Extraction was cancelled");
        job = null; // still running — keep polling
      }
      if (!job) throw new Error("Timed out waiting for extraction to finish");

      const r = await fetch(`/api/translate/jobs/${jobId}/download`);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `Failed to download (HTTP ${r.status})`);
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `subtitle-${subIdx}.srt`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };
    toast.promise(run(), {
      loading: isOcr
        ? "OCR'ing subtitle… this can take a minute for image-based tracks"
        : "Extracting subtitle…",
      success: "Subtitle downloaded",
      error: (e) => (e instanceof Error ? e.message : "Failed to download subtitle"),
    });
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
    if (data.remux_job_id) setFilter("queued");
    fetchMedia(true);
  };

  const TEXT_SUB_CODECS_EXCLUDE = new Set([
    "hdmv_pgs_subtitle",
    "dvd_subtitle",
    "dvb_subtitle",
    "dvb_teletext",
    "eia_608",
  ]);

  const OCR_SUB_CODECS = new Set(["hdmv_pgs_subtitle"]);

  const loadTranslationTarget = async () => {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Could not load translation preferences');
      const settings = await response.json();
      if (!settings.translation_target_lang) throw new Error('Choose a target language in Settings → AI translation first');
      return settings.translation_target_lang as string;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load translation preferences');
      return '';
    }
  };

  const handleTranslateSelected = async () => {
    if (selectedIds.size === 0) return;
    const destination = await loadTranslationTarget();
    if (!destination) return;
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
      const target = textSubs.find(t => normalizeLanguage(t.lang) !== destination);
      if (!target) { skipped++; continue; }
      try {
        const r = await fetch(`/api/media/${id}/translate-subtitle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sub_idx: target.sub_idx, target_lang: destination }),
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

  const handleOcrTranslateSelected = async () => {
    if (selectedIds.size === 0) return;
    const destination = await loadTranslationTarget();
    if (!destination) return;
    let queued = 0;
    let skipped = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) {
        skipped++;
        continue;
      }
      const ocrSubs = file.subtitle_tracks.filter((t) =>
        OCR_SUB_CODECS.has(t.codec),
      );
      if (ocrSubs.length === 0) {
        skipped++;
        continue;
      }
      const target = ocrSubs.find(t => normalizeLanguage(t.lang) !== destination);
      if (!target) { skipped++; continue; }
      try {
        const r = await fetch(`/api/media/${id}/translate-subtitle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sub_idx: target.sub_idx, target_lang: destination }),
        });
        if (r.ok) queued++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (queued > 0) {
      toast.success(`Queued ${queued} file(s) for OCR+translation`);
      fetchMedia(true);
    }
    if (skipped > 0)
      toast.info(`${skipped} file(s) skipped (no OCR-capable subtitle)`);
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
    if (files.every(file => selectedIds.has(file.id))) setSelectedIds(new Set());
    else setSelectedIds(new Set(files.map((f) => f.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  return (
    <div className="flex min-h-[420px] flex-col md:h-[calc(100dvh-104px)]">
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <MediaTypeSwitch value={mediaType} onChange={value => { setMediaType(value); setFilter("all"); setSearchQuery(""); setSelectedIds(new Set()); }} />
          <LibrarySummary stats={stats} mediaType={mediaType} showCount={new Set(typedFiles.map(file => file.show_name || file.folder_name)).size} />
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

      {loadError && <div role="alert" className="mt-3 flex items-center justify-between gap-3 text-sm text-destructive"><span>Couldn’t refresh the library. {allFiles.length ? "Showing the last loaded files." : "Check the backend connection."}</span><Button size="sm" variant="outline" onClick={() => fetchMedia()}>Retry</Button></div>}
      {(filter !== "all" || searchQuery) && <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground"><span>{files.length} of {typedFiles.length} files shown</span><button type="button" className="text-accent hover:underline" onClick={() => { setFilter("all"); setSearchQuery(""); }}>Clear search & filters</button></div>}
      {/* Scrollable table area */}
      <div className="mt-4 min-h-0 flex-1 overflow-hidden">
        <MediaTable
          files={files}
          onRefresh={() => fetchMedia(true)}
          onOpenPosterSettings={onOpenPosterSettings}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          onToggleSelectAll={toggleSelectAll}
          onClearSelection={clearSelection}
          onEnqueue={handleEnqueueSingle}
          onEnqueueSelected={handleEnqueueSelected}
          onRip={handleRipDisc}
          onTranslate={handleTranslateSingle}
          onDownloadSubtitle={handleDownloadSubtitle}
          onTranslateSelected={handleTranslateSelected}
          onOcrTranslateSelected={handleOcrTranslateSelected}
          onAssignTracks={handleAssignTracks}
          onFolderScan={onFolderScan}
          onScanLibrary={onScan}
          mediaType={mediaType}
          loading={loading}
          totalFiles={stats.total_files}
          isScanning={isScanning}
          revealKey={filter !== "all" || debouncedSearch ? `${filter}:${debouncedSearch}` : ""}
          onResetFilters={() => { setFilter("all"); setSearchQuery(""); }}
        />
      </div>

      {/* Terminal-style bottom panel */}
      <div id="library-queue" tabIndex={-1} className="mt-3 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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

function LibrarySummary({ stats, mediaType, showCount }: { stats: LibraryStatsData; mediaType: MediaType; showCount: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap text-xs text-muted-foreground">
      <span>
        {mediaType === "show" ? `${showCount} shows · ` : ""}
        <span className="font-medium text-foreground">
          {stats.total_files.toLocaleString()}
        </span>{mediaType === "show" ? " episodes" : " movies"}
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
