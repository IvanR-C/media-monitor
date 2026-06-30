"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChevronDown, Maximize2, Trash2 } from "lucide-react"

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
  const [isModalOpen, setIsModalOpen] = useState(false)
  // Ref (not state) for the poll position — changing it never triggers a re-render
  // or re-mounts the interval, so clearing the display won't re-fetch old entries.
  const pollSinceRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const modalBottomRef = useRef<HTMLDivElement>(null)

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
    if (isModalOpen) {
      setTimeout(() => modalBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }, [show, isModalOpen, logs])

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
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
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
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); setIsModalOpen(true) }}
              title="Open logs in a larger view"
            >
              <Maximize2 className="h-2.5 w-2.5" />
            </Button>
          </div>
        )}
      </button>

      {show && (
        <div className="max-h-48 overflow-y-auto border-t border-border/30 bg-[#0a0a0c] font-mono text-[11px]">
          <LogsList logs={logs} bottomRef={bottomRef} />
        </div>
      )}

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-4xl">
          <DialogHeader className="flex flex-row items-center gap-2 border-b border-border/50 px-4 py-3 space-y-0">
            <DialogTitle className="text-sm font-medium">Logs</DialogTitle>
            {errorCount > 0 && <span className="text-xs text-destructive">{errorCount} error{errorCount === 1 ? "" : "s"}</span>}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto mr-6 h-7 px-2 text-xs"
              onClick={() => setLogs([])}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Clear
            </Button>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto bg-[#0a0a0c] font-mono text-xs">
            <LogsList logs={logs} bottomRef={modalBottomRef} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function LogsList({ logs, bottomRef }: { logs: LogEntry[]; bottomRef: React.RefObject<HTMLDivElement | null> }) {
  if (logs.length === 0) {
    return <p className="px-3 py-2 italic text-muted-foreground">No log entries</p>
  }
  return (
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
  )
}
