"use client";

import { memo, useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { MediaDetailsDrawer } from "./media-details-drawer";
import { LanguagePicker } from "./language-picker";
import { FixAnimeDialog, type AnimeSelection } from "./fix-anime-dialog";
import { languageLabel, languageSummary, normalizeLanguage } from "@/lib/languages";
import { useTableGroupSpan } from "@/hooks/use-table-group-span";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Check,
  X,
  MoreHorizontal,
  Play,
  Languages,
  ChevronRight,
  ChevronDown,
  Tag,
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  FolderSync,
  ScanLine,
  FileVideo,
  Subtitles,
  CheckCircle2,
  AlertTriangle,
  Wrench,
  Search,
  Disc,
  Download,
  Sparkles,
} from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  MediaFile,
  MediaType,
  AudioTrack,
  SubtitleTrack,
} from "./media-library-tab";
import {
  TRANSLATE_STATUS_LABEL,
  TRANSLATE_PHASE_COUNT,
  translatePhaseIndex,
} from "./translate-status";

const IMAGE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "dvb_teletext",
  "eia_608",
]);

// Image codecs we can OCR+translate (PGS only for now)
const OCR_CODECS = new Set(["hdmv_pgs_subtitle"]);



type SortCol =
  | "title"
  | "file"
  | "size"
  | "res"
  | "codec"
  | "audio"
  | "subs"
  | "status";
type SortDir = "asc" | "desc";

interface MediaTableProps {
  files: MediaFile[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onSelectMany: (ids: number[], select: boolean) => void;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onEnqueue: (id: number) => void;
  onEnqueueSelected: () => void;
  onRip: (id: number) => void;
  onTranslate: (id: number, subIdx: number) => void;
  onDownloadSubtitle: (id: number, subIdx: number, isOcr: boolean) => void;
  onTranslateSelected: () => void;
  onOcrTranslateSelected: () => void;
  onAssignTracks: (id: number, audio: any[], subs: any[]) => Promise<void>;
  onFolderScan: (fileIds: number[]) => void;
  onScanLibrary: () => void;
  mediaType: MediaType;
  loading?: boolean;
  /** Unfiltered library size, used to distinguish "library empty" from "filter empty". */
  totalFiles?: number;
  isScanning?: boolean;
  revealKey?: string;
  onResetFilters?: () => void;
  onRefresh?: () => void;
  onOpenPosterSettings?: () => void;
}

export function MediaTable({
  files,
  selectedIds,
  onToggleSelect,
  onSelectMany,
  onToggleSelectAll,
  onClearSelection,
  onEnqueue,
  onEnqueueSelected,
  onRip,
  onTranslate,
  onDownloadSubtitle,
  onTranslateSelected,
  onOcrTranslateSelected,
  onAssignTracks,
  onFolderScan,
  onScanLibrary,
  mediaType,
  loading,
  totalFiles,
  isScanning,
  revealKey,
  onResetFilters,
  onRefresh,
  onOpenPosterSettings,
}: MediaTableProps) {
  const groupSpan = useTableGroupSpan();
  // Only one layout is ever visible, so only one is rendered: building the
  // hidden mobile card list alongside the desktop table roughly doubled the
  // cost of showing a large library. Matches Tailwind's `sm` breakpoint.
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [detailsFile, setDetailsFile] = useState<MediaFile | null>(null);
  const detailsTrigger = useRef<HTMLElement | null>(null);
  const openDetails = (file: MediaFile) => {
    detailsTrigger.current = Array.from(document.querySelectorAll<HTMLElement>(`[data-details-file="${file.id}"]`)).find(element => element.getClientRects().length > 0) || document.activeElement as HTMLElement;
    setDetailsFile(file);
  };
  const [expandedShows, setExpandedShows] = useState<Set<string>>(new Set());
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(
    new Set(),
  );
  const [assignDialogFile, setAssignDialogFile] = useState<MediaFile | null>(
    null,
  );
  const [muxDialogFile, setMuxDialogFile] = useState<MediaFile | null>(null);
  const [animeSelection, setAnimeSelection] = useState<AnimeSelection | null>(null);
  const openAnimeFile = (file: MediaFile) => setAnimeSelection({
    label: [file.show_name || file.folder_name, file.season_episode].filter(Boolean).join(" · "),
    scope: { kind: "file", file_id: file.id },
  });
  // One stable object of row callbacks, reading the latest props through a
  // ref, so memoized rows don't all re-render whenever the parent does
  // (progress polls, selection changes, typing in search).
  const latestActions = useRef({ onToggleSelect, onEnqueue, onRip, onTranslate, onDownloadSubtitle, onFolderScan, openDetails, openAnimeFile });
  latestActions.current = { onToggleSelect, onEnqueue, onRip, onTranslate, onDownloadSubtitle, onFolderScan, openDetails, openAnimeFile };
  const rowActions = useMemo<RowActions>(() => ({
    onToggleSelect: id => latestActions.current.onToggleSelect(id),
    onEnqueue: id => latestActions.current.onEnqueue(id),
    onRip: id => latestActions.current.onRip(id),
    onTranslate: (id, subIdx) => latestActions.current.onTranslate(id, subIdx),
    onDownloadSubtitle: (id, subIdx, isOcr) => latestActions.current.onDownloadSubtitle(id, subIdx, isOcr),
    onFolderScan: ids => latestActions.current.onFolderScan(ids),
    onOpenDetails: file => latestActions.current.openDetails(file),
    onFixAnime: file => latestActions.current.openAnimeFile(file),
    onOpenAssignDialog: setAssignDialogFile,
    onOpenMuxDialog: setMuxDialogFile,
  }), []);
  const animeGroupMenu = (kind: "show" | "season", label: string, fileId: number) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button aria-label={`Actions for ${label}`} variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={e => e.stopPropagation()}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onClick={e => { e.stopPropagation(); setAnimeSelection({ label: `${label} · Full ${kind}`, scope: { kind, file_id: fileId } }); }}><Sparkles className="mr-2 h-3.5 w-3.5" />Fix Anime · full {kind}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  );
  const [sortCol, setSortCol] = useState<SortCol>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const toggleShow = (showName: string) => {
    setExpandedShows((prev) => {
      const next = new Set(prev);
      if (next.has(showName)) next.delete(showName);
      else next.add(showName);
      return next;
    });
  };

  const toggleSeason = (key: string) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = files.length > 0 && files.every(file => selectedIds.has(file.id));

  const selectedFiles = files.filter((f) => selectedIds.has(f.id));
  const isTranslatable = (codec: string) => !IMAGE_CODECS.has(codec);

  const translatableSelectedCount = selectedFiles.filter((f) =>
    f.subtitle_tracks.some((t) => isTranslatable(t.codec)),
  ).length;

  const ocrTranslatableSelectedCount = selectedFiles.filter((f) =>
    f.subtitle_tracks.some((t) => OCR_CODECS.has(t.codec)),
  ).length;

