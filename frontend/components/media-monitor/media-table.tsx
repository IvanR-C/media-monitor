"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { MoreHorizontal, Play, Languages, ChevronRight, ChevronDown, Tag } from "lucide-react"
import type { MediaFile, MediaType, AudioTrack, SubtitleTrack } from "./media-library-tab"

const IMAGE_CODECS = new Set([
  'hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle','dvb_teletext','eia_608',
])

const LANG_OPTIONS = [
  { value: '__none__', label: '— Unknown —' },
  { value: 'eng', label: 'English' },
  { value: 'spa', label: 'Spanish' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'deu', label: 'German' },
  { value: 'fra', label: 'French' },
  { value: 'por', label: 'Portuguese' },
  { value: 'ita', label: 'Italian' },
  { value: 'zho', label: 'Chinese' },
  { value: 'kor', label: 'Korean' },
  { value: 'rus', label: 'Russian' },
  { value: 'ara', label: 'Arabic' },
  { value: 'hin', label: 'Hindi' },
]

interface MediaTableProps {
  files: MediaFile[]
  selectedIds: Set<number>
  onToggleSelect: (id: number) => void
  onToggleSelectAll: () => void
  onEnqueue: (id: number) => void
  onEnqueueSelected: () => void
  onTranslate: (id: number, subIdx: number) => void
  onTranslateSelected: () => void
  onAssignTracks: (id: number, audio: any[], subs: any[]) => Promise<void>
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
  onTranslateSelected,
  onAssignTracks,
  mediaType,
  loading,
}: MediaTableProps) {
  const [expandedShows, setExpandedShows] = useState<Set<string>>(new Set())
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(new Set())
  const [assignDialogFile, setAssignDialogFile] = useState<MediaFile | null>(null)

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

  // Compute how many selected files have translatable (text-based) subtitle tracks
  const selectedFiles = files.filter(f => selectedIds.has(f.id))
  const translatableSelectedCount = selectedFiles.filter(f =>
    f.subtitle_tracks.some(t => !IMAGE_CODECS.has(t.codec))
  ).length

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
          onOpenAssignDialog={setAssignDialogFile}
        />
      ))
    }

    // Natural sort helper — sorts "Season 2" before "Season 10"
    const naturalSort = (a: string, b: string) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

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

    // Sort shows alphabetically, seasons naturally, episodes by season_episode
    const sortedShows = Array.from(showMap.keys()).sort(naturalSort)
    for (const [, seasonMap] of showMap) {
      const sortedSeasons = Array.from(seasonMap.keys()).sort(naturalSort)
      for (const season of sortedSeasons) {
        const eps = seasonMap.get(season)!
        eps.sort((a, b) => naturalSort(a.season_episode ?? a.filename, b.season_episode ?? b.filename))
      }
      // Rebuild seasonMap in sorted order
      const sorted = new Map(sortedSeasons.map(s => [s, seasonMap.get(s)!]))
      seasonMap.clear()
      for (const [k, v] of sorted) seasonMap.set(k, v)
    }

    const rows: React.ReactNode[] = []

    for (const showName of sortedShows) {
      const seasonMap = showMap.get(showName)!
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
              onOpenAssignDialog={setAssignDialogFile}
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
            {translatableSelectedCount > 0 && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onTranslateSelected}>
                <Languages className="mr-1 h-3 w-3" />
                Translate {translatableSelectedCount > 1 ? `${translatableSelectedCount}` : ""}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onToggleSelectAll()}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-10" />
            <col className="w-[22%]" />
            <col className="hidden lg:table-column w-[22%]" />
            <col className="w-[10%]" />
            <col className="hidden md:table-column w-[9%]" />
            <col className="hidden lg:table-column w-[7%]" />
            <col className="hidden xl:table-column w-[6%]" />
            <col className="hidden xl:table-column w-[6%]" />
            <col className="w-[14%]" />
            <col className="w-8" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
            <tr>
              <th className="px-3 py-2 text-left">
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
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {renderRows()}
          </tbody>
        </table>
      </div>

      <TrackAssignDialog
        file={assignDialogFile}
        open={assignDialogFile !== null}
        onClose={() => setAssignDialogFile(null)}
        onSave={async (file, audio, subs) => {
          await onAssignTracks(file.id, audio, subs)
          setAssignDialogFile(null)
        }}
      />
    </div>
  )
}

