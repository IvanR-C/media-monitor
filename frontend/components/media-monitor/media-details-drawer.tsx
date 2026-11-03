"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { languageLabel, normalizeLanguage } from "@/lib/languages"
import { cn } from "@/lib/utils"
import { AlertCircle, ArrowRight, Check, Film, ImageOff, Loader2, RefreshCw, Tag, Subtitles, Download, Languages, Play } from "lucide-react"
import type { MediaFile, AudioTrack, SubtitleTrack } from "./media-library-tab"

type Details = MediaFile & {
  filepath: string; duration_seconds: number; format_name?: string
  missing_subtitle_langs: string[]; sidecar_subtitle_langs: string[]; reencode_threshold_gib: number
  posters_enabled: boolean; poster_lookup_available: boolean
  encoding_preview: { audio_tracks: AudioTrack[]; subtitle_tracks: SubtitleTrack[]; excluded_tracks: number }
}
const IMAGE_SUBS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "dvb_teletext", "eia_608"])
const activeTranslation = (status?: string) => !!status && !["done", "failed", "cancelled"].includes(status)
const safeImage = (url?: string) => !!url && (/^https?:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//")))
const titleFor = (file: MediaFile) => file.show_name || file.folder_name || file.filename
const formatBytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
const duration = (seconds?: number) => !seconds ? "Unknown runtime" : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}h ` : ""}${Math.floor(seconds % 3600 / 60)}m`

