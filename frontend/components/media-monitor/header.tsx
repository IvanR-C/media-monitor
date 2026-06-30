"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"

export function Header() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'error'>('checking')

  useEffect(() => {
    let inflight: AbortController | null = null
    const check = async () => {
      inflight?.abort()
      const ac = new AbortController()
      inflight = ac
      try {
        const r = await fetch('/api/health', { signal: ac.signal })
        if (ac.signal.aborted) return
        setHealth(r.ok ? 'ok' : 'error')
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return
        setHealth('error')
      }
    }
    check()
    const id = setInterval(check, 30000)
    return () => {
      clearInterval(id)
      inflight?.abort()
    }
  }, [])

  return (
    <header className="mb-8 text-center">
      <div className="mb-3 flex items-center justify-center gap-3">
        <img src="/icon.svg" alt="Media Monitor" className="h-10 w-10 rounded-lg" />
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Media Monitor
        </h1>
        <div
          title={
            health === 'ok'       ? 'Backend connected' :
            health === 'error'    ? 'Backend unreachable' :
            'Checking backend…'
          }
          className={cn(
            "h-2 w-2 rounded-full transition-colors",
            health === 'ok'       && "bg-success",
            health === 'error'    && "bg-destructive animate-pulse",
            health === 'checking' && "bg-muted-foreground animate-pulse",
          )}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Automated media library management and transcoding
      </p>
    </header>
  )
}