  // Apply client-side sort
  const sortedFiles = useMemo(() => {
    const cmp = (a: MediaFile, b: MediaFile): number => {
      switch (sortCol) {
        case "title":
          return (a.folder_name ?? "").localeCompare(b.folder_name ?? "");
        case "file":
          return (a.filename ?? "").localeCompare(b.filename ?? "");
        case "size":
          return (a.size_gb ?? 0) - (b.size_gb ?? 0);
        case "res":
          return (a.video_height ?? 0) - (b.video_height ?? 0);
        case "codec":
          return (a.video_codec ?? "").localeCompare(b.video_codec ?? "");
        case "audio":
          return a.audio_tracks.length - b.audio_tracks.length;
        case "subs":
          return a.subtitle_tracks.length - b.subtitle_tracks.length;
        case "status":
          return (a.status ?? "").localeCompare(b.status ?? "");
        default:
          return 0;
      }
    };
    return [...files].sort((a, b) =>
      sortDir === "asc" ? cmp(a, b) : -cmp(a, b),
    );
  }, [files, sortCol, sortDir]);

  const naturalSort = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  // Build the show→season→episodes tree once; shared by desktop table and mobile cards
  const showMap = useMemo(() => {
    if (mediaType !== "show")
      return new Map<string, Map<string, MediaFile[]>>();
    const map = new Map<string, Map<string, MediaFile[]>>();
    for (const f of sortedFiles) {
      const show = f.show_name || f.folder_name || "Unknown";
      const season = f.folder_name || "Unknown Season";
      if (!map.has(show)) map.set(show, new Map());
      const sm = map.get(show)!;
      if (!sm.has(season)) sm.set(season, []);
      sm.get(season)!.push(f);
    }
    for (const [, sm] of map) {
      const sortedSeasons = Array.from(sm.keys()).sort(naturalSort);
      const sorted = new Map(sortedSeasons.map((s) => [s, sm.get(s)!]));
      sm.clear();
      for (const [k, v] of sorted) {
        v.sort((a, b) =>
          naturalSort(
            a.season_episode || a.filename || "",
            b.season_episode || b.filename || "",
          ),
        );
        sm.set(k, v);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedFiles, mediaType]);

  useEffect(() => {
    if (mediaType !== "show" || !revealKey) return;
    setExpandedShows(new Set(showMap.keys()));
    setExpandedSeasons(new Set(Array.from(showMap).flatMap(([show, seasons]) =>
      Array.from(seasons.keys(), season => `${show}::${season}`))));
    // Expand matches when the user changes a search/filter, not during polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, mediaType]);

  // Empty states are only shown after the first load completes. While loading
  // we render skeleton rows inside the table frame so headers don't shift.
  if (!loading && files.length === 0) {
    const isLibraryEmpty = (totalFiles ?? 0) === 0;
    if (isLibraryEmpty) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/50 bg-card/30 px-6 py-10 text-center">
          <div className="flex flex-col items-center gap-2">
            <FileVideo className="h-12 w-12 text-muted-foreground/30" />
            <div className="text-base font-medium text-foreground">
              Your library is empty
            </div>
            <div className="max-w-sm text-xs text-muted-foreground">
              Scan your watch directory to index media files. New files will be
              picked up automatically once they land.
            </div>
          </div>
          <Button
            onClick={onScanLibrary}
            className="gap-2"
            size="sm"
            disabled={isScanning}
          >
            {isScanning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanLine className="h-4 w-4" />
            )}
            {isScanning ? "Scanning…" : "Scan Library"}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/50 bg-card/30 px-6 py-10 text-center">
        <Search className="h-9 w-9 text-muted-foreground/30" />
        <div className="text-sm font-medium text-foreground">
          No files match the current filters
        </div>
        <div className="max-w-sm text-xs text-muted-foreground">
          Try clearing the search box or switching the filter pill above to
          “All”.
        </div>
        <Button variant="outline" size="sm" onClick={onResetFilters}>Clear search & filters</Button>
      </div>
    );
  }

  const renderRows = () => {
    if (loading && files.length === 0) {
      return Array.from({ length: 8 }).map((_, i) => (
        <SkeletonTableRow key={`sk-${i}`} />
      ));
    }
    if (mediaType !== "show") {
      return sortedFiles.map((file) => (
        <MediaTableRow
          key={file.id}
          file={file}
          isSelected={selectedIds.has(file.id)}
          actions={rowActions}
          canFolderScan
        />
      ));
    }

    const rows: React.ReactNode[] = [];

    for (const showName of showMap.keys()) {
      const seasonMap = showMap.get(showName)!;
      const isExpanded = expandedShows.has(showName);
      const totalEps = Array.from(seasonMap.values()).reduce(
        (s, eps) => s + eps.length,
        0,
      );
      const allShowIds = Array.from(seasonMap.values())
        .flat()
        .map((f) => f.id);
      const anySelected = allShowIds.some((id) => selectedIds.has(id));

      rows.push(
        <tr
          key={`show-${showName}`}
          className="cursor-pointer bg-secondary/30 hover:bg-secondary/50 select-none"
          onClick={() => toggleShow(showName)}
        >
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              aria-label={`Select all episodes of ${showName}`}
              checked={
                anySelected
                  ? allShowIds.every((id) => selectedIds.has(id))
                    ? true
                    : "indeterminate"
                  : false
              }
              onCheckedChange={() => {
                const allChecked = allShowIds.every((id) =>
                  selectedIds.has(id),
                );
                onSelectMany(allShowIds, !allChecked);
              }}
            />
          </td>
          <td className="px-3 py-2" colSpan={groupSpan}>
            <div className="flex items-center gap-2">
              <button type="button" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${showName}`} aria-expanded={isExpanded} onClick={e => { e.stopPropagation(); toggleShow(showName); }} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring">
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium text-foreground">{showName}</span>
              <span className="ml-1 text-xs text-muted-foreground">
                {seasonMap.size} season{seasonMap.size !== 1 ? "s" : ""} ·{" "}
                {totalEps} ep{totalEps !== 1 ? "s" : ""}
              </span>
              {Array.from(seasonMap.values()).flat().some(file => file.status !== "OK") && <span className="text-[11px] text-warning">{Array.from(seasonMap.values()).flat().filter(file => file.status !== "OK").length} need attention</span>}
              </button>
              <Hint content="Re-scan this show"><button
                aria-label="Re-scan this show"
                onClick={(e) => {
                  e.stopPropagation();
                  onFolderScan(allShowIds);
                }}
                className="ml-auto rounded p-1 text-muted-foreground/50 hover:bg-secondary/60 hover:text-foreground"
              >
                <FolderSync className="h-3 w-3" />
              </button></Hint>
            </div>
          </td>
          <td className="w-8 px-2 py-2" onClick={e => e.stopPropagation()}>{animeGroupMenu("show", showName, allShowIds[0])}</td>
        </tr>,
      );

      if (!isExpanded) continue;

      for (const [seasonName, episodes] of seasonMap) {
        const seasonKey = `${showName}::${seasonName}`;
        const isSeasonExpanded = expandedSeasons.has(seasonKey);
        const allSeasonIds = episodes.map((f) => f.id);
        const anySeasonSel = allSeasonIds.some((id) => selectedIds.has(id));

        rows.push(
          <tr
            key={`season-${seasonKey}`}
            className="cursor-pointer bg-secondary/10 hover:bg-secondary/20 select-none"
            onClick={() => toggleSeason(seasonKey)}
          >
            <td className="px-3 py-2 pl-8" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                aria-label={`Select ${showName} ${seasonName}`}
                checked={
                  anySeasonSel
                    ? allSeasonIds.every((id) => selectedIds.has(id))
                      ? true
                      : "indeterminate"
                    : false
                }
                onCheckedChange={() => {
                  const allChecked = allSeasonIds.every((id) =>
                    selectedIds.has(id),
                  );
                  onSelectMany(allSeasonIds, !allChecked);
                }}
              />
            </td>
            <td className="px-3 py-2 pl-6" colSpan={groupSpan}>
              <div className="flex items-center gap-2">
                <button type="button" aria-label={`${isSeasonExpanded ? "Collapse" : "Expand"} ${showName} ${seasonName}`} aria-expanded={isSeasonExpanded} onClick={e => { e.stopPropagation(); toggleSeason(seasonKey); }} className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring">
                {isSeasonExpanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <span className="text-sm font-medium text-foreground/80">
                  {seasonName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {episodes.length} ep{episodes.length !== 1 ? "s" : ""}
                </span>
                </button>
                <Hint content="Re-scan this season"><button
                  aria-label="Re-scan this season"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFolderScan(allSeasonIds);
                  }}
                  className="ml-auto rounded p-1 text-muted-foreground/50 hover:bg-secondary/60 hover:text-foreground"
                >
                  <FolderSync className="h-3 w-3" />
                </button></Hint>
              </div>
            </td>
            <td className="w-8 px-2 py-2" onClick={e => e.stopPropagation()}>{animeGroupMenu("season", `${showName} ${seasonName}`, allSeasonIds[0])}</td>
          </tr>,
        );

        if (!isSeasonExpanded) continue;

        for (const ep of episodes) {
          rows.push(
            <MediaTableRow
              key={ep.id}
              file={ep}
              isSelected={selectedIds.has(ep.id)}
              actions={rowActions}
              isEpisode
            />,
          );
        }
      }
    }
    return rows;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/50">
      {selectedIds.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-accent/5 px-4 py-2">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAnimeSelection({ label: `${selectedFiles.length} selected files`, file_ids: selectedFiles.map(file => file.id) })}><Sparkles className="mr-1 h-3 w-3" />Fix Anime</Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={onEnqueueSelected}
            >
              <Play className="mr-1 h-3 w-3" />
              Encode
            </Button>
            {translatableSelectedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={onTranslateSelected}
              >
                <Languages className="mr-1 h-3 w-3" />
                Translate
                {translatableSelectedCount > 1
                  ? ` ${translatableSelectedCount}`
                  : ""}
              </Button>
            )}
            {ocrTranslatableSelectedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={onOcrTranslateSelected}
              >
                <ScanLine className="mr-1 h-3 w-3" />
                OCR + Translate
                {ocrTranslatableSelectedCount > 1
                  ? ` ${ocrTranslatableSelectedCount}`
                  : ""}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={onClearSelection}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* ── Desktop table (sm+) ───────────────────────────────────────────────── */}
      {isDesktop && <div className="hidden flex-1 overflow-auto sm:block">
        <table className="w-full table-fixed text-sm">

          <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
            <tr>
              <th className="w-10 px-3 py-2 text-left">
                <Checkbox
                  aria-label="Select all visible files"
                  checked={allSelected}
                  onCheckedChange={onToggleSelectAll}
                />
              </th>
              <SortHeader
                col="title"
                label={mediaType === "show" ? "Show" : "Title"}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
              />
              <SortHeader
                col="file"
                label="File"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                className="hidden w-[18%] 2xl:table-cell"
              />
              <SortHeader
                col="size"
                className="w-28"
                label="Size"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
              />
              <SortHeader
                col="res"
                label="Res"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                className="hidden w-28 md:table-cell"
              />
              <SortHeader
                col="codec"
                label="Codec"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                className="hidden w-20 lg:table-cell"
              />
              <SortHeader
                col="audio"
                label="Audio"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                className="hidden w-28 xl:table-cell"
              />
              <SortHeader
                col="subs"
                label="Subs"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                className="hidden w-28 xl:table-cell"
              />
              <SortHeader
                col="status"
                className="w-36"
                label="Status"
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
              />
              <th className="w-10 px-2 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">{renderRows()}</tbody>
        </table>
      </div>}

      {/* ── Mobile card list (<sm) ────────────────────────────────────────────── */}
      {!isDesktop && <div className="flex-1 overflow-auto sm:hidden">
        {loading && files.length === 0
          ? Array.from({ length: 5 }).map((_, i) => (
              <SkeletonMobileCard key={`sk-m-${i}`} />
            ))
          : mediaType !== "show"
          ? sortedFiles.map((file) => (
              <MobileFileCard
                key={file.id}
                file={file}
                isSelected={selectedIds.has(file.id)}
                actions={rowActions}
                canFolderScan
              />
            ))
          : Array.from(showMap.keys()).map((showName) => {
              const seasonMap = showMap.get(showName)!;
              const isExpanded = expandedShows.has(showName);
              const totalEps = Array.from(seasonMap.values()).reduce(
                (s, e) => s + e.length,
                0,
              );
              const allShowIds = Array.from(seasonMap.values())
                .flat()
                .map((f) => f.id);
              const anySelected = allShowIds.some((id) => selectedIds.has(id));
              const allChecked = allShowIds.every((id) => selectedIds.has(id));

              return (
                <div
                  key={`m-show-${showName}`}
                  className="border-b border-border/20"
                >
                  {/* Show header */}
                  <div className="flex items-center gap-2 bg-secondary/30 px-3 py-2.5">
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select all episodes of ${showName}`}
                        checked={
                          anySelected
                            ? allChecked
                              ? true
                              : "indeterminate"
                            : false
                        }
                        onCheckedChange={() =>
                          onSelectMany(allShowIds, !allChecked)
                        }
                      />
                    </span>
                    <button
                      className="flex min-w-0 flex-1 items-center gap-1.5"
                      aria-expanded={isExpanded}
                      onClick={() => toggleShow(showName)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {showName}
                      </span>
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {seasonMap.size}s · {totalEps}ep
                    </span>
                    {animeGroupMenu("show", showName, allShowIds[0])}
                    <Hint content="Re-scan show"><button
                      aria-label="Re-scan show"
                      onClick={() => onFolderScan(allShowIds)}
                      className="rounded p-1 text-muted-foreground/50 hover:bg-secondary/60 hover:text-foreground"
                    >
                      <FolderSync className="h-3.5 w-3.5" />
                    </button></Hint>
                  </div>

                  {isExpanded &&
                    Array.from(seasonMap.entries()).map(
                      ([seasonName, episodes]) => {
                        const seasonKey = `${showName}::${seasonName}`;
                        const isSeasonExpanded = expandedSeasons.has(seasonKey);
                        const allSeasonIds = episodes.map((f) => f.id);
                        const anySeasonSel = allSeasonIds.some((id) =>
                          selectedIds.has(id),
                        );
                        const allSeasonChk = allSeasonIds.every((id) =>
                          selectedIds.has(id),
                        );

                        return (
                          <div key={`m-season-${seasonKey}`}>
                            {/* Season header */}
                            <div className="flex items-center gap-2 border-t border-border/20 bg-secondary/10 py-2 pl-8 pr-3">
                              <span onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  aria-label={`Select ${showName} ${seasonName}`}
                                  checked={
                                    anySeasonSel
                                      ? allSeasonChk
                                        ? true
                                        : "indeterminate"
                                      : false
                                  }
                                  onCheckedChange={() =>
                                    onSelectMany(allSeasonIds, !allSeasonChk)
                                  }
                                />
                              </span>
                              <button
                                className="flex min-w-0 flex-1 items-center gap-1.5"
                                aria-expanded={isSeasonExpanded}
                                onClick={() => toggleSeason(seasonKey)}
                              >
                                {isSeasonExpanded ? (
                                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                )}
                                <span className="truncate text-sm font-medium text-foreground/80">
                                  {seasonName}
                                </span>
                              </button>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {episodes.length}ep
                              </span>
                              {animeGroupMenu("season", `${showName} ${seasonName}`, allSeasonIds[0])}
                              <Hint content="Re-scan season"><button
                                aria-label="Re-scan season"
                                onClick={() => onFolderScan(allSeasonIds)}
                                className="rounded p-1 text-muted-foreground/50 hover:bg-secondary/60 hover:text-foreground"
                              >
                                <FolderSync className="h-3 w-3" />
                              </button></Hint>
                            </div>

                            {isSeasonExpanded &&
                              episodes.map((ep) => (
                                <MobileFileCard
                                  key={ep.id}
                                  file={ep}
                                  isSelected={selectedIds.has(ep.id)}
                                  actions={rowActions}
                                  indent
                                  isEpisode
                                />
                              ))}
                          </div>
                        );
                      },
                    )}
                </div>
              );
            })}
      </div>}

