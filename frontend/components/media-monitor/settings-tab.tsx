"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { LanguageMultiPicker, LanguagePicker } from "./language-picker"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AccountSecurityCard } from "@/components/media-monitor/account-security-card"
import { SettingRow, DraftInput } from "./settings-controls"
import { GeminiModelPicker, type GeminiCatalog } from "./gemini-model-picker"
import { EncodingSection, LibraryRules, NotificationEvents, OcrSettings, OutputSection, PROCESSING_DEFAULTS, TracksSection, type ProcessingUpdate } from "./processing-settings"
import { SettingsAutosave, type SaveStatus } from "@/lib/settings-autosave"
import { ANIME_DEFAULTS, AnimeSettingsPanel } from "./anime-settings"
import { onAnimeSettingsSaved, setAnimePrefs } from "./fix-anime-dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { AudioLines, Bell, Check, ChevronRight, Clapperboard, FolderOutput, Languages, Loader2, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Sparkles, AlertCircle } from "lucide-react"

const DEFAULTS = {
  enable_ntfy: true, ntfy_server: "https://ntfy.sh", ntfy_topic: "",
  enable_discord: false, discord_webhook: "", enable_posters: true, tvdb_api_key: "",
  openai_api_key: "", openai_model: "gpt-4o-mini", openai_chunk_size: 350,
  gemini_api_key: "", gemini_model: "gemini-3.5-flash-lite", gemini_chunk_size: 200, gemini_thinking: "default", gemini_requests_per_minute: 15,
  translate_backend: "openai", local_ai_base_url: "", local_ai_model: "", local_ai_chunk_size: 25,
  translation_target_lang: "", translation_variant: "", translation_instructions: "",
  translation_temperature: 0.3, local_ai_thinking: "default", translation_cache_enabled: true,
  reencode_size_gb: 20, required_sub_langs: ["eng", "spa"] as string[],
  anime_settings: ANIME_DEFAULTS,
  ...PROCESSING_DEFAULTS,
}
type Config = typeof DEFAULTS
const SECTIONS = [
  { id: "translation", title: "AI translation", icon: Languages, description: "Choose how your subtitles are translated." },
  { id: "anime", title: "Fix Anime", icon: Sparkles, description: "Choose how Fix Anime styles subtitles and which languages it keeps. Fix Anime buttons in the library run with these settings." },
  { id: "tracks", title: "Tracks & languages", icon: AudioLines, description: "Choose which audio and subtitle tracks survive encoding and disc rips." },
  { id: "encoding", title: "Encoding", icon: Clapperboard, description: "Set the encoder, quality, speed, and resolution for encodes and rips." },
  { id: "output", title: "Output files", icon: FolderOutput, description: "Decide where processed files go and what happens to originals." },
  { id: "notifications", title: "Notifications", icon: Bell, description: "Decide where media updates are delivered and which events notify you." },
  { id: "library", title: "Library", icon: SlidersHorizontal, description: "Set file status rules, folder rules, new-file detection, and poster artwork." },
  { id: "security", title: "Account & security", icon: ShieldCheck, description: "Manage your password and passkeys. Confirm account actions below." },
] as const
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
  const [localModels, setLocalModels] = useState<string[]>([])
  const [geminiCatalog, setGeminiCatalog] = useState<GeminiCatalog | null>(null)
  const [geminiLoading, setGeminiLoading] = useState(false)
  const [geminiError, setGeminiError] = useState("")
  const geminiLoadedKey = useRef<string | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
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

  useEffect(() => onAnimeSettingsSaved(anime_settings => setConfig(prev => ({ ...prev, anime_settings }))), [])

  const loadGeminiModels = async () => {
    setGeminiLoading(true)
    setGeminiError("")
    try {
      const response = await fetch("/api/gemini/models")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Couldn’t load Gemini models")
      setGeminiCatalog(data)
    } catch (error) {
      setGeminiCatalog(null)
      setGeminiError(error instanceof Error ? error.message : "Couldn’t load Gemini models")
    } finally { setGeminiLoading(false) }
  }
  // Load the model list once the key has been saved; the request uses the saved key.
  useEffect(() => {
    const key = config.gemini_api_key
    if (config.translate_backend !== "gemini" || !key || saveStatus !== "saved" || geminiLoadedKey.current === key) return
    geminiLoadedKey.current = key
    void loadGeminiModels()
  }, [config.translate_backend, config.gemini_api_key, saveStatus])

  function update<K extends keyof Config>(key: K, value: Config[K], immediate = false) {
    if (key === "gemini_api_key") { setGeminiCatalog(null); setGeminiError(""); geminiLoadedKey.current = null }
    if (key === "local_ai_base_url") setLocalModels([])
    if (key === "anime_settings") setAnimePrefs({ configured: true, mode: (value as Config["anime_settings"]).mode })
    setConfig(prev => ({ ...prev, [key]: value }))
    saver.current!.change(key, value, immediate)
  }
  const field = (key: keyof Config, label: string, options: {
    type?: "password" | "number" | "text"; placeholder?: string; max?: number; step?: string; maxLength?: number; list?: string;
    validate?: (value: string) => string | undefined
  } = {}) => <DraftInput key={key} id={key} label={label} value={String(config[key])} {...options}
    onValidityChange={bad => setInvalid(prev => prev[key] === bad ? prev : { ...prev, [key]: bad })}
    onValueChange={value => update(key, options.type === "number" ? Number(value) : value)} />

  type TestService = "ntfy" | "discord" | "local-ai" | "gemini"
  const test = async (service: TestService) => {
    setTesting(service)
    try {
      if (!await saver.current!.flush()) return
      const response = await fetch(`/api/test/${service}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        ...(service === "local-ai" ? { body: JSON.stringify({ local_ai_base_url: config.local_ai_base_url, local_ai_model: config.local_ai_model }) } : {}),
      })
      const data = await response.json()
      if (!response.ok || data.status !== "success") throw new Error(data.error || data.message || "Test failed. Check your settings and try again.")
      if (service === "local-ai") setLocalModels(data.models || [])
      if (service === "gemini" && data.models) setGeminiCatalog({ models: data.models, as_of: data.as_of })
      toast.success(service === "local-ai" ? data.message || "Connected to local AI"
        : service === "gemini" ? data.message || "Gemini key works" : "Test notification sent")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t complete the test") }
    finally { setTesting(null) }
  }
  const relevantInvalid = Object.keys(invalid).filter(key => invalid[key]
    && !(key.startsWith("openai_") && config.translate_backend !== "openai")
    && !(key.startsWith("gemini_") && config.translate_backend !== "gemini")
    && !(key.startsWith("local_ai_") && config.translate_backend !== "local_ai")
    && !(key.startsWith("ntfy_") && !config.enable_ntfy)
    && !(key === "discord_webhook" && !config.enable_discord)
    && !(key === "tvdb_api_key" && !config.enable_posters)
    && !(key === "encode_quality" && config.encode_profile !== "custom")
    && !(key.startsWith("output_") && config.output_policy !== "separate"))
  const hasInvalid = relevantInvalid.length > 0
  const invalidSection = (id: string) => relevantInvalid.some(key =>
    id === "translation" ? /^(openai_|gemini_|local_ai_|translation_)/.test(key) :
    id === "notifications" ? /^(ntfy_|discord_)/.test(key) :
    id === "encoding" ? key.startsWith("encode_") :
    id === "output" ? /^(output_|backup_)/.test(key) :
    id === "library" && /^(reencode_|stabilize_|tvdb_)/.test(key))
  const testPrefix = { "local-ai": "local_ai_", gemini: "gemini_", ntfy: "ntfy_", discord: "discord_" }
  const testButton = (service: TestService, disabled: boolean) => (
    <Button variant="outline" size="sm" onClick={() => test(service)} disabled={!!testing || disabled || relevantInvalid.some(key => key.startsWith(testPrefix[service]))}>
      {testing === service ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
      {service === "local-ai" || service === "gemini" ? "Test connection" : "Send test notification"}
    </Button>
  )
  const active = SECTIONS.find(s => s.id === section)!
  const sectionProps = { config, update: update as ProcessingUpdate, field }

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
              <SettingRow id="translation_target_lang" title="Target language" description="Choose the language for new translations. No language is selected by default.">
                <LanguagePicker id="translation_target_lang" label="Translation target language" value={config.translation_target_lang} onChange={value => update("translation_target_lang", value, true)} allowUnknown={false} clearable placeholder="Choose a language…" />
              </SettingRow>
              {!config.translation_target_lang && <p role="status" className="py-3 text-xs text-warning">Choose a target language before queueing subtitle translations.</p>}
              <SettingRow id="translation_variant" title="Regional style or dialect" description="Optional. Leave blank for natural language without a requested regional style.">
                {field("translation_variant", "Regional style or dialect", { placeholder: "e.g. Latin American, Canadian, or Brazilian", maxLength: 120 })}
              </SettingRow>
              <SettingRow id="translation_instructions" title="Translation instructions" description="Optional terminology, tone, names, or character context. These preferences are included in each request.">
                <Textarea id="translation_instructions" aria-describedby="translation_instructions-description" rows={3} maxLength={4000} value={config.translation_instructions} onChange={event => update("translation_instructions", event.target.value)} placeholder="e.g. Keep character names unchanged and preserve informal dialogue." className="bg-input text-sm" />
              </SettingRow>
              <SettingRow id="translate-backend" title="Translation provider" description="Used for new subtitle translation jobs.">
                <Select value={config.translate_backend} onValueChange={value => update("translate_backend", value, true)}><SelectTrigger id="translate-backend" className="w-full bg-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">OpenAI</SelectItem><SelectItem value="gemini">Google Gemini · free tier available</SelectItem><SelectItem value="local_ai">Local AI · Ollama / compatible server</SelectItem></SelectContent></Select>
              </SettingRow>
              <div hidden={config.translate_backend !== "openai"}>
                <SettingRow id="openai_api_key" title="API key" description="Your OpenAI key for subtitle translation.">{field("openai_api_key", "API key", { type: "password", placeholder: "sk-…" })}</SettingRow>
                <SettingRow id="openai_model" title="Model" description="Choose a model available to your OpenAI account.">{field("openai_model", "Model", { placeholder: "gpt-4o-mini" })}</SettingRow>
                <SettingRow id="openai_chunk_size" title="Blocks per request" description="Smaller batches can improve reliability. Default: 350.">{field("openai_chunk_size", "Blocks per request", { type: "number", max: 2000, validate: numberRule(2000) })}</SettingRow>
              </div>
              <div hidden={config.translate_backend !== "gemini"}>
                <SettingRow id="gemini_api_key" title="API key" description={<>Create a free key in <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Google AI Studio</a>. On the free tier, Google may use requests to improve its products.</>}>{field("gemini_api_key", "Gemini API key", { type: "password", placeholder: "AIza…" })}</SettingRow>
                <SettingRow id="gemini_model" title="Model" description="Models your key can use. Flash-Lite models have the largest free daily quota.">
                  <GeminiModelPicker value={config.gemini_model} onChange={value => update("gemini_model", value, true)} catalog={geminiCatalog}
                    loading={geminiLoading} error={geminiError} onReload={() => void loadGeminiModels()} requestsPerMinute={config.gemini_requests_per_minute} />
                </SettingRow>
                <SettingRow id="gemini_chunk_size" title="Blocks per request" description="Larger batches use fewer of your daily requests. Lower this if responses are incomplete. Default: 200.">{field("gemini_chunk_size", "Gemini blocks per request", { type: "number", max: 1000, validate: numberRule(1000) })}</SettingRow>
                <SettingRow id="gemini_requests_per_minute" title="Requests per minute" description="Requests are spaced to stay under your quota, shown under Rate limit in AI Studio. Free tier Flash-Lite: 15.">{field("gemini_requests_per_minute", "Gemini requests per minute", { type: "number", max: 1000, validate: numberRule(1000) })}</SettingRow>
                <SettingRow id="gemini_thinking" title="Thinking level" description="Minimal is fastest and usually enough for subtitles. Gemini 3 models can't turn thinking fully off.">
                  <Select value={config.gemini_thinking} onValueChange={value => update("gemini_thinking", value, true)}><SelectTrigger id="gemini_thinking" className="bg-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Model default</SelectItem><SelectItem value="minimal">Minimal</SelectItem><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select>
                </SettingRow>
                <div className="flex justify-end pt-4">{testButton("gemini", !config.gemini_api_key)}</div>
              </div>
              <div hidden={config.translate_backend !== "local_ai"}>
                <SettingRow id="local_ai_base_url" title="Server URL" description="An address the media server can reach, ending in /v1.">{field("local_ai_base_url", "Server URL", { placeholder: "http://localhost:11434/v1", validate: value => validUrl(value) || (value && !value.replace(/\/$/, "").endsWith("/v1") ? "Add /v1 to the end of the URL." : undefined) })}</SettingRow>
                <SettingRow id="local_ai_model" title="Model" description="Use an installed instruction-following model that can return JSON. Test the connection to load model suggestions.">{field("local_ai_model", "Local AI model", { placeholder: "Exact installed model name", list: "local-ai-models" })}<datalist id="local-ai-models">{localModels.map(model => <option key={model} value={model} />)}</datalist></SettingRow>
                <SettingRow id="local_ai_chunk_size" title="Blocks per request" description="Lower this if responses are incomplete or cue validation fails. Default: 25.">{field("local_ai_chunk_size", "Local AI blocks per request", { type: "number", max: 350, validate: numberRule(350) })}</SettingRow>
                <SettingRow id="local_ai_thinking" title="Thinking mode" description="Off avoids extra reasoning on compatible models such as Qwen 3. Available levels depend on the model and server; leave at model default for other servers.">
                  <Select value={config.local_ai_thinking} onValueChange={value => update("local_ai_thinking", value, true)}><SelectTrigger id="local_ai_thinking" className="bg-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Model default</SelectItem><SelectItem value="none">Off</SelectItem><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select>
                </SettingRow>
                <SettingRow id="local_ai_timeout" title="Request timeout" description="How long to wait for each response before the chunk fails. Raise it for slow hardware or large chunks. Default: 600.">
                  <div className="flex items-start gap-2">{field("local_ai_timeout", "Local AI request timeout", { type: "number", max: 7200, validate: value => !value.trim() || !Number.isInteger(Number(value)) || Number(value) < 30 || Number(value) > 7200 ? "Enter a whole number from 30 to 7200." : undefined })}<span className="pt-2.5 text-sm text-muted-foreground">seconds</span></div>
                </SettingRow>
                <div className="flex justify-end pt-4">{testButton("local-ai", !config.local_ai_base_url || !config.local_ai_model)}</div>
              </div>
              <SettingRow id="translation_temperature" title="Temperature" description="Controls variation in wording, from 0 to 2. Lower values favor consistency. Default: 0.3.">
                {field("translation_temperature", "Translation temperature", { type: "number", max: 2, step: "any", validate: value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 2 ? "Enter a number from 0 to 2." : undefined })}
              </SettingRow>
              <SettingRow id="translation_cache_enabled" title="Reuse completed chunks" description={`Save valid translations for ${config.translation_cache_days} days so retries can reuse completed work. Source, model, language, style, and generation settings must match.`} toggle>
                <Switch id="translation_cache_enabled" checked={config.translation_cache_enabled} onCheckedChange={value => update("translation_cache_enabled", value, true)} />
              </SettingRow>
              <div hidden={!config.translation_cache_enabled}>
                <SettingRow id="translation_cache_days" title="Keep saved translations for" description="Older saved chunks are translated again the next time they’re needed. Default: 30.">
                  <div className="flex items-start gap-2">{field("translation_cache_days", "Keep saved translations for", { type: "number", max: 365, validate: value => !value.trim() || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 365 ? "Enter a whole number from 1 to 365." : undefined })}<span className="pt-2.5 text-sm text-muted-foreground">days</span></div>
                </SettingRow>
              </div>
              <div className="flex justify-end pt-4"><Button variant="outline" size="sm" disabled={clearingCache} onClick={async () => {
                setClearingCache(true)
                try {
                  const response = await fetch("/api/translate/cache/clear", { method: "POST" })
                  const data = await response.json()
                  if (!response.ok) throw new Error(data.error || "Couldn’t clear saved translations")
                  toast.success(`Cleared ${data.deleted} saved translation chunk(s)`)
                } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t clear saved translations") }
                finally { setClearingCache(false) }
              }}>{clearingCache && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Clear saved translations</Button></div>
              <OcrSettings {...sectionProps} />
              <p className="mt-6 text-xs leading-relaxed text-muted-foreground">Language, style, provider, model, generation, and OCR preferences are saved with each queued job. Changes apply to new jobs. Translation-specialist models with a different prompt format may need a dedicated integration.</p>
            </section>
            <section id="settings-anime" hidden={section !== "anime"} aria-label="Fix Anime">
              <AnimeSettingsPanel settings={{ ...ANIME_DEFAULTS, ...config.anime_settings }} fallbackTarget={config.translation_target_lang} onChange={value => update("anime_settings", value)} />
            </section>
            <section id="settings-tracks" hidden={section !== "tracks"} aria-label="Tracks and languages"><TracksSection {...sectionProps} /></section>
            <section id="settings-encoding" hidden={section !== "encoding"} aria-label="Encoding"><EncodingSection {...sectionProps} /></section>
            <section id="settings-output" hidden={section !== "output"} aria-label="Output files"><OutputSection {...sectionProps} /></section>
            <section id="settings-notifications" hidden={section !== "notifications"} aria-label="Notifications">
              <SettingRow id="enable-ntfy" title="Ntfy" description="Push media updates to an Ntfy topic." toggle><Switch id="enable-ntfy" checked={config.enable_ntfy} onCheckedChange={value => update("enable_ntfy", value, true)} /></SettingRow>
              <div hidden={!config.enable_ntfy}>
                <SettingRow id="ntfy_server" title="Server URL" description="Use ntfy.sh or your own Ntfy server.">{field("ntfy_server", "Ntfy server URL", { placeholder: "https://ntfy.sh", validate: validUrl })}</SettingRow>
                <SettingRow id="ntfy_topic" title="Topic" description="The topic subscribed to on your devices.">{field("ntfy_topic", "Ntfy topic", { placeholder: "my-media-notifications" })}</SettingRow>
                <NotificationEvents {...sectionProps} provider="ntfy" />
                <div className="flex justify-end py-4">{testButton("ntfy", !config.ntfy_server || !config.ntfy_topic)}</div>
              </div>
              <div className="mt-4 border-t border-border/50 pt-2">
                <SettingRow id="enable-discord" title="Discord" description="Post media updates to a Discord channel." toggle><Switch id="enable-discord" checked={config.enable_discord} onCheckedChange={value => update("enable_discord", value, true)} /></SettingRow>
                <div hidden={!config.enable_discord}>
                  <SettingRow id="discord_webhook" title="Webhook URL" description="The incoming webhook for your channel.">{field("discord_webhook", "Discord webhook URL", { type: "password", placeholder: "https://discord.com/api/webhooks/…", validate: validUrl })}</SettingRow>
                  <NotificationEvents {...sectionProps} provider="discord" />
                  <div className="flex justify-end pt-4">{testButton("discord", !config.discord_webhook)}</div>
                </div>
              </div>
            </section>
            <section id="settings-library" hidden={section !== "library"} aria-label="Library">
              <h3 className="pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">File status rules</h3>
              <SettingRow id="reencode_size_gb" title="Re-encode above" description="Larger files are flagged RE-ENCODE. Statuses refresh automatically.">
                <div className="flex items-start gap-2">{field("reencode_size_gb", "Re-encode above", { type: "number", max: 1024, step: "any", validate: numberRule(1024, false) })}<span className="pt-2.5 text-sm text-muted-foreground">GiB</span></div>
              </SettingRow>
              <SettingRow id="required-languages" title="Required subtitles" description="Files missing a selected language are flagged MISSING LANG. This sets status only; Tracks & languages decides which tracks are kept.">
                <LanguageMultiPicker id="required-languages" label="Required subtitle languages" value={config.required_sub_langs} onChange={value => update("required_sub_langs", value, true)} emptyLabel="No required subtitle languages" />
              </SettingRow>
              <h3 className="mt-6 border-t border-border/50 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">Artwork</h3>
              <SettingRow id="enable-posters" title="Poster images" description="Look up artwork from TheTVDB." toggle><Switch id="enable-posters" checked={config.enable_posters} onCheckedChange={value => update("enable_posters", value, true)} /></SettingRow>
              <div hidden={!config.enable_posters}><SettingRow id="tvdb_api_key" title="TVDB API key" description="Required to find poster artwork on TheTVDB.">{field("tvdb_api_key", "TVDB API key", { type: "password", placeholder: "Your TVDB API key" })}</SettingRow></div>
              <LibraryRules {...sectionProps} />
            </section>
            <section id="settings-security" hidden={section !== "security"} aria-label="Account and security"><AccountSecurityCard compact /></section>
          </>}
        </div>
      </div>
      {stats && <footer className="mt-10 flex flex-wrap gap-x-5 gap-y-1 border-t border-border/40 pt-4 text-xs text-muted-foreground"><span>{stats.total.toLocaleString()} files processed</span><span>{stats.max_workers} worker threads</span></footer>}
    </div>
  )
}
