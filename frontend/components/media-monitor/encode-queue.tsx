"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { ChevronDown, X, Film, Languages } from "lucide-react"
import { toast } from "sonner"

interface EncodeJob {
  id: number
  folder_name: string
  filename: string
  status: "queued" | "encoding" | "done" | "failed" | "cancelled"
  progress?: number
  speed?: string
  eta_seconds?: number
  original_size_gb: number
  encoded_size_gb?: number
  savings_pct?: number
  error_text?: string
}

interface TranslationJob {
  id: number
  folder_name: string
  filename: string
  status: "pending" | "extracting" | "translating" | "muxing" | "done" | "failed" | "cancelled"
  progress?: number
  progress_detail?: string
  source_lang?: string
  error_text?: string
}

type UnifiedJob =
  | (EncodeJob & { _type: 'encode' })
  | (TranslationJob & { _type: 'translate' })

const ACTIVE_ENCODE_STATUSES    = new Set(['queued', 'encoding'])
const ACTIVE_TRANSLATE_STATUSES = new Set(['pending', 'extracting', 'translating', 'muxing'])

export function CombinedQueue() {
  const [isExpanded, setIsExpanded] = useState(true)
  const [encodeJobs, setEncodeJobs]       = useState<EncodeJob[]>([])
  const [translateJobs, setTranslateJobs] = useState<TranslationJob[]>([])

  const fetchJobs = useCallback(async () => {
    try {
      const [enc, tr] = await Promise.all([
        fetch('/api/encode/jobs').then(r => r.json()),
        fetch('/api/translate/jobs').then(r => r.json()),
      ])
      setEncodeJobs(enc.jobs ?? [])
      setTranslateJobs(tr.jobs ?? [])
    } catch {
      // silently ignore poll errors
    }
  }, [])

  useEffect(() => {
    fetchJobs()
    const interval = setInterval(fetchJobs, 3000)
    return () => clearInterval(interval)
  }, [fetchJobs])

  const handleCancelEncode = async (e: React.MouseEvent, jobId: number) => {
    e.stopPropagation()
    try {
      await fetch(`/api/encode/cancel/${jobId}`, { method: 'POST' })
      toast.info('Encode job cancelled')
      fetchJobs()
    } catch {
      toast.error('Failed to cancel job')
    }
  }

  const handleCancelTranslate = async (e: React.MouseEvent, jobId: number) => {
    e.stopPropagation()
    try {
      await fetch(`/api/translate/cancel/${jobId}`, { method: 'POST' })
      toast.info('Translation job cancelled')
      fetchJobs()
    } catch {
      toast.error('Failed to cancel job')
    }
  }

  // Combine and sort: active first, then by recency (most recent first)
  const allJobs: UnifiedJob[] = [
    ...encodeJobs.map(j => ({ ...j, _type: 'encode' as const })),
    ...translateJobs.map(j => ({ ...j, _type: 'translate' as const })),
  ]

  const activeJobs = allJobs.filter(j =>
    j._type === 'encode'
      ? ACTIVE_ENCODE_STATUSES.has(j.status as any)
      : ACTIVE_TRANSLATE_STATUSES.has(j.status as any)
  )

  const activeEncode = encodeJobs.find(j => j.status === 'encoding')

  return (
    <div className="rounded-t-lg border border-b-0 border-border/50 bg-card/50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs"
      >
        <div className="flex items-center gap-2">
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", !isExpanded && "-rotate-90")} />
          <span className="font-medium text-foreground">Queue</span>
          {activeJobs.length > 0 && <span className="text-accent">{activeJobs.length}</span>}
        </div>

        {activeEncode && !isExpanded && (
          <div className="flex flex-1 items-center gap-2 text-muted-foreground">
            <span className="truncate">{activeEncode.folder_name}</span>
            <Progress value={activeEncode.progress} className="h-1 w-24" />
            <span className="tabular-nums">{activeEncode.progress?.toFixed(0)}%</span>
          </div>
        )}
      </button>

      {isExpanded && (
        <div className="max-h-40 overflow-y-auto border-t border-border/30 bg-[#0a0a0c]">
          {allJobs.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No jobs in queue</p>
          ) : (
            <div className="divide-y divide-border/20">
              {allJobs.map(job =>
                job._type === 'encode' ? (
                  <EncodeJobRow key={`e-${job.id}`} job={job} onCancel={handleCancelEncode} />
                ) : (
                  <TranslateJobRow key={`t-${job.id}`} job={job} onCancel={handleCancelTranslate} />
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EncodeJobRow({ job, onCancel }: { job: EncodeJob & { _type: 'encode' }; onCancel: (e: React.MouseEvent, id: number) => void }) {
  const isActive = ACTIVE_ENCODE_STATUSES.has(job.status)
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-secondary/20">
      <Film className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      <JobStatusDot status={job.status} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{job.folder_name}</span>
      <span className="hidden shrink-0 text-muted-foreground sm:block">{job.original_size_gb} GB</span>
      {job.status === "encoding" && job.progress !== undefined && (
        <>
          <Progress value={job.progress} className="h-1 w-20 shrink-0" />
          <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{job.progress.toFixed(0)}%</span>
          {job.speed && <span className="hidden w-16 shrink-0 text-muted-foreground lg:block">{job.speed} · {formatEta(job.eta_seconds)}</span>}
        </>
      )}
      {job.status === "done" && job.savings_pct != null && (
        <span className="shrink-0 text-success">-{job.savings_pct}%</span>
      )}
      {job.status === "failed" && <span className="shrink-0 text-destructive">Failed</span>}
      {isActive && (
        <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive" onClick={(e) => onCancel(e, job.id)}>
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

function TranslateJobRow({ job, onCancel }: { job: TranslationJob & { _type: 'translate' }; onCancel: (e: React.MouseEvent, id: number) => void }) {
  const isActive = ACTIVE_TRANSLATE_STATUSES.has(job.status)
  const detail = job.progress_detail || job.status
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-secondary/20">
      <Languages className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      <JobStatusDot status={job.status === 'pending' ? 'queued' : job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'encoding'} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{job.folder_name}</span>
      {isActive && job.progress != null && (
        <>
          <Progress value={job.progress} className="h-1 w-20 shrink-0" />
          <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{job.progress.toFixed(0)}%</span>
          <span className="hidden max-w-[120px] truncate text-muted-foreground lg:block">{detail}</span>
        </>
      )}
      {job.status === "done"   && <span className="shrink-0 text-success">Done</span>}
      {job.status === "failed" && <span className="shrink-0 text-destructive">Failed</span>}
      {isActive && (
        <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive" onClick={(e) => onCancel(e, job.id)}>
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

type DotStatus = "queued" | "encoding" | "done" | "failed" | "cancelled"
function JobStatusDot({ status }: { status: DotStatus }) {
  const styles: Record<DotStatus, string> = {
    queued:    "bg-muted-foreground",
    encoding:  "bg-accent animate-pulse",
    done:      "bg-success",
    failed:    "bg-destructive",
    cancelled: "bg-muted-foreground",
  }
  return <div className={cn("h-2 w-2 shrink-0 rounded-full", styles[status] ?? "bg-muted-foreground")} />
}

function formatEta(secs?: number): string {
  if (secs === undefined || secs < 0) return "-"
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}
