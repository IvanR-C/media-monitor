"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LanguageMultiPicker, LanguagePicker } from "./language-picker"
import { SettingRow } from "./settings-controls"
import { toast } from "sonner"
import { AlertCircle, ArrowDown, ArrowUp, Loader2, RefreshCw, Trash2 } from "lucide-react"

/** Mirrors processing.DEFAULTS on the backend (plus the copy-stability wait). */
export const PROCESSING_DEFAULTS = {
  keep_audio_langs: ["eng", "jpn", "spa"] as string[], keep_all_audio_langs: false, keep_untagged_audio: false,
  audio_fallback: "all", keep_sub_langs: ["eng", "spa"] as string[], keep_all_sub_langs: false, keep_untagged_subs: false,
  audio_selection: "best", audio_codec_order: ["truehd", "flac", "dts", "eac3", "ac3", "aac", "opus", "vorbis", "mp3", "mp2"] as string[],
  commentary_audio: "drop", default_audio_lang: "",
  video_encoder: "hevc_nvenc", encode_profile: "balanced", encode_quality: 20, encode_preset: "p4",
  encode_max_height: 1080, encode_10bit: true, encode_lookahead: 20,
  output_policy: "replace", output_dir: "", output_suffix: ".encoded", backup_originals: false,
  backup_retention_days: 30, keep_translated_sidecar: false,
  ntfy_events: ["new_media", "attention", "job_complete", "job_failed", "disc_detected"] as string[],
  discord_events: ["new_media", "attention", "disc_detected"] as string[],
  ntfy_priorities: { new_media: "default", attention: "high", job_complete: "default", job_failed: "high", disc_detected: "default" } as Record<string, string>,
  translation_cache_days: 30, local_ai_timeout: 600, ocr_fallback_lang: "eng", ocr_preset: "standard",
  movie_roots: [] as string[], show_roots: [] as string[], excluded_folders: [] as string[],
  stabilize_interval: 10, stabilize_checks: 3,
}
type Processing = typeof PROCESSING_DEFAULTS
export type ProcessingUpdate = <K extends keyof Processing>(key: K, value: Processing[K], immediate?: boolean) => void
type Field = (key: keyof Processing, label: string, options?: {
  type?: "number" | "text"; placeholder?: string; max?: number; step?: string; maxLength?: number
  validate?: (value: string) => string | undefined
}) => ReactNode
type Props = { config: Processing; update: ProcessingUpdate; field: Field }

const wholeNumber = (min: number, max: number) => (value: string) => {
  const n = Number(value)
  return !value.trim() || !Number.isInteger(n) || n < min || n > max ? `Enter a whole number from ${min} to ${max}.` : undefined
}
const Heading = ({ children, first }: { children: ReactNode; first?: boolean }) =>
  <h3 className={first ? "pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground" : "mt-6 border-t border-border/50 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground"}>{children}</h3>
const Note = ({ children }: { children: ReactNode }) => <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{children}</p>
function Choice({ id, value, onChange, options }: { id: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger id={id} className="w-full bg-input"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}</SelectContent></Select>
}

// ── Tracks & languages ──────────────────────────────────────────────────────
const CODEC_NAMES: Record<string, string> = { truehd: "Dolby TrueHD", flac: "FLAC", dts: "DTS / DTS-HD", eac3: "Dolby Digital Plus", ac3: "Dolby Digital", aac: "AAC", opus: "Opus", vorbis: "Vorbis", mp3: "MP3", mp2: "MP2" }

