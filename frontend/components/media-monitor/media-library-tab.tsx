"use client"

import { useState, useMemo, useEffect, useCallback } from "react"
import { LibraryStats } from "./library-stats"
import { MediaTypeSwitch } from "./media-type-switch"
import { FilterBar } from "./filter-bar"
import { MediaTable } from "./media-table"
import { CombinedQueue } from "./encode-queue"
import { AppLogs } from "./app-logs"
import { toast } from "sonner"

export type MediaType = "movie" | "show"
export type FilterType = "all" | "needs_encoding" | "needs_remux" | "missing_lang" | "queued" | "done" | "alerts"

export interface MediaFile {
  id: number
  folder_name: string
  filename: string
  size_gb: number
  estimated_size_gb?: number
  video_width?: number
  video_height?: number
  video_codec?: string
  audio_tracks: AudioTrack[]
  subtitle_tracks: SubtitleTrack[]
  status: string
  encode_status?: string
  encode_progress?: number
  encode_job_type?: 'encode' | 'remux'
  translate_status?: string
  translate_progress?: number
  poster_url?: string
  media_type: "movie" | "show"
  show_name?: string
  season_episode?: string
}

export interface AudioTrack {
  audio_idx: number
  codec: string
  lang?: string
  channels?: number
  title?: string
  action?: 'keep' | 'drop'
}

export interface SubtitleTrack {
  sub_idx: number
  codec: string
  lang?: string
  title?: string
  action?: 'keep' | 'drop'
}

interface LibraryStatsData {
  total_files: number
  total_bytes: number
  needs_encoding: number
  encoding_active: number
}

