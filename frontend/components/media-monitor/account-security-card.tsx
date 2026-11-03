"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { KeyRound, ShieldCheck, Trash2, Loader2 } from "lucide-react"
import { registerPasskey, passkeysSupported } from "@/lib/webauthn"

interface Passkey {
  id: number
  name: string
  created_at: string
  last_used_at: string | null
}

export function AccountSecurityCard({ compact = false }: { compact?: boolean }) {
  const [username, setUsername] = useState("")
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [requireMfa, setRequireMfa] = useState(false)
  const [loading, setLoading] = useState(true)

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [savingPassword, setSavingPassword] = useState(false)

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newPasskeyName, setNewPasskeyName] = useState("")
  const [registering, setRegistering] = useState(false)

  const refresh = async () => {
    try {
      const [statusRes, passkeysRes] = await Promise.all([
        fetch("/api/auth/status"),
        fetch("/api/auth/passkeys"),
      ])
      const status = await statusRes.json()
      const { passkeys: pk } = await passkeysRes.json()
      setUsername(status.username ?? "")
      setRequireMfa(!!status.require_passkey_mfa)
      setPasskeys(pk ?? [])
    } catch {
      toast.error("Failed to load account settings")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters")
      return
    }
    setSavingPassword(true)
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      const data = await r.json()
      if (!r.ok) {
        toast.error(data.error || "Failed to change password")
        return
      }
      toast.success("Password changed")
      setCurrentPassword("")
      setNewPassword("")
    } catch {
      toast.error("Failed to change password")
    } finally {
      setSavingPassword(false)
    }
  }

  const handleAddPasskey = async () => {
    setRegistering(true)
    try {
      await registerPasskey(newPasskeyName.trim() || "Passkey")
      toast.success("Passkey added")
      setAddDialogOpen(false)
      setNewPasskeyName("")
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add passkey")
    } finally {
      setRegistering(false)
    }
  }

  const handleDeletePasskey = async (id: number) => {
    try {
      const r = await fetch(`/api/auth/passkeys/${id}`, { method: "DELETE" })
      if (!r.ok) throw new Error()
      toast.success("Passkey removed")
      refresh()
    } catch {
      toast.error("Failed to remove passkey")
    }
  }

  const handleToggleMfa = async (checked: boolean) => {
    try {
      const r = await fetch("/api/auth/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ require_passkey_mfa: checked }),
      })
      const data = await r.json()
      if (!r.ok) {
        toast.error(data.error || "Failed to update MFA setting")
        return
      }
      setRequireMfa(checked)
      toast.success(checked ? "Passkey MFA enabled" : "Passkey MFA disabled")
    } catch {
      toast.error("Failed to update MFA setting")
    }
  }

  if (loading) return null

  return (
    <Card className={compact ? "gap-0 rounded-none border-0 bg-transparent py-0 shadow-none" : "border-border/50 bg-card/50"}>
      <CardHeader className={compact ? "sr-only" : "pb-4"}>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <ShieldCheck className="h-4 w-4 text-accent" />
          Account & Security
        </CardTitle>
      </CardHeader>
      <CardContent className={compact ? "space-y-6 px-0 pt-3" : "space-y-6"}>
        <div className="space-y-3">
          <Label className="text-sm text-muted-foreground">Change password</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label="Current password"
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="bg-input"
            />
            <Input
              aria-label="New password"
              type="password"
              placeholder="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="bg-input"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleChangePassword}
            disabled={savingPassword || !currentPassword || !newPassword}
          >
            {savingPassword ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Update password
          </Button>
          <p className="text-xs text-muted-foreground">Signed in as {username || "—"}.</p>
        </div>

        <div className="space-y-3 border-t border-border/40 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="require-passkey-mfa" className="text-sm">Require passkey for login</Label>
              <p className="text-xs text-muted-foreground">
                Adds a passkey check after your password. Needs at least one passkey below.
              </p>
            </div>
            <Switch
              id="require-passkey-mfa"
              checked={requireMfa}
              disabled={passkeys.length === 0}
              onCheckedChange={handleToggleMfa}
            />
          </div>

          {!passkeysSupported() && (
            <p className="text-xs text-destructive">
              This browser doesn't support passkeys (WebAuthn needs HTTPS or localhost).
            </p>
          )}

          <div className="space-y-2">
            {passkeys.map((pk) => (
              <div
                key={pk.id}
                className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 text-foreground/90">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{pk.name}</span>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => handleDeletePasskey(pk.id)}
                  title="Remove passkey"
                  aria-label={`Remove passkey ${pk.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            ))}
            {passkeys.length === 0 && (
              <p className="text-xs text-muted-foreground">No passkeys registered yet.</p>
            )}
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddDialogOpen(true)}
            disabled={!passkeysSupported()}
          >
            <KeyRound className="mr-2 h-3.5 w-3.5" />
            Add a passkey
          </Button>
        </div>
      </CardContent>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a passkey</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="passkey-name">Name</Label>
            <Input
              id="passkey-name"
              placeholder="e.g. YubiKey, iPhone"
              value={newPasskeyName}
              onChange={(e) => setNewPasskeyName(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Your browser will prompt you to use a security key, your device's biometrics, or a
              screen lock PIN.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleAddPasskey} disabled={registering}>
              {registering ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