export function TracksSection({ config, update }: Props) {
  const move = (i: number, by: number) => {
    const next = [...config.audio_codec_order]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    update("audio_codec_order", next, true)
  }
  return <>
    <Heading first>Audio languages</Heading>
    <SettingRow id="keep_all_audio_langs" title="Keep all audio languages" description="Keep every audio language when encoding or ripping. Commentary and track-editor choices still apply." toggle>
      <Switch id="keep_all_audio_langs" checked={config.keep_all_audio_langs} onCheckedChange={v => update("keep_all_audio_langs", v, true)} />
    </SettingRow>
    <div hidden={config.keep_all_audio_langs}>
      <SettingRow id="keep_audio_langs" title="Audio languages to keep" description="Audio in other languages is removed. If you clear the list, the fallback below decides.">
        <LanguageMultiPicker id="keep_audio_langs" label="Audio languages to keep" value={config.keep_audio_langs} onChange={v => update("keep_audio_langs", v, true)} emptyLabel="No languages selected" />
      </SettingRow>
      <SettingRow id="keep_untagged_audio" title="Keep untagged audio" description="Keep audio tracks that have no language tag." toggle>
        <Switch id="keep_untagged_audio" checked={config.keep_untagged_audio} onCheckedChange={v => update("keep_untagged_audio", v, true)} />
      </SettingRow>
      <SettingRow id="audio_fallback" title="When no audio matches" description="Applies when no audio track matches your languages, so a file never ends up without audio.">
        <Choice id="audio_fallback" value={config.audio_fallback} onChange={v => update("audio_fallback", v, true)} options={[["all", "Keep all audio tracks"], ["first", "Keep only the first audio track"]]} />
      </SettingRow>
    </div>

    <Heading>Subtitle languages</Heading>
    <SettingRow id="keep_all_sub_langs" title="Keep all subtitle languages" description="Keep every subtitle track when encoding or ripping." toggle>
      <Switch id="keep_all_sub_langs" checked={config.keep_all_sub_langs} onCheckedChange={v => update("keep_all_sub_langs", v, true)} />
    </SettingRow>
    <div hidden={config.keep_all_sub_langs}>
      <SettingRow id="keep_sub_langs" title="Subtitle languages to keep" description="Subtitles in other languages are removed. If you clear the list, no subtitles are kept.">
        <LanguageMultiPicker id="keep_sub_langs" label="Subtitle languages to keep" value={config.keep_sub_langs} onChange={v => update("keep_sub_langs", v, true)} emptyLabel="No subtitles are kept" />
      </SettingRow>
      <SettingRow id="keep_untagged_subs" title="Keep untagged subtitles" description="Keep subtitle tracks that have no language tag." toggle>
        <Switch id="keep_untagged_subs" checked={config.keep_untagged_subs} onCheckedChange={v => update("keep_untagged_subs", v, true)} />
      </SettingRow>
    </div>

    <Heading>Audio track selection</Heading>
    <SettingRow id="audio_selection" title="Tracks per language" description="Best track keeps one track for each kept language, ranked by codec and then channel count.">
      <Choice id="audio_selection" value={config.audio_selection} onChange={v => update("audio_selection", v, true)} options={[["best", "Best track per language"], ["all", "Keep all matching tracks"]]} />
    </SettingRow>
    <div hidden={config.audio_selection !== "best"}>
      <SettingRow id="audio_codec_order" title="Preferred codecs" description="Highest first. When tracks have the same codec, more channels wins. Unlisted codecs rank last.">
        <ol id="audio_codec_order" aria-label="Preferred audio codecs" className="space-y-1">
          {config.audio_codec_order.map((codec, i) => <li key={codec} className="flex items-center gap-2 rounded-md border border-border/40 px-2 py-1 text-xs">
            <span className="w-4 text-muted-foreground">{i + 1}</span><span className="flex-1">{CODEC_NAMES[codec] || codec}</span>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${CODEC_NAMES[codec] || codec} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${CODEC_NAMES[codec] || codec} down`} disabled={i === config.audio_codec_order.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
          </li>)}
        </ol>
      </SettingRow>
    </div>
    <SettingRow id="commentary_audio" title="Commentary tracks" description="Tracks whose title mentions commentary. Dropped commentary is never chosen as the best track.">
      <Choice id="commentary_audio" value={config.commentary_audio} onChange={v => update("commentary_audio", v, true)} options={[["drop", "Drop commentary"], ["keep", "Keep commentary"]]} />
    </SettingRow>
    <SettingRow id="default_audio_lang" title="Default audio track" description="Mark the first kept track in this language as the default. Leave empty to keep the source's default flags.">
      <LanguagePicker id="default_audio_lang" label="Default audio language" value={config.default_audio_lang} onChange={v => update("default_audio_lang", v, true)} allowUnknown={false} clearable clearLabel="Keep source default" placeholder="Keep source default" />
    </SettingRow>
    <Note>
      How tracks are chosen, in order: <strong>1.</strong> Keep/Drop choices you change in the track editor always win. <strong>2.</strong> Commentary handling. <strong>3.</strong> Language lists and untagged-track options. <strong>4.</strong> Best track or all matching tracks. <strong>5.</strong> The audio fallback when nothing matched.
      {" "}These rules apply to encoding and disc rips. Library → Required subtitles only sets the MISSING LANG status. Remux writes your track-editor choices, and Fix Anime uses its own language filters. Open a file’s details to preview the result before processing.
    </Note>
  </>
}

// ── Encoding ────────────────────────────────────────────────────────────────
type EncoderInfo = { codec: string; backend: string; label: string; available: boolean; reason?: string | null; profiles: Record<string, number>; quality_max: number }

export function EncodingSection({ config, update, field }: Props) {
  const [encoders, setEncoders] = useState<Record<string, EncoderInfo> | null>(null)
  const [checking, setChecking] = useState(false)
  const load = async (refresh = false) => {
    setChecking(true)
    try {
      const response = await fetch(`/api/encoders${refresh ? "?refresh=1" : ""}`)
      if (!response.ok) throw new Error()
      setEncoders((await response.json()).encoders)
    } catch { toast.error("Couldn’t check available encoders") }
    finally { setChecking(false) }
  }
  useEffect(() => { void load() }, [])
  const current = encoders?.[config.video_encoder]
  const profiles = current?.profiles
  const qualityMax = current?.quality_max ?? 51
  return <>
    <Heading first>Encoder</Heading>
    <SettingRow id="video_encoder" title="Video encoder" description="Only encoders that pass a short test encode on this server can be selected.">
      <div className="space-y-2">
        <Select value={config.video_encoder} onValueChange={v => update("video_encoder", v, true)}>
          <SelectTrigger id="video_encoder" className="w-full bg-input"><SelectValue placeholder="Checking encoders…">{current?.label || config.video_encoder}</SelectValue></SelectTrigger>
          <SelectContent>{Object.entries(encoders || {}).map(([name, info]) => <SelectItem key={name} value={name} disabled={!info.available}>
            <span className="flex flex-col"><span>{info.label}</span>{!info.available && <span className="text-[10px] text-muted-foreground">Unavailable · {info.reason}</span>}</span>
          </SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => load(true)}>{checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check again</Button>
      </div>
    </SettingRow>
    {current && !current.available && <p role="alert" className="flex gap-2 py-2 text-xs text-warning"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{current.label} isn’t available on this server: {current.reason} New encodes are blocked until you choose a working encoder.</p>}

    <Heading>Quality</Heading>
    <SettingRow id="encode_profile" title="Quality profile" description={profiles ? `Quality value for this encoder: High quality ${profiles.quality}, Balanced ${profiles.balanced}, Smaller files ${profiles.compact}. Lower values look better and produce larger files.` : "Lower quality values look better and produce larger files."}>
      <Choice id="encode_profile" value={config.encode_profile} onChange={v => update("encode_profile", v, true)} options={[["quality", "High quality"], ["balanced", "Balanced (default)"], ["compact", "Smaller files"], ["custom", "Custom quality value"]]} />
    </SettingRow>
    <div hidden={config.encode_profile !== "custom"}>
      <SettingRow id="encode_quality" title="Quality value" description={`The encoder’s own quality scale, from 0 to ${qualityMax}. Lower is better quality.`}>
        {field("encode_quality", "Quality value", { type: "number", max: qualityMax, validate: wholeNumber(0, qualityMax) })}
      </SettingRow>
    </div>
    <SettingRow id="encode_preset" title="Speed preset" description="Slower presets compress better at the same quality but take longer. For NVENC, these are presets P1–P7.">
      <Choice id="encode_preset" value={config.encode_preset} onChange={v => update("encode_preset", v, true)} options={[["p1", "1 · Fastest"], ["p2", "2"], ["p3", "3"], ["p4", "4 · Balanced (default)"], ["p5", "5"], ["p6", "6"], ["p7", "7 · Slowest, best compression"]]} />
    </SettingRow>
    <SettingRow id="encode_max_height" title="Maximum resolution" description="Taller sources are scaled down to this height, keeping their aspect ratio. Smaller sources are never upscaled.">
      <Choice id="encode_max_height" value={String(config.encode_max_height)} onChange={v => update("encode_max_height", Number(v), true)} options={[["0", "Keep original resolution"], ["2160", "2160p (4K)"], ["1440", "1440p"], ["1080", "1080p (default)"], ["720", "720p"], ["480", "480p"]]} />
    </SettingRow>
    <details className="mt-2 rounded-md border border-border/40 px-3 py-1 [&[open]>summary]:pb-1">
      <summary className="cursor-pointer py-2 text-sm font-medium">Advanced</summary>
      <SettingRow id="encode_10bit" title="10-bit output" description="Reduces banding in gradients. H.264 always uses 8-bit for player compatibility." toggle>
        <Switch id="encode_10bit" checked={config.encode_10bit} onCheckedChange={v => update("encode_10bit", v, true)} />
      </SettingRow>
      <SettingRow id="encode_lookahead" title="Lookahead frames" description="NVENC only. More frames can improve quality but use more GPU memory. Default: 20.">
        {field("encode_lookahead", "Lookahead frames", { type: "number", max: 32, validate: wholeNumber(0, 32) })}
      </SettingRow>
    </details>
    <Note>Ordinary encodes and disc rips use the same encoder and profile. Size estimates and file previews update to match. Queued jobs keep the settings they were queued with.</Note>
  </>
}

// ── Output files ────────────────────────────────────────────────────────────
export function OutputSection({ config, update, field }: Props) {
  const separate = config.output_policy === "separate"
  const [backups, setBackups] = useState<{ count: number; bytes: number } | null>(null)
  const [purging, setPurging] = useState(false)
  const loadBackups = () => fetch("/api/backups").then(r => r.ok ? r.json() : null).then(setBackups).catch(() => {})
  useEffect(() => { void loadBackups() }, [])
  const purge = async (all: boolean) => {
    setPurging(true)
    try {
      const response = await fetch("/api/backups/purge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      toast.success(`Deleted ${data.removed} backup${data.removed === 1 ? "" : "s"}`)
      void loadBackups()
    } catch { toast.error("Couldn’t delete backups") }
    finally { setPurging(false) }
  }
  const example = `Movie${config.output_suffix}.mkv`
  const rows: [string, string][] = [
    ["Encode and remux", separate ? `Writes ${example}; the original is untouched.` : config.backup_originals ? "Replaces the original after verification; the original is kept as Movie.mkv.bak." : "Replaces the original after verification."],
    ["Subtitle translation and added subtitles", separate ? `Writes a copy with the new track as ${example}.` : config.backup_originals ? "Adds the track in place; the original is kept as .bak." : "Adds the track to the original file."],
    ["Fix Anime", separate ? `Writes ${example}; the original is untouched.` : `Rewrites the file in place; MP4 and other containers become .mkv${config.backup_originals ? ", and the original is kept as .bak" : ""}.`],
    ["Disc rip", separate && config.output_dir ? `Always writes a new .mkv, in ${config.output_dir}.` : "Always writes a new .mkv next to the disc image."],
  ]
  return <>
    <Heading first>After processing</Heading>
    <SettingRow id="output_policy" title="Output" description="Every output is verified before anything is replaced. Existing files are never overwritten: a number is added to the new name instead.">
      <Choice id="output_policy" value={config.output_policy} onChange={v => update("output_policy", v, true)} options={[["replace", "Replace original"], ["separate", "Write separate output"]]} />
    </SettingRow>
    <div hidden={!separate}>
      <SettingRow id="output_dir" title="Output folder" description="A folder inside the watch folder, such as Encoded. Subfolders are mirrored. Leave empty to write next to the source.">
        {field("output_dir", "Output folder", { placeholder: "Same folder as the source", maxLength: 500 })}
      </SettingRow>
      <SettingRow id="output_suffix" title="Filename suffix" description={`Added before the extension, for example ${example}. Required when no output folder is set.`}>
        {field("output_suffix", "Filename suffix", { placeholder: ".encoded", maxLength: 40, validate: v => /[\\/:*?"<>|]/.test(v) ? "Remove / \\ : * ? \" < > | from the suffix." : !v.trim() && !config.output_dir ? "Add a suffix or choose an output folder." : undefined })}
      </SettingRow>
    </div>
    <div hidden={separate}>
      <SettingRow id="backup_originals" title="Back up originals" description="Before replacing a file, keep the original beside it as .bak. Backups use as much disk space as the originals." toggle>
        <Switch id="backup_originals" checked={config.backup_originals} onCheckedChange={v => update("backup_originals", v, true)} />
      </SettingRow>
    </div>
    <div hidden={!(config.backup_originals && !separate) && !backups?.count}>
      <SettingRow id="backup_retention_days" title="Keep backups for" description="Older backups made by Media Monitor are deleted automatically. Enter 0 to keep them until you delete them.">
        <div className="flex items-start gap-2">{field("backup_retention_days", "Keep backups for", { type: "number", max: 3650, validate: wholeNumber(0, 3650) })}<span className="pt-2.5 text-sm text-muted-foreground">days</span></div>
      </SettingRow>
    </div>
    {backups && backups.count > 0 && <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-muted-foreground">
      <span>{backups.count} backup{backups.count === 1 ? "" : "s"} · {(backups.bytes / 1e9).toFixed(1)} GB</span>
      <span className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={purging} onClick={() => purge(false)}>Delete expired</Button>
        <Button type="button" variant="outline" size="sm" disabled={purging} onClick={() => purge(true)}><Trash2 className="h-3.5 w-3.5" />Delete all backups</Button>
      </span>
    </div>}
    <SettingRow id="keep_translated_sidecar" title="Keep translated sidecar after muxing" description="Keep the translated .srt next to the video after it’s added to the file. If muxing fails, the sidecar is always kept." toggle>
      <Switch id="keep_translated_sidecar" checked={config.keep_translated_sidecar} onCheckedChange={v => update("keep_translated_sidecar", v, true)} />
    </SettingRow>
    <Heading>What each workflow does</Heading>
    <dl className="mt-3 divide-y divide-border/30 text-xs">
      {rows.map(([name, text]) => <div key={name} className="grid gap-1 py-2.5 sm:grid-cols-[180px_minmax(0,1fr)]"><dt className="font-medium">{name}</dt><dd className="text-muted-foreground">{text}</dd></div>)}
    </dl>
    <Note>Queued jobs keep the output settings they were queued with.</Note>
  </>
}

// ── Notification events ─────────────────────────────────────────────────────
const EVENTS: [string, string][] = [["new_media", "New media"], ["attention", "Needs attention"], ["job_complete", "Job completed"], ["job_failed", "Job failed"], ["disc_detected", "Disc image found"]]
const EVENT_HELP = "Needs attention covers new files flagged RE-ENCODE, REMUX, or MISSING LANG, folders with several videos, and unreadable disc images. A flagged new file sends one notification."

export function NotificationEvents({ config, update, provider }: Props & { provider: "ntfy" | "discord" }) {
  const key = provider === "ntfy" ? "ntfy_events" : "discord_events"
  const events = config[key]
  return <SettingRow id={key} title="Send notifications for" description={provider === "ntfy" ? `${EVENT_HELP} Choose a priority for each event.` : `${EVENT_HELP} Discord doesn’t support priorities.`}>
    <div id={key} role="group" aria-label={`${provider === "ntfy" ? "Ntfy" : "Discord"} events`} className="space-y-2">
      {EVENTS.map(([event, label]) => <div key={event} className="flex items-center gap-2">
        <Checkbox id={`${key}-${event}`} checked={events.includes(event)} onCheckedChange={checked => update(key, checked ? [...events, event] : events.filter(e => e !== event), true)} />
        <label htmlFor={`${key}-${event}`} className="flex-1 text-xs">{label}</label>
        {provider === "ntfy" && <Select value={config.ntfy_priorities[event] || "default"} disabled={!events.includes(event)} onValueChange={v => update("ntfy_priorities", { ...config.ntfy_priorities, [event]: v }, true)}>
          <SelectTrigger aria-label={`${label} priority`} className="h-7 w-28 bg-input text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{[["min", "Min"], ["low", "Low"], ["default", "Default"], ["high", "High"], ["urgent", "Urgent"]].map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>}
      </div>)}
    </div>
  </SettingRow>
}

// ── Translation and OCR operation ───────────────────────────────────────────
export function OcrSettings({ config, update }: Props) {
  return <>
    <Heading>Image subtitles (OCR)</Heading>
    <SettingRow id="ocr_fallback_lang" title="Fallback OCR language" description="Used for image subtitles with a missing or unrecognized language tag. You can also choose a language for one track when you queue it.">
      <LanguagePicker id="ocr_fallback_lang" label="Fallback OCR language" value={config.ocr_fallback_lang} onChange={v => v && update("ocr_fallback_lang", v, true)} allowUnknown={false} />
    </SettingRow>
    <SettingRow id="ocr_preset" title="OCR mode" description="Accurate enlarges small text more and takes longer. Fast suits large, clean subtitles.">
      <Choice id="ocr_preset" value={config.ocr_preset} onChange={v => update("ocr_preset", v, true)} options={[["fast", "Fast"], ["standard", "Standard (default)"], ["accurate", "Accurate"]]} />
    </SettingRow>
  </>
}

// ── Library folder rules and monitoring ─────────────────────────────────────
function FolderList({ id, value, onChange, placeholder }: { id: string; value: string[]; onChange: (value: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value.join("\n"))
  return <Textarea id={id} aria-describedby={`${id}-description`} rows={3} value={draft} placeholder={placeholder} className="bg-input font-mono text-xs"
    onChange={event => { setDraft(event.target.value); onChange(event.target.value.split("\n").map(line => line.trim()).filter(Boolean)) }} />
}

export function LibraryRules({ config, update, field }: Props) {
  return <>
    <Heading>Folder rules</Heading>
    <SettingRow id="movie_roots" title="Movie folders" description="One per line, relative to the watch folder (for example Kids/Films). Everything inside is a movie.">
      <FolderList id="movie_roots" value={config.movie_roots} onChange={v => update("movie_roots", v)} placeholder="Movies/4K" />
    </SettingRow>
    <SettingRow id="show_roots" title="Show folders" description="One per line. The first folder inside is the show name, and SxxEyy in filenames sets the episode.">
      <FolderList id="show_roots" value={config.show_roots} onChange={v => update("show_roots", v)} placeholder="Kids/Cartoons" />
    </SettingRow>
    <SettingRow id="excluded_folders" title="Excluded folders" description="One per line. A name such as Extras or *sample* matches a folder anywhere. A path such as TV/*/Specials matches from the watch folder. Case is ignored.">
      <FolderList id="excluded_folders" value={config.excluded_folders} onChange={v => update("excluded_folders", v)} placeholder={"Extras\nTV/*/Specials"} />
    </SettingRow>
    <Note>Exclusions win, then the deepest movie or show folder, then folder names such as movies/ or shows/, then SxxEyy filenames. Saving applies the rules to files already in the library. Excluded files are removed from the library but stay on disk. After you remove an exclusion, rescan to add those files back.</Note>

    <Heading>New file detection</Heading>
    <SettingRow id="stabilize_interval" title="Check interval" description="While a file is being copied it keeps changing. Media Monitor checks its size this often before processing.">
      <div className="flex items-start gap-2">{field("stabilize_interval", "Check interval", { type: "number", max: 600, validate: wholeNumber(1, 600) })}<span className="pt-2.5 text-sm text-muted-foreground">seconds</span></div>
    </SettingRow>
    <SettingRow id="stabilize_checks" title="Unchanged checks" description={`A file is processed after this many checks in a row with no change, about ${config.stabilize_interval * config.stabilize_checks} seconds after copying stops.`}>
      {field("stabilize_checks", "Unchanged checks", { type: "number", max: 30, validate: wholeNumber(1, 30) })}
    </SettingRow>
    <Note>STABILIZE_INTERVAL and STABILIZE_CHECKS set the starting values on a new installation. Once you save here, these settings take priority. Changes apply to the next check, including files already waiting, and don’t need a restart.</Note>
  </>
}