export function MediaLibraryTab() {
  const [mediaType, setMediaType] = useState<MediaType>("movie")
  const [filter, setFilter] = useState<FilterType>("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [isScanning, setIsScanning] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [files, setFiles] = useState<MediaFile[]>([])
  const [stats, setStats] = useState<LibraryStatsData>({ total_files: 0, total_bytes: 0, needs_encoding: 0, encoding_active: 0 })
  const [loading, setLoading] = useState(false)

  const fetchMedia = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const params = new URLSearchParams({ type: mediaType, filter })
      if (searchQuery) params.set('search', searchQuery)
      const data = await fetch(`/api/media?${params}`).then(r => r.json())
      setFiles(data.files ?? [])
      if (data.stats) setStats(data.stats)
    } catch {
      if (!silent) toast.error('Failed to load media library')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [mediaType, filter, searchQuery])

  useEffect(() => {
    fetchMedia()
  }, [fetchMedia])

  // Auto-refresh every 3 s while any encode or translation job is active — silent so the table never blinks
  const hasActiveJobs = files.some(f =>
    f.encode_status === 'encoding' || f.encode_status === 'queued' ||
    (f.translate_status != null && !['done', 'failed', 'cancelled'].includes(f.translate_status))
  )
  useEffect(() => {
    if (!hasActiveJobs) return
    const id = setInterval(() => fetchMedia(true), 3000)
    return () => clearInterval(id)
  }, [hasActiveJobs, fetchMedia])

  // Recompute filter counts from current file list (approximate — full counts need separate query)
  const filterCounts = useMemo(() => {
    const all = files
    return {
      all: all.length,
      needs_encoding: all.filter(f => f.status?.includes('RE-ENCODE')).length,
      needs_remux: all.filter(f => f.status?.includes('REMUX')).length,
      missing_lang: all.filter(f => f.status?.includes('MISSING LANG')).length,
      queued: all.filter(f => f.encode_status === 'queued' || f.encode_status === 'encoding').length,
      done: all.filter(f => f.encode_status === 'done').length,
      alerts: all.filter(f => f.audio_tracks.some(t => !t.lang) || f.subtitle_tracks.some(t => !t.lang)).length,
    }
  }, [files])

  const handleRecalculate = async () => {
    try {
      const r = await fetch('/api/media/recalculate-status', { method: 'POST' })
      const data = await r.json()
      toast.success(`Status recalculated for ${data.updated} files`)
      fetchMedia()
    } catch {
      toast.error('Recalculate failed')
    }
  }

  const handleScan = async () => {
    setIsScanning(true)
    try {
      await fetch('/api/media/scan', { method: 'POST' })
      toast.success('Scan started')
      // Poll scan status
      const poll = setInterval(async () => {
        const st = await fetch('/api/media/scan/status').then(r => r.json())
        if (!st.running) {
          clearInterval(poll)
          setIsScanning(false)
          fetchMedia()
        }
      }, 2000)
    } catch {
      toast.error('Scan failed to start')
      setIsScanning(false)
    }
  }

  const handleEnqueueSelected = async () => {
    if (selectedIds.size === 0) return
    try {
      const r = await fetch('/api/encode/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: Array.from(selectedIds) }),
      })
      const data = await r.json()
      toast.success(`Queued ${data.count} file(s) for encoding`)
      setSelectedIds(new Set())
      fetchMedia()
    } catch {
      toast.error('Failed to queue files')
    }
  }

  const handleEnqueueSingle = async (id: number) => {
    try {
      const r = await fetch('/api/encode/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: [id] }),
      })
      const data = await r.json()
      if (data.count > 0) {
        toast.success('Queued for encoding')
        fetchMedia()
      } else {
        toast.info('Already queued')
      }
    } catch {
      toast.error('Failed to queue file')
    }
  }

  const handleTranslateSingle = async (id: number, subIdx: number) => {
    try {
      const r = await fetch(`/api/media/${id}/translate-subtitle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub_idx: subIdx }),
      })
      const data = await r.json()
      if (r.ok) {
        toast.success('Translation queued')
        fetchMedia(true)
      } else {
        toast.error(data.error || 'Failed to queue translation')
      }
    } catch {
      toast.error('Failed to queue translation')
    }
  }

  const handleAssignTracks = async (fileId: number, audio: any[], subs: any[]) => {
    try {
      const r = await fetch(`/api/media/${fileId}/assign-tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, subtitles: subs }),
      })
      const data = await r.json()
      if (!r.ok && r.status !== 207) throw new Error(data.error || 'Failed')
      if (r.status === 207) {
        // Assignments saved but remux queue failed
        toast.warning(data.error || 'Languages saved but remux could not be queued')
      } else {
        toast.success('Languages saved — remux queued to apply changes to file')
      }
      // Optimistically mark this file as remux-queued so the row shows feedback
      // immediately, even if the current filter would remove it from view.
      setFiles(prev => prev.map(f =>
        f.id === fileId
          ? { ...f, encode_status: 'queued', encode_job_type: 'remux' }
          : f
      ))
      fetchMedia(true)
    } catch {
      toast.error('Failed to save track languages')
    }
  }

  const TEXT_SUB_CODECS_EXCLUDE = new Set([
    'hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle','dvb_teletext','eia_608'
  ])

  const handleTranslateSelected = async () => {
    if (selectedIds.size === 0) return
    let queued = 0
    let skipped = 0
    for (const id of selectedIds) {
      const file = files.find(f => f.id === id)
      if (!file) { skipped++; continue }
      const textSubs = file.subtitle_tracks.filter(t => !TEXT_SUB_CODECS_EXCLUDE.has(t.codec))
      if (textSubs.length === 0) { skipped++; continue }
      // Prefer first non-eng/spa track, fall back to first text track
      const target =
        textSubs.find(t => !['eng', 'spa'].includes((t.lang ?? '').toLowerCase())) ??
        textSubs[0]
      try {
        const r = await fetch(`/api/media/${id}/translate-subtitle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sub_idx: target.sub_idx }),
        })
        if (r.ok) queued++
        else skipped++
      } catch {
        skipped++
      }
    }
    if (queued > 0) {
      toast.success(`Queued ${queued} file(s) for translation`)
      fetchMedia(true)
    }
    if (skipped > 0) toast.info(`${skipped} file(s) skipped (no translatable subtitle)`)
    setSelectedIds(new Set())
  }

  const toggleSelect = (id: number) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) newSelected.delete(id)
    else newSelected.add(id)
    setSelectedIds(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === files.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(files.map(f => f.id)))
  }

  return (
    <div className="flex h-[calc(100vh-220px)] flex-col">
      <LibraryStats stats={stats} />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <MediaTypeSwitch value={mediaType} onChange={setMediaType} />
        <FilterBar
          value={filter}
          onChange={setFilter}
          counts={filterCounts}
          isScanning={isScanning}
          onScan={handleScan}
          onRecalculate={handleRecalculate}
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
          onToggleSelectAll={toggleSelectAll}
          onEnqueue={handleEnqueueSingle}
          onEnqueueSelected={handleEnqueueSelected}
          onTranslate={handleTranslateSingle}
          onTranslateSelected={handleTranslateSelected}
          onAssignTracks={handleAssignTracks}
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
  )
}
