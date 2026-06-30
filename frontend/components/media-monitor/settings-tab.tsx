"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import {
  Activity,
  CheckCircle2,
  Cpu,
  Bell,
  MessageSquare,
  Image,
  Languages,
  Save,
  RefreshCw,
  Send,
  SlidersHorizontal
} from "lucide-react"

const COMMON_SUB_LANGS: { code: string; label: string }[] = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "jpn", label: "Japanese" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "kor", label: "Korean" },
  { code: "zho", label: "Chinese" },
]

export function SettingsTab() {
  const [config, setConfig] = useState({
    enable_ntfy: true,
    ntfy_server: "https://ntfy.sh",
    ntfy_topic: "",
    enable_discord: false,
    discord_webhook: "",
    enable_posters: true,
    tvdb_api_key: "",
    openai_api_key: "",
    openai_model: "gpt-4o-mini",
    reencode_size_gb: 20,
    required_sub_langs: ["eng", "spa"] as string[],
  })
  // Snapshot of threshold fields at last load — diffed on save to decide whether
  // we need to trigger a status recompute (cheap but visible blip in the UI).
  const initialThresholdsRef = useRef<{ size: number; langs: string }>({ size: 20, langs: "eng,spa" })
  const [stats, setStats] = useState({ total: 0, by_status: {} as Record<string, number>, max_workers: 4 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const load = async (attempt = 1) => {
      try {
        const [cfg, st] = await Promise.all([
          fetch('/api/config').then(r => { if (!r.ok) throw new Error(`config ${r.status}`); return r.json() }),
          fetch('/api/stats').then(r =>   { if (!r.ok) throw new Error(`stats ${r.status}`);  return r.json() }),
        ])
        if (cancelled) return
        setConfig(prev => ({ ...prev, ...cfg }))
        setStats(st)
        initialThresholdsRef.current = {
          size: Number(cfg.reencode_size_gb ?? 20),
          langs: [...(cfg.required_sub_langs ?? ["eng", "spa"])].sort().join(","),
        }
        setLoading(false)
      } catch {
        if (cancelled) return
        // Retry up to 5 times with increasing delay (handles Docker startup ordering
        // where the frontend container comes up before the backend is fully ready).
        if (attempt < 5) {
          retryTimer = setTimeout(() => load(attempt + 1), attempt * 1500)
        } else {
          setLoading(false)
          toast.error('Failed to load config — is the backend reachable?')
        }
      }
    }

    load()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  const handleSave = async () => {
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        toast.error(data.error || "Failed to save configuration")
        return
      }
      // If thresholds changed, recompute status across all rows so the library
      // pills (Re-encode / Missing Sub) reflect the new rules immediately.
      const sizeNow = Number(config.reencode_size_gb)
      const langsNow = [...config.required_sub_langs].sort().join(",")
      const thresholdsChanged =
        sizeNow !== initialThresholdsRef.current.size ||
        langsNow !== initialThresholdsRef.current.langs
      if (thresholdsChanged) {
        try {
          await fetch('/api/media/recalculate-status', { method: 'POST' })
          initialThresholdsRef.current = { size: sizeNow, langs: langsNow }
          toast.success("Configuration saved — recomputed file statuses")
        } catch {
          toast.success("Configuration saved (status recompute failed)")
        }
      } else {
        toast.success("Configuration saved")
      }
    } catch {
      toast.error("Failed to save configuration")
    }
  }

  const handleReload = async () => {
    try {
      const [cfg, st] = await Promise.all([
        fetch('/api/config').then(r => r.json()),
        fetch('/api/stats').then(r => r.json()),
      ])
      setConfig(prev => ({ ...prev, ...cfg }))
      setStats(st)
      toast.info("Configuration reloaded")
    } catch {
      toast.error("Failed to reload configuration")
    }
  }

  const handleTestNtfy = async () => {
    try {
      await fetch('/api/test/ntfy', { method: 'POST' })
      toast.success("Test notification sent to Ntfy")
    } catch {
      toast.error("Failed to send test notification")
    }
  }

  const handleTestDiscord = async () => {
    try {
      const r = await fetch('/api/test/discord', { method: 'POST' })
      const data = await r.json()
      if (data.status === 'success') toast.success("Test notification sent to Discord")
      else toast.error(data.message || "Failed")
    } catch {
      toast.error("Failed to send test notification")
    }
  }

  const okCount = stats.by_status?.['OK'] ?? 0

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Activity}
          value={stats.total.toLocaleString()}
          label="Files Processed"
        />
        <StatCard
          icon={CheckCircle2}
          value={okCount.toLocaleString()}
          label="OK"
          variant="success"
        />
        <StatCard
          icon={Cpu}
          value={stats.max_workers?.toString() ?? '4'}
          label="Worker Threads"
        />
      </div>

      {/* Ntfy Configuration */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Bell className="h-4 w-4 text-accent" />
            Ntfy Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="enable-ntfy" className="text-sm">Enable Ntfy Notifications</Label>
            <Switch
              id="enable-ntfy"
              checked={config.enable_ntfy}
              onCheckedChange={(checked) => setConfig({ ...config, enable_ntfy: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ntfy-server" className="text-sm text-muted-foreground">Ntfy Server URL</Label>
            <Input
              id="ntfy-server"
              placeholder="https://ntfy.sh"
              value={config.ntfy_server}
              onChange={(e) => setConfig({ ...config, ntfy_server: e.target.value })}
              className="bg-input"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ntfy-topic" className="text-sm text-muted-foreground">Ntfy Topic</Label>
            <Input
              id="ntfy-topic"
              placeholder="my-media-notifications"
              value={config.ntfy_topic}
              onChange={(e) => setConfig({ ...config, ntfy_topic: e.target.value })}
              className="bg-input"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleTestNtfy} className="mt-2">
            <Send className="mr-2 h-3.5 w-3.5" />
            Test Ntfy
          </Button>
        </CardContent>
      </Card>

      {/* Discord Configuration */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <MessageSquare className="h-4 w-4 text-accent" />
            Discord Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="enable-discord" className="text-sm">Enable Discord Notifications</Label>
            <Switch
              id="enable-discord"
              checked={config.enable_discord}
              onCheckedChange={(checked) => setConfig({ ...config, enable_discord: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="discord-webhook" className="text-sm text-muted-foreground">Discord Webhook URL</Label>
            <Input
              id="discord-webhook"
              type="password"
              placeholder="https://discord.com/api/webhooks/..."
              value={config.discord_webhook}
              onChange={(e) => setConfig({ ...config, discord_webhook: e.target.value })}
              className="bg-input"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleTestDiscord}>
            <Send className="mr-2 h-3.5 w-3.5" />
            Test Discord
          </Button>
        </CardContent>
      </Card>

      {/* Advanced Options */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Image className="h-4 w-4 text-accent" />
            Advanced Options
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="enable-posters" className="text-sm">Enable Poster Images (TVDB)</Label>
            <Switch
              id="enable-posters"
              checked={config.enable_posters}
              onCheckedChange={(checked) => setConfig({ ...config, enable_posters: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tvdb-key" className="text-sm text-muted-foreground">TVDB API Key (Optional)</Label>
            <Input
              id="tvdb-key"
              type="password"
              placeholder="Your TVDB API key"
              value={config.tvdb_api_key}
              onChange={(e) => setConfig({ ...config, tvdb_api_key: e.target.value })}
              className="bg-input"
            />
            <p className="text-xs text-muted-foreground">
              Get your API key from{" "}
              <a href="https://thetvdb.com/api-information" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                TVDB
              </a>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Subtitle Translation */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Languages className="h-4 w-4 text-accent" />
            Subtitle Translation (OpenAI)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="openai-key" className="text-sm text-muted-foreground">OpenAI API Key</Label>
            <Input
              id="openai-key"
              type="password"
              placeholder="sk-..."
              value={config.openai_api_key}
              onChange={(e) => setConfig({ ...config, openai_api_key: e.target.value })}
              className="bg-input"
            />
            <p className="text-xs text-muted-foreground">
              Get your key from{" "}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                platform.openai.com
              </a>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="openai-model" className="text-sm text-muted-foreground">Translation Model</Label>
            <Select value={config.openai_model} onValueChange={(value) => setConfig({ ...config, openai_model: value })}>
              <SelectTrigger className="bg-input">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gpt-4o-mini">gpt-4o-mini — Fast & cheap (~$0.002/movie)</SelectItem>
                <SelectItem value="gpt-4o">gpt-4o — Best quality (~$0.04/movie)</SelectItem>
                <SelectItem value="gpt-4-turbo">gpt-4-turbo — High quality (~$0.15/movie)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              gpt-4o-mini is recommended — excellent quality at a fraction of the cost.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* File Status Rules */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <SlidersHorizontal className="h-4 w-4 text-accent" />
            File Status Rules
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reencode-size" className="text-sm text-muted-foreground">
              Re-encode size threshold (GiB)
            </Label>
            <Input
              id="reencode-size"
              type="number"
              min={1}
              max={1024}
              step={0.5}
              value={config.reencode_size_gb}
              onChange={(e) => setConfig({ ...config, reencode_size_gb: Number(e.target.value) })}
              className="bg-input"
            />
            <p className="text-xs text-muted-foreground">
              Files larger than this are flagged <span className="font-mono">RE-ENCODE</span>. Default: 20.
            </p>
          </div>
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Required subtitle languages</Label>
            <div className="flex flex-wrap gap-2">
              {COMMON_SUB_LANGS.map(lang => {
                const checked = config.required_sub_langs.includes(lang.code)
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => {
                      const next = checked
                        ? config.required_sub_langs.filter(c => c !== lang.code)
                        : [...config.required_sub_langs, lang.code]
                      setConfig({ ...config, required_sub_langs: next })
                    }}
                    className={
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors " +
                      (checked
                        ? "border-accent/40 bg-accent/15 text-accent"
                        : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground")
                    }
                  >
                    {lang.label}
                    <span className="ml-1.5 font-mono text-[10px] opacity-60">{lang.code}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Files missing any selected language are flagged <span className="font-mono">MISSING LANG</span>.
              Saving with a change re-evaluates every file automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Save/Reload Buttons */}
      <div className="flex gap-3">
        <Button onClick={handleSave}>
          <Save className="mr-2 h-4 w-4" />
          Save Configuration
        </Button>
        <Button variant="outline" onClick={handleReload}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Reload
        </Button>
      </div>
    </div>
  )
}

interface StatCardProps {
  icon: React.ElementType
  value: string
  label: string
  variant?: "default" | "success"
}

function StatCard({ icon: Icon, value, label, variant = "default" }: StatCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-xl bg-card p-6 transition-all hover:bg-card/80">
      <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
          <Icon className={variant === "success" ? "h-5 w-5 text-success" : "h-5 w-5 text-muted-foreground"} />
        </div>
        <div className="text-3xl font-semibold tracking-tight text-foreground">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