      <MediaDetailsDrawer
        file={detailsFile ? files.find(file => file.id === detailsFile.id) || detailsFile : null}
        onClose={() => setDetailsFile(null)} onRestoreFocus={() => detailsTrigger.current?.focus()}
        onManageTracks={setAssignDialogFile} onAddSubtitle={setMuxDialogFile}
        onEnqueue={onEnqueue} onRip={onRip} onTranslate={onTranslate} onDownloadSubtitle={onDownloadSubtitle}
        onRefresh={onRefresh || (() => {})} onOpenPosterSettings={onOpenPosterSettings}
      />
      {animeSelection && <FixAnimeDialog selection={animeSelection} onClose={() => setAnimeSelection(null)} onQueued={() => onRefresh?.()} />}
      <TrackAssignDialog
        file={assignDialogFile}
        open={assignDialogFile !== null}
        onClose={() => setAssignDialogFile(null)}
        onSave={async (file, audio, subs) => {
          await onAssignTracks(file.id, audio, subs);
          setAssignDialogFile(null);
        }}
      />
      <MuxSubtitleDialog
        file={muxDialogFile}
        open={muxDialogFile !== null}
        onClose={() => setMuxDialogFile(null)}
        onMuxed={() => {
          setMuxDialogFile(null);
          toast.success("Subtitle mux queued");
        }}
      />
    </div>
  );
}

