"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChevronDown, Trash2 } from "lucide-react"

interface AppLogsProps {
  show: boolean
  onToggle: () => void
}

interface LogEntry {
  seq: number
  ts: string
  level: "info" | "warn" | "error"
  msg: string
}

export function AppLogs({ show, onToggle }: AppLogsProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  // Ref (not state) for the poll position — changing it never triggers a re-render
  // or re-mounts the interval, so clearing the display won't re-fetch old entries.
  const pollSinceRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const data = await fetch(`/api/logs?since=${pollSinceRef.current}`).then(r => r.json())
        if (data.logs?.length > 0) {
          setLogs(prev => [...prev, ...data.logs].slice(-500))
          pollSinceRef.current = data.total
        }
      } catch {
        // silently ignore transient poll errors
      }
    }

    fetchLogs()
    const id = setInterval(fetchLogs, 2000)
    return () => clearInterval(id)
  }, []) // mount once — stable interval, no re-creation on every log batch

  useEffect(() => {
    if (show) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }, [show, logs])

  const errorCount = logs.filter(l => l.level === "error").length

  return (
    <div className="rounded-b-lg border border-t-0 border-border/50 bg-card/50">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs"
      >
        <div className="flex items-center gap-2">
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", !show && "-rotate-90")} />
          <span className="font-medium text-foreground">Logs</span>
          {errorCount > 0 && <span className="text-destructive">{errorCount}</span>}
        </div>
        {show && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-5 px-1.5 text-[10px]"
            onClick={(e) => {
              e.stopPropagation()
              // Only wipe the display — pollSinceRef keeps its position so the
              // next poll only fetches *new* entries, never re-loading old ones.
              setLogs([])
            }}
          >
            <Trash2 className="mr-1 h-2.5 w-2.5" />
            Clear
          </Button>
        )}
      </button>

      {show && (
        <div className="max-h-48 overflow-y-auto border-t border-border/30 bg-[#0a0a0c] font-mono text-[11px]">
          {logs.length === 0 ? (
            <p className="px-3 py-2 italic text-muted-foreground">No log entries</p>
          ) : (
            <div>
              {logs.map((log) => (
                <div key={log.seq} className="flex gap-2 px-3 py-0.5 hover:bg-secondary/10">
                  <span className="shrink-0 text-muted-foreground/60">{log.ts}</span>
                  <span className={cn(
                    "shrink-0 font-semibold",
                    log.level === "info"  && "text-muted-foreground/60",
                    log.level === "warn"  && "text-warning",
                    log.level === "error" && "text-destructive"
                  )}>
                    {log.level === "info" ? "INF" : log.level === "warn" ? "WRN" : "ERR"}
                  </span>
                  <span className={cn(
                    "min-w-0 break-all",
                    log.level === "info"  && "text-foreground/70",
                    log.level === "warn"  && "text-warning",
                    log.level === "error" && "text-destructive"
                  )}>
                    {log.msg}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