interface MediaTableRowProps {
  file: MediaFile
  isSelected: boolean
  onToggleSelect: () => void
  onEnqueue: () => void
  onTranslate: (id: number, subIdx: number) => void
  onOpenAssignDialog: (file: MediaFile) => void
  isEpisode?: boolean
}

function MediaTableRow({
  file,
  isSelected,
  onToggleSelect,
  onEnqueue,
  onTranslate,
  onOpenAssignDialog,
  isEpisode,
}: MediaTableRowProps) {
  const textSubTracks = file.subtitle_tracks.filter(t => !IMAGE_CODECS.has(t.codec))

  return (
    <tr className={cn(
      "transition-colors hover:bg-secondary/20",
      isSelected && "bg-accent/5",
      isEpisode && "pl-16"
    )}>
      <td className={cn("px-3 py-2", isEpisode && "pl-14")}>
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
      </td>
      <td className="overflow-hidden px-3 py-2">
        <div
          className="truncate font-medium text-foreground"
          title={isEpisode ? (file.season_episode || file.filename) : file.folder_name}
        >
          {isEpisode
            ? (file.season_episode || file.filename)
            : file.folder_name
          }
        </div>
      </td>
      <td className="hidden overflow-hidden px-3 py-2 lg:table-cell">
        <span
          className="block truncate font-mono text-[11px] text-muted-foreground"
          title={file.filename}
        >
          {file.filename}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="text-xs">
          <span className="font-medium">{formatSize(file.size_gb)}</span>
          {file.estimated_size_gb && !file.encode_status && (
            <span className="ml-1 text-success">→ {formatSize(file.estimated_size_gb)}</span>
          )}
        </div>
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
        {file.video_width && file.video_height ? `${file.video_width}×${file.video_height}` : "-"}
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpenAssignDialog(file)}>
              <Tag className="mr-2 h-3.5 w-3.5" />
              Assign Languages
            </DropdownMenuItem>
            {textSubTracks.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {textSubTracks.map(t => (
                  <DropdownMenuItem key={t.sub_idx} onClick={() => onTranslate(file.id, t.sub_idx)}>
                    <Languages className="mr-2 h-3.5 w-3.5" />
                    Translate #{t.sub_idx}{t.lang ? ` (${t.lang.toUpperCase()})` : ''}
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

function TrackBadges({ tracks, type }: { tracks: AudioTrack[] | SubtitleTrack[]; type: 'audio' | 'sub' }) {
  if (tracks.length === 0) return <span className="text-xs text-muted-foreground">-</span>
  const hasUnknown = tracks.some(t => !t.lang)
  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
          hasUnknown ? "bg-warning/20 text-warning" : "bg-secondary text-muted-foreground"
        )}
        title={tracks.map(t => `${t.codec} ${t.lang || '?'}${('title' in t && t.title) ? ` (${t.title})` : ''}`).join('\n')}
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

  // Collect all active flags — a file can have multiple issues
  const hasReEncode   = status?.includes("RE-ENCODE")
  const hasRemux      = status?.includes("REMUX")
  const hasMissingLang = status?.includes("MISSING LANG")

  if (!hasReEncode && !hasRemux && !hasMissingLang) {
    if (status === "OK") return <span className={cn(base, "bg-success/20 text-success")}>OK</span>
    return <span className={cn(base, "bg-secondary text-muted-foreground")}>{status}</span>
  }

  return (
    <div className="flex flex-wrap gap-0.5">
      {hasReEncode    && <span className={cn(base, "bg-destructive/20 text-destructive")}>Re-encode</span>}
      {hasRemux       && <span className={cn(base, "bg-warning/20 text-warning")}>Remux</span>}
      {hasMissingLang && <span className={cn(base, "bg-sky-500/15 text-sky-400")}>Missing Sub</span>}
    </div>
  )
}

// ── Track Assignment Dialog ──────────────────────────────────────────────────

interface TrackState {
  lang: string
  action: 'keep' | 'drop'
}

function TrackRow({
  label,
  lang,
  action,
  onLangChange,
  onActionChange,
}: {
  label: string
  lang: string
  action: 'keep' | 'drop'
  onLangChange: (v: string) => void
  onActionChange: (v: 'keep' | 'drop') => void
}) {
  const selectValue = lang || '__none__'
  return (
    <div className="flex items-center gap-2 border-b border-border/20 py-1.5 last:border-0">
      <span className="w-36 shrink-0 font-mono text-[11px] text-muted-foreground truncate" title={label}>
        {label}
      </span>
      <Select
        value={selectValue}
        onValueChange={v => onLangChange(v === '__none__' ? '' : v)}
      >
        <SelectTrigger className="h-7 flex-1 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANG_OPTIONS.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        onClick={() => onActionChange(action === 'drop' ? 'keep' : 'drop')}
        className={cn(
          "shrink-0 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
          action === 'drop'
            ? "bg-destructive/20 text-destructive hover:bg-destructive/30"
            : "bg-secondary text-muted-foreground hover:bg-secondary/60"
        )}
      >
        {action === 'drop' ? 'Drop' : 'Keep'}
      </button>
    </div>
  )
}

function TrackAssignDialog({
  file,
  open,
  onClose,
  onSave,
}: {
  file: MediaFile | null
  open: boolean
  onClose: () => void
  onSave: (file: MediaFile, audio: any[], subs: any[]) => Promise<void>
}) {
  const [audioState, setAudioState] = useState<Map<number, TrackState>>(new Map())
  const [subState,   setSubState]   = useState<Map<number, TrackState>>(new Map())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!file) return
    const am = new Map<number, TrackState>()
    for (const t of file.audio_tracks)
      am.set(t.audio_idx, { lang: t.lang || '', action: t.action || 'keep' })
    setAudioState(am)

    const sm = new Map<number, TrackState>()
    for (const t of file.subtitle_tracks)
      sm.set(t.sub_idx, { lang: t.lang || '', action: t.action || 'keep' })
    setSubState(sm)
  }, [file])

  if (!file) return null

  const handleSave = async () => {
    setSaving(true)
    try {
      const audio = file.audio_tracks.map(t => ({
        audio_idx: t.audio_idx,
        lang:   audioState.get(t.audio_idx)?.lang   ?? t.lang   ?? '',
        action: audioState.get(t.audio_idx)?.action ?? 'keep',
      }))
      const subs = file.subtitle_tracks.map(t => ({
        sub_idx: t.sub_idx,
        lang:   subState.get(t.sub_idx)?.lang   ?? t.lang   ?? '',
        action: subState.get(t.sub_idx)?.action ?? 'keep',
      }))
      await onSave(file, audio, subs)
    } finally {
      setSaving(false)
    }
  }

  const updateAudio = (idx: number, patch: Partial<TrackState>) =>
    setAudioState(m => new Map(m).set(idx, { ...m.get(idx)!, ...patch }))

  const updateSub = (idx: number, patch: Partial<TrackState>) =>
    setSubState(m => new Map(m).set(idx, { ...m.get(idx)!, ...patch }))

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Track Languages</DialogTitle>
          <DialogDescription className="truncate text-xs">{file.folder_name}</DialogDescription>
        </DialogHeader>

        <div className="mt-1 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {file.audio_tracks.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Audio Tracks
              </p>
              {file.audio_tracks.map(t => {
                const state = audioState.get(t.audio_idx)
                return (
                  <TrackRow
                    key={t.audio_idx}
                    label={`#${t.audio_idx} · ${t.codec}${t.channels ? ` · ${t.channels}ch` : ''}`}
                    lang={state?.lang ?? t.lang ?? ''}
                    action={state?.action ?? 'keep'}
                    onLangChange={v => updateAudio(t.audio_idx, { lang: v })}
                    onActionChange={a => updateAudio(t.audio_idx, { action: a })}
                  />
                )
              })}
            </div>
          )}

          {file.subtitle_tracks.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Subtitle Tracks
              </p>
              {file.subtitle_tracks.map(t => {
                const state   = subState.get(t.sub_idx)
                const isImage = IMAGE_CODECS.has(t.codec)
                return (
                  <TrackRow
                    key={t.sub_idx}
                    label={`#${t.sub_idx} · ${t.codec}${isImage ? ' (img)' : ''}`}
                    lang={state?.lang ?? t.lang ?? ''}
                    action={state?.action ?? 'keep'}
                    onLangChange={v => updateSub(t.sub_idx, { lang: v })}
                    onActionChange={a => updateSub(t.sub_idx, { action: a })}
                  />
                )
              })}
            </div>
          )}

          {file.audio_tracks.length === 0 && file.subtitle_tracks.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No audio or subtitle tracks found.
            </p>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Assignments'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