// ── Mobile file card ───────────────────────────────────────────────────────────

const MobileFileCard = memo(function MobileFileCard({
  file,
  isSelected,
  actions,
  indent,
  isEpisode,
  canFolderScan,
}: RowProps & { indent?: boolean }) {
  const { onToggleSelect, onEnqueue, onRip, onFolderScan, onTranslate, onDownloadSubtitle,
    onOpenAssignDialog, onOpenDetails, onOpenMuxDialog, onFixAnime } = bindRowActions(actions, file, canFolderScan);
  const translatableSubTracks = file.subtitle_tracks.filter((t) =>
    !IMAGE_CODECS.has(t.codec) || OCR_CODECS.has(t.codec),
  );
  const title = isEpisode
    ? file.season_episode || file.filename
    : file.folder_name;

  return (
    <div
      className={cn(
        "border-t border-border/20 transition-colors",
        isSelected && "bg-accent/5",
      )}
    >
      <div
        className={cn("flex items-start gap-2 px-3 py-2.5", indent && "pl-16")}
      >
        {/* Checkbox */}
        <span className="mt-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Checkbox aria-label={`Select ${file.show_name || file.folder_name} ${file.season_episode || ""}`} checked={isSelected} onCheckedChange={onToggleSelect} />
        </span>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Hint content={title}><button type="button" onClick={() => onOpenDetails(file)} data-details-file={file.id} aria-label={`View details for ${file.show_name || title} ${file.season_episode || ""}`}
              className="min-w-0 truncate text-left text-sm font-medium leading-tight text-foreground hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {title}
            </button></Hint>
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
              {formatSize(file.size_gb)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {file.video_codec && (
              <span className="text-[10px] uppercase text-muted-foreground">
                {file.video_codec}
              </span>
            )}
            {file.video_height && (
              <span className="text-[10px] text-muted-foreground">
                {file.video_height}p
              </span>
            )}
            <RowStatus file={file} />
          </div>
          {file.status !== "UNPROCESSABLE" && <button type="button" aria-label={`Manage tracks for ${file.show_name || title} ${file.season_episode || ""}`} onClick={() => onOpenAssignDialog(file)} className="mt-1.5 text-left text-[10px] text-muted-foreground hover:text-accent focus-visible:ring-2 focus-visible:ring-ring">Audio {languageSummary(file.audio_tracks)} · Subs {languageSummary(file.subtitle_tracks)}</button>}
        </div>

        {/* Action menu — none apply to unprocessable disc images */}
        {file.status !== "UNPROCESSABLE" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`Actions for ${file.show_name || file.folder_name} ${file.season_episode || ""}`} variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onFixAnime(file)}><Sparkles className="mr-2 h-3.5 w-3.5" />Fix Anime…</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenDetails(file)}><FileVideo className="mr-2 h-3.5 w-3.5" />View details</DropdownMenuItem>
            <DropdownMenuSeparator />
            {file.disc_type ? (
              <DropdownMenuItem onClick={onRip}>
                <Disc className="mr-2 h-3.5 w-3.5" />
                {file.encode_status === "done" ? "Re-rip to MKV" : "Rip to MKV"}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={onEnqueue}>
                <Play className="mr-2 h-3.5 w-3.5" />
                Queue Encode
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpenAssignDialog(file)}>
              <Tag className="mr-2 h-3.5 w-3.5" />
              Manage tracks & languages
            </DropdownMenuItem>
            {onFolderScan && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onFolderScan}>
                  <FolderSync className="mr-2 h-3.5 w-3.5" />
                  Re-scan Folder
                </DropdownMenuItem>
              </>
            )}
            {translatableSubTracks.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {translatableSubTracks.flatMap((t) => [
                  <DropdownMenuItem
                    key={`translate-${t.sub_idx}`}
                    onClick={() => onTranslate(file.id, t.sub_idx)}
                  >
                    <Languages className="mr-2 h-3.5 w-3.5" />
                    {OCR_CODECS.has(t.codec) ? "OCR + Translate" : "Translate"} #{t.sub_idx}
                    {` · ${languageLabel(t.lang)}`}
                  </DropdownMenuItem>,
                  <DropdownMenuItem
                    key={`download-${t.sub_idx}`}
                    onClick={() => onDownloadSubtitle(file.id, t.sub_idx, OCR_CODECS.has(t.codec))}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" />
                    Download{OCR_CODECS.has(t.codec) ? " OCR'd" : ""} Subtitle #{t.sub_idx}
                  </DropdownMenuItem>,
                ])}
              </>
            )}
            {file.subtitle_tracks.length === 0 && onOpenMuxDialog && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onOpenMuxDialog(file)}>
                  <Subtitles className="mr-2 h-3.5 w-3.5" />
                  Mux Subtitle File
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
    </div>
  );
});

