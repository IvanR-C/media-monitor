"use client"

import { useEffect, useState, useCallback, type FormEvent, type ReactNode } from "react"
import { Loader2, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { loginWithPasskey, passkeysSupported } from "@/lib/webauthn"

type AuthStage = "loading" | "setup" | "login" | "mfa" | "authenticated"

// Patches window.fetch exactly once so a session that expires mid-use
// (cookie cleared, server restarted) drops back to the login screen on the
// next API call instead of the dashboard silently failing underneath it.
let fetchPatched = false
function patchFetchFor401(onUnauthenticated: () => void) {
  if (fetchPatched) return
  fetchPatched = true
  const original = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args)
    const input = args[0]
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (res.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
      onUnauthenticated()
    }
    return res
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<AuthStage>("loading")
  const [username, setUsername] = useState("")

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/status")
      const data = await r.json()
      setUsername(data.username ?? "")
      if (data.setup_required) setStage("setup")
      else if (data.authenticated) setStage("authenticated")
      else if (data.mfa_required) setStage("mfa")
      else setStage("login")
    } catch {
      setStage("login")
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    patchFetchFor401(() => setStage("login"))
  }, [refreshStatus])

  if (stage === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (stage === "authenticated") return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-border/50 bg-card/50">
        <CardHeader className="items-center text-center">
          <img src="/icon.svg" alt="Media Monitor" className="mb-2 h-10 w-10 rounded-md" />
          <CardTitle className="text-lg font-semibold">
            {stage === "setup" ? "Set up Media Monitor" : "Media Monitor"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stage === "setup" && <SetupForm onDone={() => setStage("authenticated")} />}
          {stage === "login" && (
            <LoginForm
              onLoggedIn={() => setStage("authenticated")}
              onMfaRequired={(u) => {
                setUsername(u)
                setStage("mfa")
              }}
            />
          )}
          {stage === "mfa" && (
            <MfaStep
              username={username}
              onVerified={() => setStage("authenticated")}
              onBack={() => setStage("login")}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      toast.error("Passwords don't match")
      return
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const data = await r.json()
      if (!r.ok) {
        toast.error(data.error || "Setup failed")
        return
      }
      onDone()
    } catch {
      toast.error("Setup failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-center text-sm text-muted-foreground">
        Create the admin account used to sign in to this dashboard. You can add a passkey as a
        second factor later, from Settings.
      </p>
      <div className="space-y-2">
        <Label htmlFor="setup-username">Username</Label>
        <Input
          id="setup-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-password">Password</Label>
        <Input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-confirm">Confirm password</Label>
        <Input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create admin account"}
      </Button>
    </form>
  )
}

function LoginForm({
  onLoggedIn,
  onMfaRequired,
}: {
  onLoggedIn: () => void
  onMfaRequired: (username: string) => void
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const data = await r.json()
      if (!r.ok) {
        toast.error(data.error || "Sign in failed")
        return
      }
      if (data.status === "mfa_required") onMfaRequired(username)
      else onLoggedIn()
    } catch {
      toast.error("Sign in failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="login-username">Username</Label>
        <Input
          id="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
      </Button>
    </form>
  )
}

function MfaStep({
  username,
  onVerified,
  onBack,
}: {
  username: string
  onVerified: () => void
  onBack: () => void
}) {
  const [verifying, setVerifying] = useState(false)
  const supported = passkeysSupported()

  const handlePasskey = async () => {
    setVerifying(true)
    try {
      await loginWithPasskey()
      onVerified()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Passkey sign-in failed")
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-4 text-center">
      <KeyRound className="mx-auto h-8 w-8 text-accent" />
      <p className="text-sm text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{username}</span>. Use your
        passkey to finish signing in.
      </p>
      {!supported && (
        <p className="text-sm text-destructive">
          This browser doesn't support passkeys (WebAuthn needs HTTPS or localhost). Open the
          dashboard from a supported browser/connection to finish signing in.
        </p>
      )}
      <Button className="w-full" onClick={handlePasskey} disabled={verifying || !supported}>
        {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue with passkey"}
      </Button>
      <Button variant="ghost" className="w-full" onClick={onBack} disabled={verifying}>
        Back
      </Button>
    </div>
  )
}