export function MediaDetailsDrawer({ file, onClose, onManageTracks, onAddSubtitle, onEnqueue, onRip, onTranslate, onDownloadSubtitle, onRefresh, onOpenPosterSettings, onRestoreFocus }: {
  file: MediaFile | null; onClose: () => void; onManageTracks: (file: MediaFile) => void
  onAddSubtitle: (file: MediaFile) => void; onEnqueue: (id: number) => void; onRip: (id: number) => void
  onTranslate: (id: number, subIdx: number) => void; onDownloadSubtitle: (id: number, subIdx: number, ocr: boolean) => void
  onRefresh: () => void; onOpenPosterSettings?: () => void; onRestoreFocus: () => void
}) {
  const [details, setDetails] = useState<Details | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [posterBusy, setPosterBusy] = useState(false)
  const [posterError, setPosterError] = useState("")
  const [imageBroken, setImageBroken] = useState(false)
  const attemptedPosters = useRef(new Set<number>())
  const launchingAction = useRef(false)
  const latestId = useRef(file?.id)
  latestId.current = file?.id

  useEffect(() => {
    if (!file) return
    const id = file.id
    const controller = new AbortController()
    launchingAction.current = false
    setDetails(null); setLoading(true); setError(""); setPosterError(""); setImageBroken(false); setPosterBusy(false)
    const load = async () => {
      try {
        const response = await fetch(`/api/media/${id}`, { signal: controller.signal })
        if (!response.ok) throw new Error("Couldn’t load file details. Try again.")
        const data: Details = await response.json()
        if (controller.signal.aborted) return
        setDetails(data); setLoading(false)
        if (!data.poster_url && data.poster_lookup_available && !attemptedPosters.current.has(id)) {
          attemptedPosters.current.add(id)
          setPosterBusy(true)
          try {
            const posterResponse = await fetch(`/api/media/${id}/poster`, { method: "POST", signal: controller.signal })
            const result = await posterResponse.json()
            if (!posterResponse.ok) throw new Error(result.error || "Couldn’t find artwork.")
            if (!controller.signal.aborted) { setDetails(previous => previous && ({ ...previous, poster_url: result.poster_url })); onRefresh() }
          } catch (err) { if (!controller.signal.aborted) setPosterError(err instanceof Error ? err.message : "Couldn’t find artwork.") }
          finally { if (!controller.signal.aborted) setPosterBusy(false) }
        }
      } catch (err) {
        if (!controller.signal.aborted) { setError(err instanceof Error ? err.message : "Couldn’t load details."); setLoading(false) }
      }
    }
    void load()
    return () => controller.abort()
    // The refresh callback belongs to the library; reload when the selected file or its job state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, file?.encode_status, file?.translate_status, attempt])

  async function refreshPoster() {
    if (!file) return
    const id = file.id
    setPosterBusy(true); setPosterError(""); setImageBroken(false)
    try {
      const response = await fetch(`/api/media/${id}/poster`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Couldn’t find artwork.")
      if (latestId.current === id) { setDetails(previous => previous && ({ ...previous, poster_url: result.poster_url })); onRefresh() }
    } catch (err) { if (latestId.current === id) setPosterError(err instanceof Error ? err.message : "Couldn’t find artwork.") }
    finally { if (latestId.current === id) setPosterBusy(false) }
  }
  function launch(action: () => void) { launchingAction.current = true; onClose(); action() }
  function viewQueue() {
    launch(() => requestAnimationFrame(() => {
      const queue = document.getElementById("library-queue")
      queue?.scrollIntoView({ block: "nearest", behavior: "smooth" }); queue?.focus({ preventScroll: true })
    }))
  }

  const current = file && details?.id === file.id ? details : null
  const encodeStatus = current?.encode_status ?? file?.encode_status
  const busy = !!file && (["queued", "encoding"].includes(encodeStatus || "") || activeTranslation(current?.translate_status ?? file.translate_status))
  const title = file ? titleFor(file) : "File details"
  const unknown = current ? [...current.audio_tracks, ...current.subtitle_tracks].filter(track => track.action !== "drop" && !normalizeLanguage(track.lang)).length : 0
  const oversized = !!current && (current.size_bytes || 0) > current.reencode_threshold_gib * 1024 ** 3
  const unsupported = file?.status === "UNPROCESSABLE"
  const missing = current?.missing_subtitle_langs || []
  const hasPoster = !!current?.posters_enabled && safeImage(current.poster_url) && !imageBroken
  const previewArt = current?.poster_url?.startsWith("/demo-posters/")
  const canAct = !!current && !loading && !unsupported
  let primaryLabel = "Manage tracks"
  let primaryAction = () => { if (file) launch(() => onManageTracks(file)) }
  if (busy) { primaryLabel = "View queue"; primaryAction = viewQueue }
  else if (file?.disc_type) { primaryLabel = "Rip to MKV"; primaryAction = () => launch(() => onRip(file.id)) }
  else if (unknown) { primaryLabel = "Assign track languages" }
  else if (oversized) { primaryLabel = "Queue encode"; primaryAction = () => { if (file) launch(() => onEnqueue(file.id)) } }
  else if (missing.length) { primaryLabel = "Add subtitle file"; primaryAction = () => { if (file) launch(() => onAddSubtitle(file)) } }

  return <Sheet open={!!file} onOpenChange={open => { if (!open) onClose() }}>
    <SheetContent className="w-full gap-0 overflow-hidden sm:w-[560px] sm:max-w-[calc(100vw-24px)]" onCloseAutoFocus={event => { event.preventDefault(); if (!launchingAction.current) onRestoreFocus() }}>
      <SheetHeader className="shrink-0 border-b border-border/50 px-6 py-4 pr-12">
        <SheetTitle className="text-sm">File details</SheetTitle><SheetDescription className="sr-only">Artwork, file information, status explanations and track actions for {title}.</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-5 px-5 py-6 sm:grid-cols-[136px_minmax(0,1fr)] sm:px-6">
          <div>
            <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-border/50 bg-secondary/40 shadow-lg">
              {hasPoster ? <img key={current?.poster_url} src={current?.poster_url} alt={`${title} poster`} width={272} height={408} referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setImageBroken(true)} /> : <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center text-muted-foreground"><ImageOff className="h-6 w-6 opacity-50" /><span className="text-[10px]">{posterBusy ? "Finding artwork…" : current && !current.posters_enabled ? "Artwork is off" : imageBroken ? "Artwork unavailable" : "No poster yet"}</span></div>}
              {posterBusy && <div className="absolute inset-0 flex items-center justify-center bg-background/50"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>}
            </div>
            {hasPoster && <p className="mt-2 text-center text-[10px] text-muted-foreground">{previewArt ? "Preview artwork" : <a href="https://thetvdb.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">Artwork: TheTVDB</a>}</p>}
          </div>
          <div className="min-w-0 py-1">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-accent">{file?.media_type === "show" ? "TV series" : file?.disc_type ? "Disc image" : "Movie"}</p>
            <h2 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h2>
            {file?.season_episode && <p className="mt-2 text-sm text-muted-foreground">{file.folder_name} · {file.season_episode}</p>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{current ? `${duration(current.duration_seconds)} · ${current.video_height ? `${current.video_height}p` : "Unknown resolution"} · ${current.video_codec?.toUpperCase() || "Unknown codec"}` : "Loading file information…"}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">{(file?.status || "").split(" | ").map(status => <span key={status} className={cn("rounded px-2 py-1 text-[10px] font-medium", status === "OK" ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground")}>{status === "MISSING LANG" ? "Missing subtitles" : status}</span>)}</div>
            {current && <div className="mt-4">
              {current.poster_lookup_available ? <button type="button" disabled={posterBusy} onClick={refreshPoster} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent disabled:opacity-50"><RefreshCw className={cn("h-3 w-3", posterBusy && "animate-spin")} />{hasPoster ? "Refresh poster" : "Find poster"}</button> : onOpenPosterSettings && <button type="button" onClick={() => launch(onOpenPosterSettings)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-accent">Poster settings<ArrowRight className="h-3 w-3" /></button>}
            </div>}
          </div>
        </div>
        {posterError && <p role="status" className="mx-5 mb-4 text-xs leading-relaxed text-muted-foreground sm:mx-6">{posterError}</p>}
        {!hasPoster && current && !posterBusy && !posterError && <p className="mx-5 mb-5 text-xs leading-relaxed text-muted-foreground sm:mx-6">{!current.posters_enabled ? "Enable poster images in Settings → Library." : !current.poster_lookup_available ? "Add your TVDB API key in Settings → Library to find movie and series artwork." : "No artwork is saved for this title yet."}</p>}
        {loading ? <div role="status" className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading details…</div> : error ? <div role="alert" className="space-y-3 px-6 py-5"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : current && <div className="space-y-6 px-5 pb-6 sm:px-6">
          <section aria-label="Status explanations" className="border-y border-border/40 py-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">{unsupported ? "Manual attention needed" : busy ? "Work in progress" : unknown || oversized || missing.length || file?.has_sibling_videos ? "Needs attention" : "Ready to enjoy"}</h3>
            <div className="space-y-3">
              {busy && <Reason>{encodeStatus === "queued" ? "A media job is queued. Open the queue to follow its progress." : "A media job is running. The library updates as it progresses."}</Reason>}
              {unsupported && <Reason> This disc image cannot be analyzed. Extract or decrypt it with your media tools, then scan the resulting video.</Reason>}
              {!unsupported && unknown > 0 && <Reason>{unknown} retained track{unknown === 1 ? " has" : "s have"} no language tag. Assign a language or mark the track to drop before remuxing.</Reason>}
              {!unsupported && oversized && <Reason>File size is {((current.size_bytes || 0) / 1024 ** 3).toFixed(1)} GiB, above your {current.reencode_threshold_gib} GiB rule. Encoding can reduce its size.</Reason>}
              {!unsupported && missing.length > 0 && <Reason>Missing {missing.map(languageLabel).join(", ")} subtitles. Translate a suitable track below or add a subtitle file.</Reason>}
              {!!file?.has_sibling_videos && <Reason>There are multiple video files in this folder. Check which version you want to process.</Reason>}
              {!unsupported && !busy && !unknown && !oversized && !missing.length && !file?.has_sibling_videos && <div className="flex items-center gap-2 text-sm"><Check className="h-4 w-4 text-success" />Tagged tracks and required subtitles are present. No action needed.</div>}
              {current.sidecar_subtitle_langs.length > 0 && <p className="text-xs text-muted-foreground">External subtitle files provide: {current.sidecar_subtitle_langs.map(languageLabel).join(", ")}.</p>}
            </div>
          </section>
          <section aria-label="File information"><h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">File</h3><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><Info label="Size">{formatBytes(current.size_bytes || 0)}</Info><Info label="Container">{current.format_name || "Unknown"}</Info><Info label="Resolution">{current.video_width && current.video_height ? `${current.video_width} × ${current.video_height}` : "Unknown"}</Info><Info label="Runtime">{duration(current.duration_seconds)}</Info></dl><p className="mt-4 break-all rounded-md bg-secondary/35 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">{current.filepath}</p>{current.estimated_size_gb && <p className="mt-2 text-xs text-muted-foreground">Estimated after encoding: {current.estimated_size_gb.toFixed(1)} GB. Actual results vary.</p>}</section>
          {!unsupported && (oversized || file?.disc_type) && <section aria-label="Encoding track preview" className="border-y border-border/40 py-4"><h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">What encoding keeps</h3><div className="space-y-2 text-xs leading-relaxed"><p><span className="text-muted-foreground">Audio: </span>{current.encoding_preview.audio_tracks.map(track => `${languageLabel(track.lang)} (${track.codec.toUpperCase()})`).join(", ") || "None"}</p><p><span className="text-muted-foreground">Subtitles: </span>{current.encoding_preview.subtitle_tracks.map(track => languageLabel(track.lang)).join(", ") || "None"}</p>{current.encoding_preview.excluded_tracks > 0 && <p className="text-warning">{current.encoding_preview.excluded_tracks} track{current.encoding_preview.excluded_tracks === 1 ? " is" : "s are"} excluded by the current encoding rules.</p>}<p className="text-muted-foreground">Encoding keeps the best approved audio track per language. Remux Keep/Drop choices are shown separately below.</p></div></section>}
          <section aria-label="Audio tracks"><div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Audio · {current.audio_tracks.length}</h3>{canAct && !busy && <button type="button" onClick={() => launch(() => onManageTracks(file!))} className="text-xs text-accent hover:underline">Manage tracks</button>}</div><TrackList tracks={current.audio_tracks} /></section>
          <section aria-label="Subtitle tracks"><div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Subtitles · {current.subtitle_tracks.length}</h3>{canAct && !busy && <button type="button" onClick={() => launch(() => onAddSubtitle(file!))} className="text-xs text-accent hover:underline">Add subtitle file</button>}</div><TrackList tracks={current.subtitle_tracks} renderActions={track => {
            const sub = track as SubtitleTrack
            const image = IMAGE_SUBS.has(sub.codec)
            const supported = !image || sub.codec === "hdmv_pgs_subtitle"
            return supported && sub.action !== "drop" ? <div className="mt-2 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={() => launch(() => onTranslate(file!.id, sub.sub_idx))} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-40"><Languages className="h-3 w-3" />{image ? "OCR & translate to Spanish" : "Translate to Spanish"}</button><button type="button" disabled={busy} onClick={() => launch(() => onDownloadSubtitle(file!.id, sub.sub_idx, image))} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"><Download className="h-3 w-3" />{image ? "OCR & download" : "Download"}</button></div> : null
          }} /></section>
        </div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-background px-5 py-4 sm:px-6"><Button variant="ghost" onClick={onClose}>Close</Button>{canAct && <Button onClick={primaryAction} className="gap-2">{busy ? <ArrowRight className="h-4 w-4" /> : unknown ? <Tag className="h-4 w-4" /> : oversized || file?.disc_type ? <Play className="h-4 w-4" /> : missing.length ? <Subtitles className="h-4 w-4" /> : <Film className="h-4 w-4" />}{primaryLabel}</Button>}</div>
    </SheetContent>
  </Sheet>
}
function Reason({ children }: { children: ReactNode }) { return <div className="flex items-start gap-2 text-sm leading-relaxed"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p>{children}</p></div> }
function Info({ label, children }: { label: string; children: ReactNode }) { return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 text-foreground">{children}</dd></div> }
function TrackList({ tracks, renderActions }: { tracks: (AudioTrack | SubtitleTrack)[]; renderActions?: (track: AudioTrack | SubtitleTrack) => ReactNode }) {
  return tracks.length ? <div className="divide-y divide-border/30">{tracks.map((track, index) => <div key={index} className="py-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className={cn("text-sm", track.action === "drop" && "text-muted-foreground line-through")}>{languageLabel(track.lang)} <span className="ml-1 font-mono text-[10px] text-muted-foreground">{track.lang?.toUpperCase() || "UND"}</span></p><p className="mt-1 text-xs text-muted-foreground">#{"audio_idx" in track ? track.audio_idx : track.sub_idx} · {track.codec === "hdmv_pgs_subtitle" ? "PGS · Image subtitles" : track.codec.toUpperCase()}{"channels" in track && track.channels ? ` · ${track.channels}ch` : ""}{track.title ? ` · ${track.title}` : ""}</p></div><span className={cn("shrink-0 rounded px-1.5 py-1 text-[10px]", track.action === "drop" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground")}>{track.action === "drop" ? "Drop on remux" : "Keep on remux"}</span></div>{renderActions?.(track)}</div>)}</div> : <p className="py-3 text-xs text-muted-foreground">No embedded tracks found.</p>
}
