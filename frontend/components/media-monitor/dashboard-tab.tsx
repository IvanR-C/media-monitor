"use client"

import { useState, useEffect } from "react"
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
  Send
} from "lucide-react"

export function DashboardTab() {
  const [config, setConfig] = useState({
    enable_ntfy: true,
    ntfy_server: "https://ntfy.sh",
    ntfy_topic: "",
    enable_discord: false,
    discord_webhook: "",
    enable_posters: true,
    tvdb_api_key: "",
    openai_api_key: "",
    openai_model: "gpt-4o-mini"
  })
  const [stats, setStats] = useState({ total: 0, by_status: {} as Record<string, number>, max_workers: 4 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]).then(([cfg, st]) => {
      setConfig(prev => ({ ...prev, ...cfg }))
      setStats(st)
    }).catch(e => toast.error('Failed to load config')).finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      toast.success("Configuration saved")
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
