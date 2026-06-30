"use client"

import { useState, useEffect } from "react"
import { Library, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

interface HeaderProps {
  activeView: "library" | "settings"
  onViewChange: (view: "library" | "settings") => void
  isScanning?: boolean
}

export function Header({ activeView, onViewChange, isScanning }: HeaderProps) {
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
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/icon.svg" alt="Media Monitor" className="h-8 w-8 shrink-0 rounded-md" />
          <span className="hidden truncate text-base font-semibold tracking-tight text-foreground sm:inline">
            Media Monitor
          </span>
          <div
            title={
              health === 'ok'       ? 'Backend connected' :
              health === 'error'    ? 'Backend unreachable' :
              'Checking backend…'
            }
            className={cn(
              "h-2 w-2 shrink-0 rounded-full transition-colors",
              health === 'ok'       && "bg-success",
              health === 'error'    && "bg-destructive animate-pulse",
              health === 'checking' && "bg-muted-foreground animate-pulse",
            )}
          />
        </div>

        <nav className="flex shrink-0 items-center gap-1 rounded-lg border border-border/50 bg-secondary/40 p-1">
          <button
            type="button"
            onClick={() => onViewChange("library")}
            className={cn(
              "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-all",
              activeView === "library"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Library className="h-4 w-4" />
            <span>Library</span>
            {isScanning && (
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse" title="Scan in progress" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onViewChange("settings")}
            className={cn(
              "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-all",
              activeView === "settings"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </button>
        </nav>
      </div>
    </header>
  )
}
