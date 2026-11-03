"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AccountSecurityCard } from "@/components/media-monitor/account-security-card"
import { SettingsAutosave, type SaveStatus } from "@/lib/settings-autosave"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Bell, Check, ChevronRight, Languages, Loader2, RefreshCw, Send, ShieldCheck, SlidersHorizontal, AlertCircle } from "lucide-react"

const DEFAULTS = {
  enable_ntfy: true, ntfy_server: "https://ntfy.sh", ntfy_topic: "",
  enable_discord: false, discord_webhook: "", enable_posters: true, tvdb_api_key: "",
  openai_api_key: "", openai_model: "gpt-4o-mini", openai_chunk_size: 350,
  translate_backend: "openai", local_ai_base_url: "", local_ai_model: "", local_ai_chunk_size: 25,
  reencode_size_gb: 20, required_sub_langs: ["eng", "spa"] as string[],
}
type Config = typeof DEFAULTS
const SECTIONS = [
  { id: "translation", title: "AI translation", icon: Languages, description: "Choose how your subtitles are translated." },
  { id: "notifications", title: "Notifications", icon: Bell, description: "Decide where media updates are delivered." },
  { id: "library", title: "Library", icon: SlidersHorizontal, description: "Set file status rules and manage poster artwork." },
  { id: "security", title: "Account & security", icon: ShieldCheck, description: "Manage your password and passkeys. Confirm account actions below." },
] as const
const LANGUAGES = [
  ["eng", "English"], ["spa", "Spanish"], ["jpn", "Japanese"], ["fra", "French"],
  ["deu", "German"], ["ita", "Italian"], ["por", "Portuguese"], ["kor", "Korean"], ["zho", "Chinese"],
]
const validUrl = (value: string) => {
  if (!value) return undefined
  try { if (["http:", "https:"].includes(new URL(value).protocol)) return undefined } catch { /* incomplete address */ }
  return "Enter a complete http:// or https:// URL."
}
const numberRule = (max: number, integer = true) => (value: string) => {
  const n = Number(value)
  return !value.trim() || !Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))
    ? `Enter ${integer ? "a whole number" : "a number"} greater than 0 and up to ${max}.` : undefined
}