// ── Sort header ────────────────────────────────────────────────────────────────

function SortHeader({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
  className,
}: {
  col: SortCol;
  label: string;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
  className?: string;
}) {
  const active = sortCol === col;
  return (
    <th aria-sort={active ? sortDir === "asc" ? "ascending" : "descending" : "none"}
      className={cn(
        "cursor-pointer select-none px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <button type="button" aria-label={`Sort by ${label}`} onClick={() => onSort(col)} className="flex w-full items-center gap-1 text-left uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="h-2.5 w-2.5" />
          ) : (
            <ArrowDown className="h-2.5 w-2.5" />
          )
        ) : (
          <ArrowUpDown className="h-2.5 w-2.5 opacity-30" />
        )}
      </button>
    </th>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

export interface RowActions {
  onToggleSelect: (id: number) => void;
  onEnqueue: (id: number) => void;
  onRip: (id: number) => void;
  onTranslate: (id: number, subIdx: number) => void;
  onDownloadSubtitle: (id: number, subIdx: number, isOcr: boolean) => void;
  onFolderScan: (fileIds: number[]) => void;
  onOpenAssignDialog: (file: MediaFile) => void;
  onOpenDetails: (file: MediaFile) => void;
  onOpenMuxDialog: (file: MediaFile) => void;
  onFixAnime: (file: MediaFile) => void;
}

interface RowProps {
  file: MediaFile;
  isSelected: boolean;
  actions: RowActions;
  isEpisode?: boolean;
  canFolderScan?: boolean;
}

// Per-row bindings of the shared callbacks. Rows are memoized, so these only
// get recreated when that row's own props change.
function bindRowActions(actions: RowActions, file: MediaFile, canFolderScan?: boolean) {
  return {
    ...actions,
    onToggleSelect: () => actions.onToggleSelect(file.id),
    onEnqueue: () => actions.onEnqueue(file.id),
    onRip: () => actions.onRip(file.id),
    onFolderScan: canFolderScan ? () => actions.onFolderScan([file.id]) : undefined,
  };
}

const MediaTableRow = memo(function MediaTableRow({
  file,
  isSelected,
  actions,
  isEpisode,
  canFolderScan,
}: RowProps) {
  const { onToggleSelect, onEnqueue, onRip, onFolderScan, onTranslate, onDownloadSubtitle,
    onOpenAssignDialog, onOpenDetails, onOpenMuxDialog, onFixAnime } = bindRowActions(actions, file, canFolderScan);
  const translatableSubTracks = file.subtitle_tracks.filter((t) =>
    !IMAGE_CODECS.has(t.codec) || OCR_CODECS.has(t.codec),
  );

  return (
    <tr
      className={cn(
        "transition-colors hover:bg-secondary/20",
        isSelected && "bg-accent/5",
      )}
    >
      <td className={cn("px-3 py-2", isEpisode && "pl-12")} onClick={(e) => e.stopPropagation()}>
        <Checkbox aria-label={`Select ${file.show_name || file.folder_name} ${file.season_episode || ""}`} checked={isSelected} onCheckedChange={onToggleSelect} />
      </td>
      <td className={cn("overflow-hidden px-3 py-2", isEpisode && "pl-18")}>
        <div className="flex items-center gap-1.5">
          <Hint content={
              isEpisode ? file.season_episode || file.filename : file.folder_name
            }><button type="button" onClick={() => onOpenDetails(file)} data-details-file={file.id} aria-label={`View details for ${file.show_name || file.folder_name} ${file.season_episode || ""}`}
            className="min-w-0 truncate text-left font-medium text-foreground hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isEpisode ? file.season_episode || file.filename : file.folder_name}
          </button></Hint>
          {onFolderScan && (
            <Hint content="Re-scan this movie folder"><button
              aria-label="Re-scan this movie folder"
              onClick={(e) => {
                e.stopPropagation();
                onFolderScan();
              }}
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/30 hover:bg-secondary/60 hover:text-foreground"
            >
              <FolderSync className="h-3 w-3" />
            </button></Hint>
          )}
        </div>
        {file.status !== "UNPROCESSABLE" && <button type="button" aria-label={`Manage tracks for ${file.show_name || file.folder_name} ${file.season_episode || ""}`} onClick={() => onOpenAssignDialog(file)} className="mt-1 block max-w-full truncate text-left text-[10px] text-muted-foreground hover:text-accent focus-visible:ring-2 focus-visible:ring-ring xl:hidden">
          Audio {languageSummary(file.audio_tracks)} · Subs {languageSummary(file.subtitle_tracks)}
        </button>}
      </td>
      <td className="hidden overflow-hidden px-3 py-2 2xl:table-cell">
        <Hint content={file.filename}><span
          className="block truncate font-mono text-[11px] text-muted-foreground"

        >
          {file.filename}
        </span></Hint>
      </td>
      <td className="px-3 py-2">
        <div className="text-xs">
          <span className="whitespace-nowrap font-medium">{formatSize(file.size_gb)}</span>
          {file.estimated_size_gb && !file.encode_status && (
            <span className="mt-0.5 block whitespace-nowrap text-[10px] text-success">
              est. {formatSize(file.estimated_size_gb)}
            </span>
          )}
        </div>
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
        {file.video_width && file.video_height
          ? `${file.video_width}×${file.video_height}`
          : "-"}
      </td>
      <td className="hidden px-3 py-2 lg:table-cell">
        <span className="text-xs uppercase text-muted-foreground">
          {file.video_codec || "-"}
        </span>
      </td>
      <td className="hidden px-3 py-2 xl:table-cell">
        <TrackBadges tracks={file.audio_tracks} />
      </td>
      <td className="hidden px-3 py-2 xl:table-cell">
        <TrackBadges tracks={file.subtitle_tracks} />
      </td>
      <td className="px-3 py-2">
        <RowStatus file={file} />
      </td>
      <td className="px-2 py-2">
        {/* No actions apply to unprocessable disc images */}
        {file.status !== "UNPROCESSABLE" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`Actions for ${file.show_name || file.folder_name} ${file.season_episode || ""}`} variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onFixAnime(file)}><Sparkles className="mr-2 h-3.5 w-3.5" />Fix Anime…</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenDetails(file)}><FileVideo className="mr-2 h-3.5 w-3.5" />View details</DropdownMenuItem>
            <DropdownMenuSeparator />
            {file.disc_type ? (
              <DropdownMenuItem onClick={onRip}>
                <Disc className="mr-2 h-3.5 w-3.5" />
                {file.encode_status === "done" ? "Re-rip to MKV" : "Rip to MKV"}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={onEnqueue}>
                <Play className="mr-2 h-3.5 w-3.5" />
                Queue Encode
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpenAssignDialog(file)}>
              <Tag className="mr-2 h-3.5 w-3.5" />
              Manage tracks & languages
            </DropdownMenuItem>
            {translatableSubTracks.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {translatableSubTracks.flatMap((t) => [
                  <DropdownMenuItem
                    key={`translate-${t.sub_idx}`}
                    onClick={() => onTranslate(file.id, t.sub_idx)}
                  >
                    <Languages className="mr-2 h-3.5 w-3.5" />
                    {OCR_CODECS.has(t.codec) ? "OCR + Translate" : "Translate"} #{t.sub_idx}
                    {` · ${languageLabel(t.lang)}`}
                  </DropdownMenuItem>,
                  <DropdownMenuItem
                    key={`download-${t.sub_idx}`}
                    onClick={() => onDownloadSubtitle(file.id, t.sub_idx, OCR_CODECS.has(t.codec))}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" />
                    Download{OCR_CODECS.has(t.codec) ? " OCR'd" : ""} Subtitle #{t.sub_idx}
                  </DropdownMenuItem>,
                ])}
              </>
            )}
            {file.subtitle_tracks.length === 0 && onOpenMuxDialog && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onOpenMuxDialog(file)}>
                  <Subtitles className="mr-2 h-3.5 w-3.5" />
                  Mux Subtitle File
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </td>
    </tr>
  );
});

