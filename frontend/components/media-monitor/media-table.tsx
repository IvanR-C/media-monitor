"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { MoreHorizontal, Play, Languages, ChevronRight, ChevronDown } from "lucide-react"
import type { MediaFile, MediaType } from "./media-library-tab"

interface MediaTableProps {
  files: MediaFile[]
  selectedIds: Set<number>
  onToggleSelect: (id: number) => void
  onToggleSelectAll: () => void
  onEnqueue: (id: number) => void
  onEnqueueSelected: () => void
  onTranslate: (id: number, subIdx: number) => void
  mediaType: MediaType
  loading?: boolean
}

export function MediaTable({
  files,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onEnqueue,
  onEnqueueSelected,
  onTranslate,
  mediaType,
  loading,
}: MediaTableProps) {
  const [expandedShows, setExpandedShows] = useState<Set<string>>(new Set())
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(new Set())

  const toggleShow = (showName: string) => {
    setExpandedShows(prev => {
      const next = new Set(prev)
      if (next.has(showName)) next.delete(showName)
      else next.add(showName)
      return next
    })
  }

  const toggleSeason = (key: string) => {
    setExpandedSeasons(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allSelected = files.length > 0 && selectedIds.size === files.length

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-border/50 bg-card/30">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-border/50 bg-card/30">
        <div className="text-sm font-medium text-foreground">No files found</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Try adjusting filters or click Scan to index your library
        </div>
      </div>
    )
  }

  // Build show tree for shows, flat list for movies
  const renderRows = () => {
    if (mediaType !== "show") {
      return files.map(file => (
        <MediaTableRow
          key={file.id}
          file={file}
          isSelected={selectedIds.has(file.id)}
          onToggleSelect={() => onToggleSelect(file.id)}
          onEnqueue={() => onEnqueue(file.id)}
          onTranslate={onTranslate}
        />
      ))
    }

    // Build tree: showName -> seasonKey -> episodes[]
    const showMap = new Map<string, Map<string, MediaFile[]>>()
    for (const f of files) {
      const show = f.show_name || f.folder_name || 'Unknown'
      if (!showMap.has(show)) showMap.set(show, new Map())
      const seasonMap = showMap.get(show)!
      const season = f.folder_name || 'Unknown Season'
      if (!seasonMap.has(season)) seasonMap.set(season, [])
      seasonMap.get(season)!.push(f)
    }

    const rows: React.ReactNode[] = []

    for (const [showName, seasonMap] of showMap) {
      const isShowExpanded = expandedShows.has(showName)
      const totalEpisodes = Array.from(seasonMap.values()).reduce((s, eps) => s + eps.length, 0)
      const allShowIds = Array.from(seasonMap.values()).flat().map(f => f.id)
      const anySelected = allShowIds.some(id => selectedIds.has(id))

      rows.push(
        <tr
          key={`show-${showName}`}
          className="cursor-pointer bg-secondary/30 hover:bg-secondary/50 select-none"
          onClick={() => toggleShow(showName)}
        >
          <td className="px-3 py-2">
            <Checkbox
              checked={anySelected && allShowIds.every(id => selectedIds.has(id))}
              onCheckedChange={(checked) => {
                allShowIds.forEach(id => {
                  const has = selectedIds.has(id)
                  if (checked && !has) onToggleSelect(id)
                  if (!checked && has) onToggleSelect(id)
                })
              }}
              onClick={e => e.stopPropagation()}
            />
          </td>
          <td className="px-3 py-2" colSpan={8}>
            <div className="flex items-center gap-2">
              {isShowExpanded
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              }
              <span className="font-medium text-foreground">{showName}</span>
              <span className="ml-1 text-xs text-muted-foreground">
                {seasonMap.size} season{seasonMap.size !== 1 ? 's' : ''} · {totalEpisodes} ep{totalEpisodes !== 1 ? 's' : ''}
              </span>
            </div>
          </td>
          <td className="w-8 px-2 py-2" />
        </tr>
      )

      if (!isShowExpanded) continue

      for (const [seasonName, episodes] of seasonMap) {
        const seasonKey = `${showName}::${seasonName}`
        const isSeasonExpanded = expandedSeasons.has(seasonKey)
        const allSeasonIds = episodes.map(f => f.id)
        const anySeasonSelected = allSeasonIds.some(id => selectedIds.has(id))

        rows.push(
          <tr
            key={`season-${seasonKey}`}
            className="cursor-pointer bg-secondary/10 hover:bg-secondary/20 select-none"
            onClick={() => toggleSeason(seasonKey)}
          >
            <td className="px-3 py-2 pl-8">
              <Checkbox
                checked={anySeasonSelected && allSeasonIds.every(id => selectedIds.has(id))}
                onCheckedChange={(checked) => {
                  allSeasonIds.forEach(id => {
                    const has = selectedIds.has(id)
                    if (checked && !has) onToggleSelect(id)
                    if (!checked && has) onToggleSelect(id)
                  })
                }}
                onClick={e => e.stopPropagation()}
              />
            </td>
            <td className="px-3 py-2 pl-6" colSpan={8}>
              <div className="flex items-center gap-2">
                {isSeasonExpanded
                  ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                }
                <span className="text-sm font-medium text-foreground/80">{seasonName}</span>
                <span className="text-xs text-muted-foreground">{episodes.length} ep{episodes.length !== 1 ? 's' : ''}</span>
              </div>
            </td>
            <td className="w-8 px-2 py-2" />
          </tr>
        )

        if (!isSeasonExpanded) continue

        for (const ep of episodes) {
          rows.push(
            <MediaTableRow
              key={ep.id}
              file={ep}
              isSelected={selectedIds.has(ep.id)}
              onToggleSelect={() => onToggleSelect(ep.id)}
              onEnqueue={() => onEnqueue(ep.id)}
              onTranslate={onTranslate}
              isEpisode
            />
          )
        }
      }
    }

    return rows
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/50">
      {selectedIds.size > 0 && (
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 bg-accent/5 px-4 py-2">
          <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={onEnqueueSelected}>
              <Play className="mr-1 h-3 w-3" />
              Encode
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onToggleSelectAll()}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
            <tr>
              <th className="w-10 px-3 py-2 text-left">
                <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} />
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {mediaType === "show" ? "Show" : "Title"}
              </th>
              <th className="hidden px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:table-cell">
                File
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Size
              </th>
              <th className="hidden px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:table-cell">
                Res
              </th>
              <th className="hidden px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:table-cell">
                Codec
              </th>
              <th className="hidden px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground xl:table-cell">
                Audio
              </th>
              <th className="hidden px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground xl:table-cell">
                Subs
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </th>
              <th className="w-8 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {renderRows()}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface MediaTableRowProps {
  file: MediaFile
  isSelected: boolean
  onToggleSelect: () => void
  onEnqueue: () => void
  onTranslate: (id: number, subIdx: number) => void
  isEpisode?: boolean
}

function MediaTableRow({ file, isSelected, onToggleSelect, onEnqueue, onTranslate, isEpisode }: MediaTableRowProps) {
  const textSubTracks = file.subtitle_tracks.filter(t =>
    !['hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle','dvb_teletext','eia_608'].includes(t.codec)
  )

  return (
    <tr className={cn(
      "transition-colors hover:bg-secondary/20",
      isSelected && "bg-accent/5",
      isEpisode && "pl-16"
    )}>
      <td className={cn("px-3 py-2", isEpisode && "pl-14")}>
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
      </td>
      <td className="max-w-[200px] px-3 py-2">
        <div className="truncate font-medium text-foreground" title={file.folder_name}>
          {isEpisode
            ? (file.season_episode || file.filename)
            : file.folder_name
          }
        </div>
      </td>
      <td className="hidden max-w-[200px] px-3 py-2 lg:table-cell">
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={file.filename}>
          {file.filename}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="text-xs">
          <span className="font-medium">{formatSize(file.size_gb)}</span>
          {file.estimated_size_gb && !file.encode_status && (
            <span className="ml-1 text-success">-&gt; {formatSize(file.estimated_size_gb)}</span>
          )}
        </div>
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
        {file.video_width && file.video_height ? `${file.video_width}x${file.video_height}` : "-"}
      </td>
      <td className="hidden px-3 py-2 lg:table-cell">
        <span className="text-xs uppercase text-muted-foreground">{file.video_codec || "-"}</span>
      </td>
      <td className="hidden px-3 py-2 xl:table-cell">
        <TrackBadges tracks={file.audio_tracks} type="audio" />
      </td>
      <td className="hidden px-3 py-2 xl:table-cell">
        <TrackBadges tracks={file.subtitle_tracks} type="sub" />
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={file.status} encodeStatus={file.encode_status} />
      </td>
      <td className="px-2 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEnqueue}>
              <Play className="mr-2 h-3.5 w-3.5" />
              Queue Encode
            </DropdownMenuItem>
            {textSubTracks.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {textSubTracks.map(t => (
                  <DropdownMenuItem key={t.sub_idx} onClick={() => onTranslate(file.id, t.sub_idx)}>
                    <Languages className="mr-2 h-3.5 w-3.5" />
                    Translate Sub #{t.sub_idx}{t.lang ? ` (${t.lang.toUpperCase()})` : ''}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  )
}

function formatSize(gb: number): string {
  if (gb < 0.1) return `${(gb * 1024).toFixed(0)} MB`
  if (gb >= 100) return `${gb.toFixed(0)} GB`
  return `${gb.toFixed(1)} GB`
}

function TrackBadges({ tracks, type }: { tracks: any[]; type: 'audio' | 'sub' }) {
  if (tracks.length === 0) return <span className="text-xs text-muted-foreground">-</span>
  const hasUnknown = tracks.some(t => !t.lang)
  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
          hasUnknown ? "bg-warning/20 text-warning" : "bg-secondary text-muted-foreground"
        )}
        title={tracks.map(t => `${t.codec} ${t.lang || '?'}${t.title ? ` (${t.title})` : ''}`).join('\n')}
      >
        {tracks.length}
      </span>
    </div>
  )
}

function StatusBadge({ status, encodeStatus }: { status: string; encodeStatus?: string }) {
  const base = "inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium"
  if (encodeStatus === "encoding") return <span className={cn(base, "animate-pulse bg-accent/20 text-accent")}>Encoding</span>
  if (encodeStatus === "queued")   return <span className={cn(base, "bg-secondary text-muted-foreground")}>Queued</span>
  if (encodeStatus === "done")     return <span className={cn(base, "bg-success/20 text-success")}>Done</span>
  if (encodeStatus === "failed")   return <span className={cn(base, "bg-destructive/20 text-destructive")}>Failed</span>
  if (status === "OK")             return <span className={cn(base, "bg-success/20 text-success")}>OK</span>
  if (status?.includes("RE-ENCODE")) return <span className={cn(base, "bg-destructive/20 text-destructive")}>Re-encode</span>
  if (status?.includes("REMUX"))   return <span className={cn(base, "bg-warning/20 text-warning")}>Remux</span>
  return <span className={cn(base, "bg-secondary text-muted-foreground")}>{status}</span>
}
