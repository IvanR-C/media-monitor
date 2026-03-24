"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"

export function Header() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'error'>('checking')

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch('/api/health')
        setHealth(r.ok ? 'ok' : 'error')
      } catch {
        setHealth('error')
      }
    }
    check()
    const id = setInterval(check, 30000)
    return () => clearInterval(id)
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