// ── Row status (shows live progress when encoding/translating) ─────────────────

const BADGE_BASE =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium";

function StatusBadge({
  tone,
  icon: Icon,
  label,
  tooltip,
}: {
  tone: string;
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  tooltip: string;
}) {
  return (
    <Hint content={tooltip} side="top" className="max-w-[260px] text-[11px]">
      <span tabIndex={0} className={cn(BADGE_BASE, "cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tone)}>
        <Icon className="h-3 w-3" />
        {label}
      </span>
    </Hint>
  );
}

function RowStatus({ file }: { file: MediaFile }) {
  const inner = <RowStatusInner file={file} />;
  // Analyzable disc images get a DVD/Blu-ray pill in front of their status.
  if (file.disc_type) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge
          tone="bg-cyan-500/15 text-cyan-400"
          icon={Disc}
          label={file.disc_type === "bluray" ? "Blu-ray" : "DVD"}
          tooltip="Disc image — ready to rip its selected best tracks to MKV."
        />
        {inner}
      </div>
    );
  }
  return inner;
}

function RowStatusInner({ file }: { file: MediaFile }) {
  // Unreadable disc images (data/encrypted) can't be analyzed — Alerts only.
  if (file.status === "UNPROCESSABLE") {
    return (
      <StatusBadge
        tone="bg-purple-500/15 text-purple-400"
        icon={Disc}
        label="ISO"
        tooltip="Disc image (.iso/.img) — cannot be analyzed or encoded. Needs manual handling."
      />
    );
  }

  // Live encode / remux / rip progress
  if (file.encode_status === "encoding") {
    const verb =
      file.encode_job_type === "rip"
        ? "Ripping"
        : file.encode_job_type === "remux"
          ? "Remuxing"
          : "Encoding";
    const pct =
      file.encode_progress != null
        ? `${Math.round(file.encode_progress)}%`
        : "";
    return (
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin text-accent" />
        <span className="text-[10px] text-accent">
          {verb}
          {pct ? ` ${pct}` : ""}
        </span>
      </div>
    );
  }

  // Live translate progress — show phase index (e.g. "OCR · 2/4") so users
  // can see how far along the multi-step pipeline a file is at a glance.
  if (
    file.translate_status &&
    file.translate_status !== "done" &&
    file.translate_status !== "failed" &&
    file.translate_status !== "cancelled"
  ) {
    const label =
      TRANSLATE_STATUS_LABEL[file.translate_status] ?? file.translate_status;
    const phase = translatePhaseIndex(file.translate_status);
    const pct =
      file.translate_progress != null && file.translate_progress > 0
        ? `${Math.round(file.translate_progress)}%`
        : "";
    const detail = pct
      ? pct
      : phase != null
        ? `${phase}/${TRANSLATE_PHASE_COUNT}`
        : "";
    return (
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin text-accent" />
        <span className="text-[10px] text-accent">
          {label}
          {detail ? ` · ${detail}` : ""}
        </span>
      </div>
    );
  }

  if (file.encode_status === "queued") {
    const label =
      file.encode_job_type === "rip"
        ? "Rip Queued"
        : file.encode_job_type === "remux"
          ? "Remux Queued"
          : "Queued";
    return (
      <StatusBadge
        tone="bg-secondary text-muted-foreground"
        icon={Loader2}
        label={label}
        tooltip="Waiting in the encode queue. Jobs run sequentially based on worker availability."
      />
    );
  }
  if (file.encode_status === "done") {
    return (
      <StatusBadge
        tone="bg-success/20 text-success"
        icon={CheckCircle2}
        label="Done"
        tooltip="Last job completed successfully."
      />
    );
  }
  if (file.encode_status === "failed") {
    return (
      <StatusBadge
        tone="bg-destructive/20 text-destructive"
        icon={AlertTriangle}
        label="Failed"
        tooltip="Last job failed. Open the queue or app logs to see the error."
      />
    );
  }

  const hasReEncode = file.status?.includes("RE-ENCODE");
  const hasRemux = file.status?.includes("REMUX");
  const hasMissingLang = file.status?.includes("MISSING LANG");

  if (!hasReEncode && !hasRemux && !hasMissingLang) {
    if (file.status === "OK") {
      return (
        <StatusBadge
          tone="bg-success/20 text-success"
          icon={CheckCircle2}
          label="OK"
          tooltip="No action needed — tracks are tagged and the file is within size limits."
        />
      );
    }
    return (
      <span className={cn(BADGE_BASE, "bg-secondary text-muted-foreground")}>
        {file.status}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-0.5">
      {hasReEncode && (
        <StatusBadge
          tone="bg-destructive/20 text-destructive"
          icon={AlertTriangle}
          label="Re-encode"
          tooltip="File is larger than the configured threshold. Re-encoding can reduce size; output quality depends on encoder settings."
        />
      )}
      {hasRemux && (
        <StatusBadge
          tone="bg-warning/20 text-warning"
          icon={Wrench}
          label="Remux"
          tooltip="One or more tracks are missing language tags. A fast remux rewrites the container without re-encoding video."
        />
      )}
      {hasMissingLang && (
        <StatusBadge
          tone="bg-sky-500/15 text-sky-400"
          icon={Languages}
          label="Missing Sub"
          tooltip="One or more required subtitle languages are missing. Translate an existing track or mux a subtitle file."
        />
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSize(gb: number): string {
  if (gb < 0.1) return `${(gb * 1024).toFixed(0)} MB`;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  return `${gb.toFixed(1)} GB`;
}

function TrackBadges({ tracks }: { tracks: AudioTrack[] | SubtitleTrack[] }) {
  if (!tracks.length) return <span className="text-xs text-muted-foreground">None</span>;
  const active = tracks.filter(t => t.action !== "drop");
  const unknown = active.some(t => !normalizeLanguage(t.lang));
  return <Hint content={<div className="space-y-1">{tracks.map((track, i) => <div key={i}>
    <span className="font-medium">{languageLabel(track.lang)}</span> · {track.codec}
    {"channels" in track && track.channels ? ` · ${track.channels}ch` : ""}
    {track.action === "drop" ? " · marked for removal" : ""}
  </div>)}</div>}><span tabIndex={0} className={cn("inline-flex cursor-help rounded px-1.5 py-1 text-[10px] font-medium focus-visible:ring-2 focus-visible:ring-ring", unknown ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground")}>{languageSummary(tracks)}</span></Hint>;
}

// ── Track Assign Dialog ────────────────────────────────────────────────────────

interface TrackState {
  lang: string;
  action: "keep" | "drop";
}

function TrackRow({
  label,
  lang,
  action,
  onLangChange,
  onActionChange,
}: {
  label: string;
  lang: string;
  action: "keep" | "drop";
  onLangChange: (v: string) => void;
  onActionChange: (v: "keep" | "drop") => void;
}) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border/30 py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(150px,1fr)_auto]", action === "drop" && "bg-destructive/5")}>
      <Hint content={label}><span className="col-span-2 truncate font-mono text-xs text-muted-foreground sm:col-span-1">{label}</span></Hint>
      <LanguagePicker label={`Language for ${label}`} value={lang} onChange={onLangChange} disabled={action === "drop"} />
      <div role="group" aria-label={`Keep or drop ${label}`} className="inline-flex rounded-md border border-border/50 p-0.5">
        <button type="button" aria-label={`Keep ${label}`} aria-pressed={action === "keep"} onClick={() => onActionChange("keep")} className={cn("inline-flex h-8 items-center gap-1 rounded px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring", action === "keep" ? "bg-accent/15 text-accent" : "text-muted-foreground")}><Check className="h-3 w-3" />Keep</button>
        <button type="button" aria-label={`Drop ${label}`} aria-pressed={action === "drop"} onClick={() => onActionChange("drop")} className={cn("inline-flex h-8 items-center gap-1 rounded px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring", action === "drop" ? "bg-destructive/20 text-destructive" : "text-muted-foreground")}><X className="h-3 w-3" />Drop</button>
      </div>
    </div>
  );
}

function TrackAssignDialog({
  file,
  open,
  onClose,
  onSave,
}: {
  file: MediaFile | null;
  open: boolean;
  onClose: () => void;
  onSave: (file: MediaFile, audio: any[], subs: any[]) => Promise<void>;
}) {
  const [audioState, setAudioState] = useState<Map<number, TrackState>>(
    new Map(),
  );
  const [subState, setSubState] = useState<Map<number, TrackState>>(new Map());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) return;
    const am = new Map<number, TrackState>();
    for (const t of file.audio_tracks)
      am.set(t.audio_idx, { lang: normalizeLanguage(t.lang), action: t.action || "keep" });
    setAudioState(am);
    const sm = new Map<number, TrackState>();
    for (const t of file.subtitle_tracks)
      sm.set(t.sub_idx, { lang: normalizeLanguage(t.lang), action: t.action || "keep" });
    setSubState(sm);
  }, [file]);

  if (!file) return null;

  const dropped = [...audioState.values(), ...subState.values()].filter(t => t.action === "drop").length;
  const noAudio = file.audio_tracks.length > 0 && [...audioState.values()].every(t => t.action === "drop");
  const changed = [...file.audio_tracks.map(t => ({ initial: t, current: audioState.get(t.audio_idx) })),
    ...file.subtitle_tracks.map(t => ({ initial: t, current: subState.get(t.sub_idx) }))]
    .some(({initial, current}) => current && (current.lang !== normalizeLanguage(initial.lang) || current.action !== (initial.action || "keep")));
  const handleSave = async () => {
    if (!changed || noAudio) return;
    setSaving(true);
    try {
      const audio = file.audio_tracks.map((t) => ({
        audio_idx: t.audio_idx,
        lang: audioState.get(t.audio_idx)?.lang ?? t.lang ?? "",
        action: audioState.get(t.audio_idx)?.action ?? "keep",
      }));
      const subs = file.subtitle_tracks.map((t) => ({
        sub_idx: t.sub_idx,
        lang: subState.get(t.sub_idx)?.lang ?? t.lang ?? "",
        action: subState.get(t.sub_idx)?.action ?? "keep",
      }));
      await onSave(file, audio, subs);
    } catch {
      // Parent already toasts the error; we just absorb the rejection so it
      // doesn't surface as an unhandled-rejection and so the dialog stays
      // open with the user's edits intact for retry.
    } finally {
      setSaving(false);
    }
  };

  const updateAudio = (idx: number, patch: Partial<TrackState>) =>
    setAudioState((m) => new Map(m).set(idx, { ...m.get(idx)!, ...patch }));
  const updateSub = (idx: number, patch: Partial<TrackState>) =>
    setSubState((m) => new Map(m).set(idx, { ...m.get(idx)!, ...patch }));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>Manage tracks & languages</DialogTitle>
          <DialogDescription className="truncate text-xs">
            {file.show_name ? `${file.show_name} · ${file.season_episode}` : file.folder_name}
          </DialogDescription>
        </DialogHeader>
        <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">{file.disc_type ? "Track choices apply when you rip this disc." : "Saving queues a remux. Language tags are updated and dropped tracks are removed from the file; video is copied without re-encoding."}</p>
        <div className="mt-1 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {file.audio_tracks.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Audio Tracks
              </p>
              {file.audio_tracks.map((t) => {
                const s = audioState.get(t.audio_idx);
                return (
                  <TrackRow
                    key={t.audio_idx}
                    label={`#${t.audio_idx} · ${t.codec.toUpperCase()}${t.channels ? ` · ${t.channels}ch` : ""}${t.title ? ` · ${t.title}` : ""}`}
                    lang={s?.lang ?? t.lang ?? ""}
                    action={s?.action ?? "keep"}
                    onLangChange={(v) => updateAudio(t.audio_idx, { lang: v })}
                    onActionChange={(a) =>
                      updateAudio(t.audio_idx, { action: a })
                    }
                  />
                );
              })}
            </div>
          )}
          {file.subtitle_tracks.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Subtitle Tracks
              </p>
              {file.subtitle_tracks.map((t) => {
                const s = subState.get(t.sub_idx);
                return (
                  <TrackRow
                    key={t.sub_idx}
                    label={`#${t.sub_idx} · ${t.codec === "hdmv_pgs_subtitle" ? "PGS" : t.codec.toUpperCase()}${IMAGE_CODECS.has(t.codec) ? " (image)" : ""}${t.title ? ` · ${t.title}` : ""}`}
                    lang={s?.lang ?? t.lang ?? ""}
                    action={s?.action ?? "keep"}
                    onLangChange={(v) => updateSub(t.sub_idx, { lang: v })}
                    onActionChange={(a) => updateSub(t.sub_idx, { action: a })}
                  />
                );
              })}
            </div>
          )}
          {file.audio_tracks.length === 0 &&
            file.subtitle_tracks.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No audio or subtitle tracks found.
              </p>
            )}
        </div>
        <div role="status" className={cn("shrink-0 text-xs", noAudio ? "text-destructive" : "text-muted-foreground")}>
          {noAudio ? "Keep at least one audio track." : `${dropped} track${dropped === 1 ? "" : "s"} marked for removal${changed ? " · Unsaved changes" : " · No changes"}`}
        </div>
        <DialogFooter className="mt-2 shrink-0">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !changed || noAudio}>
            {saving ? "Saving…" : file.disc_type ? "Save track choices" : "Save & queue remux"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Mux External Subtitle Dialog ───────────────────────────────────────────────

function MuxSubtitleDialog({
  file,
  open,
  onClose,
  onMuxed,
}: {
  file: MediaFile | null;
  open: boolean;
  onClose: () => void;
  onMuxed: () => void;
}) {
  const [externalSubs, setExternalSubs] = useState<string[]>([]);
  const [selectedSub, setSelectedSub] = useState<string>("");
  const [selectedLang, setSelectedLang] = useState<string>("eng");
  const [loadingList, setLoadingList] = useState(false);
  const [muxing, setMuxing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file || !open) return;
    setExternalSubs([]);
    setSelectedSub("");
    setSelectedLang("eng");
    setError(null);
    setLoadingList(true);
    const ac = new AbortController();
    fetch(`/api/media/${file.id}/external-subs`, { signal: ac.signal })
      .then((r) => r.json())
      .then((data) => {
        const subs: string[] = (data.subs ?? []).map((s: { path: string }) => s.path);
        setExternalSubs(subs);
        if (subs.length > 0) setSelectedSub(subs[0]);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        setError("Failed to load subtitle files");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoadingList(false);
      });
    return () => ac.abort();
  }, [file, open]);

  if (!file) return null;

  const handleMux = async () => {
    if (!selectedSub) return;
    setMuxing(true);
    setError(null);
    try {
      const r = await fetch(`/api/media/${file.id}/mux-external-sub`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub_path: selectedSub, lang: selectedLang }),
      });
      let data: any = {};
      try { data = await r.json(); } catch { /* non-JSON body */ }
      if (!r.ok) throw new Error(data.error || "Failed to queue mux job");
      onMuxed();
    } catch (e: any) {
      setError(e.message ?? "Failed to queue mux job");
    } finally {
      setMuxing(false);
    }
  };

  const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* min-w-0 + overflow-hidden lets grid children truncate instead of
          forcing the dialog wider than max-w-md when folder names or sub
          paths are long. */}
      <DialogContent className="max-w-md min-w-0 overflow-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>Mux Subtitle File</DialogTitle>
          <Hint content={file.folder_name ?? undefined}><DialogDescription className="block truncate text-xs" >
            {file.folder_name}
          </DialogDescription></Hint>
        </DialogHeader>

        <div className="mt-1 min-w-0 space-y-4">
          {loadingList ? (
            <div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning for subtitle files…
            </div>
          ) : externalSubs.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No subtitle files found in the same directory.
            </p>
          ) : (
            <>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Subtitle File
                </p>
                <div className="space-y-1">
                  {externalSubs.map((sub) => (
                    <label
                      key={sub}
                      className={cn(
                        "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors",
                        selectedSub === sub
                          ? "bg-accent/10 text-foreground"
                          : "text-muted-foreground hover:bg-secondary/50",
                      )}
                    >
                      <input
                        type="radio"
                        name="sub-file"
                        value={sub}
                        checked={selectedSub === sub}
                        onChange={() => setSelectedSub(sub)}
                        className="shrink-0 accent-primary"
                      />
                      <Hint content={sub}><span className="min-w-0 flex-1 truncate font-mono text-[11px]" >
                        {basename(sub)}
                      </span></Hint>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Language
                </p>
                <LanguagePicker label="Subtitle file language" value={selectedLang} onChange={setSelectedLang} allowUnknown={false} />
              </div>
            </>
          )}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="mt-4 min-w-0">
          <Button variant="ghost" onClick={onClose} disabled={muxing} className="shrink-0">
            Cancel
          </Button>
          <Button
            onClick={handleMux}
            disabled={muxing || !selectedSub || externalSubs.length === 0}
            className="shrink-0"
          >
            {muxing ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Queuing…
              </>
            ) : (
              "Queue Mux"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Loading skeletons ──────────────────────────────────────────────────────────
// Rendered inside the live table frame while the first batch of data loads, so
// headers and column widths don't shift when the real rows arrive.

function SkeletonTableRow() {
  return (
    <tr className="border-b border-border/10">
      <td className="px-3 py-3">
        <Skeleton className="h-4 w-4 rounded-sm" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-3 w-[70%]" />
      </td>
      <td className="hidden px-3 py-3 lg:table-cell">
        <Skeleton className="h-3 w-[80%]" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-3 w-12" />
      </td>
      <td className="hidden px-3 py-3 md:table-cell">
        <Skeleton className="h-3 w-10" />
      </td>
      <td className="hidden px-3 py-3 lg:table-cell">
        <Skeleton className="h-3 w-12" />
      </td>
      <td className="hidden px-3 py-3 xl:table-cell">
        <Skeleton className="h-3 w-8" />
      </td>
      <td className="hidden px-3 py-3 xl:table-cell">
        <Skeleton className="h-3 w-8" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-4 w-20 rounded" />
      </td>
      <td className="px-2 py-3">
        <Skeleton className="h-4 w-4 rounded-sm" />
      </td>
    </tr>
  );
}

function SkeletonMobileCard() {
  return (
    <div className="flex items-center gap-3 border-b border-border/20 px-3 py-3">
      <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
      <Skeleton className="h-5 w-14 rounded" />
    </div>
  );
}
