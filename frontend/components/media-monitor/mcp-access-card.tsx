"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { Check, Copy, KeyRound, Loader2, Trash2 } from "lucide-react"

type Scope = "read" | "full"

interface TokenInfo {
  enabled: boolean
  scope: Scope | null
  created_at: string | null
  hint: string | null
  path: string
  tools: Record<Scope, number>
}

const SCOPES: { value: Scope; title: string; description: string }[] = [
  { value: "read", title: "Read-only", description: "Search the library, read tracks, settings, jobs and logs. Can't change anything." },
  { value: "full", title: "Full control", description: "Also queue encodes, remuxes, rips, translations and Fix Anime, edit tracks, cancel jobs and purge backups." },
]

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn’t copy. Select the text and copy it manually.")
    }
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2 rounded-md border border-border/50 bg-input px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{value}</code>
        <Button size="icon-sm" variant="ghost" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export function McpAccessCard() {
  const [info, setInfo] = useState<TokenInfo | null>(null)
  const [scope, setScope] = useState<Scope>("read")
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null)

  const load = async () => {
    try {
      const r = await fetch("/api/mcp/token")
      if (!r.ok) throw new Error()
      const data: TokenInfo = await r.json()
      setInfo(data)
      if (data.scope) setScope(data.scope)
    } catch {
      toast.error("Couldn’t load MCP access settings")
    }
  }

  useEffect(() => {
    load()
  }, [])

  const endpoint = typeof window === "undefined" ? "/mcp" : `${window.location.origin}${info?.path ?? "/mcp"}`

  const generate = async () => {
    setBusy(true)
    try {
      const r = await fetch("/api/mcp/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setToken(data.token)
      setInfo(data)
      toast.success("Access token created. Copy it now: it won’t be shown again.")
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn’t create a token")
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      const r = await fetch("/api/mcp/token", { method: "DELETE" })
      if (!r.ok) throw new Error()
      setInfo(await r.json())
      setToken(null)
      toast.success("Access token revoked. Connected assistants are disconnected.")
    } catch {
      toast.error("Couldn’t revoke the token")
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  if (!info) return null

  const shownToken = token ?? "<your token>"
  const claudeCommand = `claude mcp add --transport http media-monitor ${endpoint} --header "Authorization: Bearer ${shownToken}"`
  const jsonConfig = JSON.stringify(
    { mcpServers: { "media-monitor": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${shownToken}` } } } },
    null,
    2,
  )

  return (
    <div className="space-y-6 pt-3">
      <div className="space-y-3">
        <Label className="text-sm">Access level</Label>
        <RadioGroup value={scope} onValueChange={v => setScope(v as Scope)} className="gap-2" aria-label="MCP access level">
          {SCOPES.map(s => (
            <label key={s.value} htmlFor={`mcp-scope-${s.value}`}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border/40 px-3 py-2.5 has-[[data-state=checked]]:border-accent/50 has-[[data-state=checked]]:bg-accent/5">
              <RadioGroupItem id={`mcp-scope-${s.value}`} value={s.value} className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="block text-sm">{s.title} <span className="text-xs text-muted-foreground">· {info.tools[s.value]} tools</span></span>
                <span className="block text-xs text-muted-foreground">{s.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {info.enabled && info.scope !== scope && (
          <p className="text-xs text-warning">Changing the access level creates a new token and disconnects the current one.</p>
        )}
      </div>

      <div className="space-y-3 border-t border-border/40 pt-4">
        {info.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Token ending in <code className="font-mono">…{info.hint}</code></span>
              <span className="text-xs text-muted-foreground">
                {info.scope === "full" ? "Full control" : "Read-only"}
                {info.created_at ? ` · created ${new Date(info.created_at).toLocaleString()}` : ""}
              </span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("regenerate")}>Create new token</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("revoke")} aria-label="Revoke MCP token">
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">MCP access is off. Create a token to connect an assistant.</p>
            <Button size="sm" onClick={generate} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              Create access token
            </Button>
          </div>
        )}

        {token && (
          <div role="status" className="space-y-1 rounded-md border border-accent/30 bg-accent/5 p-3">
            <CopyBlock label="Access token — shown once" value={token} />
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-border/40 pt-4">
        <Label className="text-sm">Connect an assistant</Label>
        <CopyBlock label="Endpoint (Streamable HTTP)" value={endpoint} />
        <CopyBlock label="Claude Code" value={claudeCommand} />
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Other clients (Cursor, VS Code, Claude Desktop via a remote-MCP bridge)</p>
          <pre className="overflow-x-auto rounded-md border border-border/50 bg-input px-3 py-2 font-mono text-xs leading-relaxed">{jsonConfig}</pre>
        </div>
        <p className="text-xs text-muted-foreground">
          The token works like your password for these actions. Keep it out of shared files, and serve Media Monitor over HTTPS
          if the assistant connects from outside your network.
        </p>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={open => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "revoke" ? "Revoke MCP access?" : "Create a new token?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "revoke"
                ? "Assistants using the current token lose access immediately. You can create a new token later."
                : "The current token stops working immediately. Update each connected assistant with the new one."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={confirm === "revoke" ? revoke : generate}>
              {confirm === "revoke" ? "Revoke" : "Create new token"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