export function SettingsTab({ libraryRequest = 0 }: { libraryRequest?: number }) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("translation")
  useEffect(() => { if (libraryRequest) setSection("library") }, [libraryRequest])
  const [config, setConfig] = useState(DEFAULTS)
  const [stats, setStats] = useState<{ total: number; max_workers: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved")
  const [saveError, setSaveError] = useState("")
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const saver = useRef<SettingsAutosave | null>(null)
  if (!saver.current) saver.current = new SettingsAutosave((status, message) => {
    setSaveStatus(status)
    setSaveError(message || "")
  })

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    fetch("/api/config", { signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error(); return r.json() })
      .then(cfg => { if (!controller.signal.aborted) setConfig({ ...DEFAULTS, ...cfg }) })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    // Summary is optional: its failure must not prevent editing settings.
    fetch("/api/stats", { signal: controller.signal }).then(r => r.ok ? r.json() : null)
      .then(data => { if (!controller.signal.aborted) setStats(data) }).catch(() => {})
    return () => controller.abort()
  }, [loadAttempt])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saver.current?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = "" }
    }
    const flush = () => { void saver.current?.flush() }
    window.addEventListener("beforeunload", warn)
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("beforeunload", warn)
      window.removeEventListener("pagehide", flush)
      void saver.current?.flush()
    }
  }, [])

  function update<K extends keyof Config>(key: K, value: Config[K], immediate = false) {
    setConfig(prev => ({ ...prev, [key]: value }))
    saver.current!.change(key, value, immediate)
  }
  const field = (key: keyof Config, label: string, options: {
    type?: "password" | "number" | "text"; placeholder?: string; max?: number; step?: string;
    validate?: (value: string) => string | undefined
  } = {}) => <DraftInput key={key} id={key} label={label} value={String(config[key])} {...options}
    onValidityChange={bad => setInvalid(prev => prev[key] === bad ? prev : { ...prev, [key]: bad })}
    onValueChange={value => update(key, options.type === "number" ? Number(value) : value)} />

  const test = async (service: "ntfy" | "discord" | "local-ai") => {
    setTesting(service)
    try {
      if (!await saver.current!.flush()) return
      const response = await fetch(`/api/test/${service}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        ...(service === "local-ai" ? { body: JSON.stringify({ local_ai_base_url: config.local_ai_base_url, local_ai_model: config.local_ai_model }) } : {}),
      })
      const data = await response.json()
      if (!response.ok || data.status !== "success") throw new Error(data.error || data.message || "Test failed. Check your settings and try again.")
      toast.success(service === "local-ai" ? data.message || "Connected to local AI" : "Test notification sent")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t complete the test") }
    finally { setTesting(null) }
  }
  const relevantInvalid = Object.keys(invalid).filter(key => invalid[key]
    && !(key.startsWith("openai_") && config.translate_backend !== "openai")
    && !(key.startsWith("local_ai_") && config.translate_backend !== "local_ai")
    && !(key.startsWith("ntfy_") && !config.enable_ntfy)
    && !(key === "discord_webhook" && !config.enable_discord)
    && !(key === "tvdb_api_key" && !config.enable_posters))
  const hasInvalid = relevantInvalid.length > 0
  const invalidSection = (id: string) => relevantInvalid.some(key =>
    id === "translation" ? /^(openai_|local_ai_)/.test(key) :
    id === "notifications" ? /^(ntfy_|discord_)/.test(key) : id === "library")
  const testButton = (service: "ntfy" | "discord" | "local-ai", disabled: boolean) => (
    <Button variant="outline" size="sm" onClick={() => test(service)} disabled={!!testing || disabled || relevantInvalid.some(key => service === "local-ai" ? key.startsWith("local_ai_") : service === "ntfy" ? key.startsWith("ntfy_") : key.startsWith("discord_"))}>
      {testing === service ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
      {service === "local-ai" ? "Test connection" : "Send test notification"}
    </Button>
  )
  const active = SECTIONS.find(s => s.id === section)!

  return (
    <div className="mx-auto max-w-6xl pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-5 pt-2">
        <div><h1 className="text-xl font-semibold tracking-tight">Settings</h1><p className="mt-1 text-sm text-muted-foreground">Make it work your way. Changes save automatically.</p></div>
        <div role="status" aria-live="polite" className={cn("flex items-center gap-2 text-xs", saveStatus === "error" ? "text-destructive" : "text-muted-foreground")}>
          {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading settings</> : loadError ? <><AlertCircle className="h-3.5 w-3.5" />Settings unavailable</> : saveStatus === "error" ? <><AlertCircle className="h-3.5 w-3.5" />Couldn’t apply changes</> : hasInvalid ? <><AlertCircle className="h-3.5 w-3.5 text-warning" />Check highlighted fields</> : saveStatus === "saved" ? <><Check className="h-3.5 w-3.5 text-accent" />All changes saved</> : <><Loader2 className="h-3.5 w-3.5 animate-spin" />{saveStatus === "saving" ? "Applying changes…" : "Waiting to save…"}</>}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 pt-5 md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
        <aside className="min-w-0">
          <nav aria-label="Settings sections" className="grid grid-cols-2 gap-1 pb-2 md:sticky md:top-20 md:flex md:flex-col">
            {SECTIONS.map(({ id, title, icon: Icon }) => (
              <button key={id} type="button" aria-current={section === id ? "page" : undefined} aria-controls={`settings-${id}`} onClick={() => setSection(id)}
                className={cn("flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2.5 text-left text-xs transition-colors sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", section === id ? "bg-accent/10 font-medium text-accent" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")}>
                <Icon className="h-4 w-4 shrink-0" />{title}{invalidSection(id) && <AlertCircle aria-label="Has invalid fields" className="h-3.5 w-3.5 text-warning" />}<ChevronRight className={cn("ml-auto hidden h-3.5 w-3.5 md:block", section !== id && "invisible")} />
              </button>
            ))}
          </nav>
        </aside>
        <div className="min-w-0">
          <div className="mb-4"><h2 className="text-base font-medium">{active.title}</h2><p className="mt-1 text-sm text-muted-foreground">{active.description}</p></div>
          {loading ? <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading your configuration…</div> : loadError ? (
            <div role="alert" className="space-y-3 py-6"><p className="text-sm text-muted-foreground">Couldn’t load settings. Check that the backend is reachable.</p><Button variant="outline" size="sm" onClick={() => setLoadAttempt(n => n + 1)}><RefreshCw className="h-3.5 w-3.5" />Try again</Button></div>
          ) : <>
            {saveStatus === "error" && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"><p className="text-sm">{saveError}</p><Button size="sm" variant="outline" onClick={() => saver.current!.flush()}><RefreshCw className="h-3.5 w-3.5" />Retry</Button></div>}
            <section id="settings-translation" hidden={section !== "translation"} aria-label="AI translation">
              <SettingRow id="translate-backend" title="Translation provider" description="Used for new subtitle translation jobs.">
                <Select value={config.translate_backend} onValueChange={value => update("translate_backend", value, true)}><SelectTrigger id="translate-backend" className="w-full bg-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">OpenAI</SelectItem><SelectItem value="local_ai">Local AI · Ollama</SelectItem></SelectContent></Select>
              </SettingRow>
              <div hidden={config.translate_backend !== "openai"}>
                <SettingRow id="openai_api_key" title="API key" description="Your OpenAI key for subtitle translation.">{field("openai_api_key", "API key", { type: "password", placeholder: "sk-…" })}</SettingRow>
                <SettingRow id="openai_model" title="Model" description="Choose a model available to your OpenAI account.">{field("openai_model", "Model", { placeholder: "gpt-4o-mini" })}</SettingRow>
                <SettingRow id="openai_chunk_size" title="Blocks per request" description="Smaller batches can improve reliability. Default: 350.">{field("openai_chunk_size", "Blocks per request", { type: "number", max: 2000, validate: numberRule(2000) })}</SettingRow>
              </div>
              <div hidden={config.translate_backend !== "local_ai"}>
                <SettingRow id="local_ai_base_url" title="Server URL" description="An address the media server can reach, ending in /v1.">{field("local_ai_base_url", "Server URL", { placeholder: "http://localhost:11434/v1", validate: value => validUrl(value) || (value && !value.replace(/\/$/, "").endsWith("/v1") ? "Add /v1 to the end of the URL." : undefined) })}</SettingRow>
                <SettingRow id="local_ai_model" title="Model" description="Use the exact name of a model installed on your server.">{field("local_ai_model", "Local AI model", { placeholder: "qwen2.5:7b" })}</SettingRow>
                <SettingRow id="local_ai_chunk_size" title="Blocks per request" description="Lower this if translation fails with “block count changed”. Default: 25.">{field("local_ai_chunk_size", "Local AI blocks per request", { type: "number", max: 350, validate: numberRule(350) })}</SettingRow>
                <div className="flex justify-end pt-4">{testButton("local-ai", !config.local_ai_base_url || !config.local_ai_model)}</div>
              </div>
              <p className="mt-6 text-xs leading-relaxed text-muted-foreground">Subtitles are currently translated into Cuban Spanish. Provider changes apply to new jobs.</p>
            </section>
            <section id="settings-notifications" hidden={section !== "notifications"} aria-label="Notifications">
              <SettingRow id="enable-ntfy" title="Ntfy" description="Push media updates to an Ntfy topic." toggle><Switch id="enable-ntfy" checked={config.enable_ntfy} onCheckedChange={value => update("enable_ntfy", value, true)} /></SettingRow>
              <div hidden={!config.enable_ntfy}>
                <SettingRow id="ntfy_server" title="Server URL" description="Use ntfy.sh or your own Ntfy server.">{field("ntfy_server", "Ntfy server URL", { placeholder: "https://ntfy.sh", validate: validUrl })}</SettingRow>
                <SettingRow id="ntfy_topic" title="Topic" description="The topic subscribed to on your devices.">{field("ntfy_topic", "Ntfy topic", { placeholder: "my-media-notifications" })}</SettingRow>
                <div className="flex justify-end py-4">{testButton("ntfy", !config.ntfy_server || !config.ntfy_topic)}</div>
              </div>
              <div className="mt-4 border-t border-border/50 pt-2">
                <SettingRow id="enable-discord" title="Discord" description="Post media updates to a Discord channel." toggle><Switch id="enable-discord" checked={config.enable_discord} onCheckedChange={value => update("enable_discord", value, true)} /></SettingRow>
                <div hidden={!config.enable_discord}>
                  <SettingRow id="discord_webhook" title="Webhook URL" description="The incoming webhook for your channel.">{field("discord_webhook", "Discord webhook URL", { type: "password", placeholder: "https://discord.com/api/webhooks/…", validate: validUrl })}</SettingRow>
                  <div className="flex justify-end pt-4">{testButton("discord", !config.discord_webhook)}</div>
                </div>
              </div>
            </section>
            <section id="settings-library" hidden={section !== "library"} aria-label="Library">
              <h3 className="pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">File status rules</h3>
              <SettingRow id="reencode_size_gb" title="Re-encode above" description="Larger files are flagged RE-ENCODE. Statuses refresh automatically.">
                <div className="flex items-start gap-2">{field("reencode_size_gb", "Re-encode above", { type: "number", max: 1024, step: "any", validate: numberRule(1024, false) })}<span className="pt-2.5 text-sm text-muted-foreground">GiB</span></div>
              </SettingRow>
              <SettingRow id="required-languages" title="Required subtitles" description="Files missing a selected language are flagged MISSING LANG.">
                <div id="required-languages" role="group" aria-label="Required subtitle languages" className="flex flex-wrap gap-2">
                  {LANGUAGES.map(([code, label]) => <button key={code} type="button" aria-pressed={config.required_sub_langs.includes(code)} onClick={() => update("required_sub_langs", config.required_sub_langs.includes(code) ? config.required_sub_langs.filter(c => c !== code) : [...config.required_sub_langs, code], true)} className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", config.required_sub_langs.includes(code) ? "border-accent/40 bg-accent/10 text-accent" : "border-border/50 text-muted-foreground hover:text-foreground")}>
                    {config.required_sub_langs.includes(code) && <Check className="h-3 w-3" />}{label}
                  </button>)}
                  {config.required_sub_langs.filter(code => !LANGUAGES.some(([known]) => known === code)).map(code => <button key={code} type="button" aria-pressed="true" onClick={() => update("required_sub_langs", config.required_sub_langs.filter(c => c !== code), true)} className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs text-accent">{code}</button>)}
                </div>
              </SettingRow>
              <h3 className="mt-6 border-t border-border/50 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">Artwork</h3>
              <SettingRow id="enable-posters" title="Poster images" description="Look up artwork from TheTVDB." toggle><Switch id="enable-posters" checked={config.enable_posters} onCheckedChange={value => update("enable_posters", value, true)} /></SettingRow>
              <div hidden={!config.enable_posters}><SettingRow id="tvdb_api_key" title="TVDB API key" description="Required to find poster artwork on TheTVDB.">{field("tvdb_api_key", "TVDB API key", { type: "password", placeholder: "Your TVDB API key" })}</SettingRow></div>
            </section>
            <section id="settings-security" hidden={section !== "security"} aria-label="Account and security"><AccountSecurityCard compact /></section>
          </>}
        </div>
      </div>
      {stats && <footer className="mt-10 flex flex-wrap gap-x-5 gap-y-1 border-t border-border/40 pt-4 text-xs text-muted-foreground"><span>{stats.total.toLocaleString()} files processed</span><span>{stats.max_workers} worker threads</span></footer>}
    </div>
  )
}

function SettingRow({ id, title, description, toggle, children }: { id: string; title: string; description: string; toggle?: boolean; children: ReactNode }) {
  return <div className={cn("flex gap-3 border-b border-border/30 py-4 last:border-b-0", toggle ? "items-center justify-between" : "flex-col sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-6")}>
    <div className="min-w-0"><Label htmlFor={id} className="text-sm font-medium">{title}</Label><p id={`${id}-description`} className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
    <div className={toggle ? "shrink-0" : "min-w-0"}>{children}</div>
  </div>
}

function DraftInput({ id, label, value, type = "text", placeholder, max, step, validate, onValueChange, onValidityChange }: {
  id: string; label: string; value: string; type?: "text" | "password" | "number"; placeholder?: string; max?: number; step?: string;
  validate?: (value: string) => string | undefined; onValueChange: (value: string) => void; onValidityChange: (invalid: boolean) => void
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | undefined>()
  // Loaded values arrive before this field mounts. Keep invalid drafts visible until corrected.
  return <div className="w-full"><Input id={id} aria-label={label} aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`} aria-invalid={!!error} type={type} value={draft} placeholder={placeholder} min={type === "number" ? step === "any" ? 0 : 1 : undefined} max={max} step={step} autoComplete="off" className="h-9 bg-input text-sm" onChange={event => {
    const next = event.target.value
    setDraft(next)
    const message = validate?.(next)
    setError(message)
    onValidityChange(!!message)
    if (!message) onValueChange(next)
  }} />{error && <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive">{error}</p>}</div>
}
