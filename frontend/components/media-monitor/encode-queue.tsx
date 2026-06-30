"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChevronDown, Maximize2, Pause, Play, Square, X, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  ACTIVE_TRANSLATE_STATUSES,
  TRANSLATE_STATUS_LABEL,
} from "./translate-status"

interface EncodeJob {
  id: number
  folder_name: string
  filename: string
  status: "queued" | "encoding" | "done" | "failed" | "cancelled"
  job_type?: "encode" | "remux" | "rip"
  progress?: number
  speed?: string
  eta_seconds?: number
  original_size_gb: number
  encoded_size_gb?: number
  savings_pct?: number
  error_text?: string
  media_type?: "movie" | "show"
  show_name?: string
  season_episode?: string
}

interface TranslationJob {
  id: number
  folder_name: string
  filename: string
  media_type?: "movie" | "show"
  show_name?: string
  season_episode?: string
  status: "pending" | "extracting" | "ocr" | "translating" | "muxing" | "done" | "failed" | "cancelled"
  progress?: number
  progress_detail?: string
  source_lang?: string
  error_text?: string
}

const ACTIVE_ENCODE_STATUSES = new Set(["queued", "encoding"])

export function CombinedQueue() {
  const [isExpanded, setIsExpanded]         = useState(true)
  const [activeTab, setActiveTab]           = useState<"encode" | "translate">("encode")
  const [encodeJobs, setEncodeJobs]         = useState<EncodeJob[]>([])
  const [translateJobs, setTranslateJobs]   = useState<TranslationJob[]>([])
  const [encodePaused, setEncodePaused]     = useState(false)
  const [translatePaused, setTranslatePaused] = useState(false)
  const [confirmCancelAll, setConfirmCancelAll] = useState<null | "encode" | "translate">(null)
  const [isModalOpen, setIsModalOpen]       = useState(false)

  const fetchJobs = useCallback(async () => {
    try {
      const [enc, tr] = await Promise.all([
        fetch("/api/encode/jobs").then(r => r.json()),
        fetch("/api/translate/jobs").then(r => r.json()),
      ])
      setEncodeJobs(enc.jobs ?? [])
      setTranslateJobs(tr.jobs ?? [])
      setEncodePaused(Boolean(enc.paused))
      setTranslatePaused(Boolean(tr.paused))
    } catch {
      // silently ignore poll errors
    }
  }, [])

  useEffect(() => {
    fetchJobs()
    const interval = setInterval(fetchJobs, 3000)
    return () => clearInterval(interval)
  }, [fetchJobs])

  // ── Actions ──────────────────────────────────────────────────────────────────
  const handleCancelEncode = async (e: React.MouseEvent, jobId: number) => {
    e.stopPropagation()
    try {
      await fetch(`/api/encode/cancel/${jobId}`, { method: "POST" })
      toast.info("Encode job cancelled")
      fetchJobs()
    } catch {
      toast.error("Failed to cancel job")
    }
  }

  const handleCancelTranslate = async (e: React.MouseEvent, jobId: number) => {
    e.stopPropagation()
    try {
      await fetch(`/api/translate/cancel/${jobId}`, { method: "POST" })
      toast.info("Translation job cancelled")
      fetchJobs()
    } catch {
      toast.error("Failed to cancel job")
    }
  }

  const handleClearEncode = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const r = await fetch("/api/encode/jobs/clear", { method: "POST" })
      const data = await r.json()
      toast.success(`Cleared ${data.deleted} encode job(s)`)
      fetchJobs()
    } catch {
      toast.error("Failed to clear jobs")
    }
  }

  const handleClearTranslate = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const r = await fetch("/api/translate/jobs/clear", { method: "POST" })
      const data = await r.json()
      toast.success(`Cleared ${data.deleted} translation job(s)`)
      fetchJobs()
    } catch {
      toast.error("Failed to clear jobs")
    }
  }

  // ── Group controls (pause / resume / cancel-all) ────────────────────────────
  const handleTogglePause = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const isEncode = activeTab === "encode"
    const paused   = isEncode ? encodePaused : translatePaused
    const base     = isEncode ? "/api/encode" : "/api/translate"
    const action   = paused ? "resume" : "pause"
    // Optimistic flip; reverted by next poll if backend disagrees
    if (isEncode) setEncodePaused(!paused)
    else          setTranslatePaused(!paused)
    try {
      const r = await fetch(`${base}/${action}`, { method: "POST" })
      if (!r.ok) throw new Error()
      toast.info(`${isEncode ? "Encode" : "Translation"} queue ${paused ? "resumed" : "paused"}`)
      fetchJobs()
    } catch {
      toast.error(`Failed to ${action} queue`)
      fetchJobs()
    }
  }

  const handleCancelAll = async () => {
    if (!confirmCancelAll) return
    const isEncode = confirmCancelAll === "encode"
    const base     = isEncode ? "/api/encode" : "/api/translate"
    try {
      const r    = await fetch(`${base}/cancel-all`, { method: "POST" })
      const data = await r.json().catch(() => ({}))
      const n    = typeof data?.cancelled === "number" ? data.cancelled : null
      toast.success(
        n != null
          ? `Cancelled ${n} ${isEncode ? "encode" : "translation"} job(s)`
          : `Cancelled all ${isEncode ? "encode" : "translation"} jobs`
      )
      fetchJobs()
    } catch {
      toast.error("Failed to cancel jobs")
    } finally {
      setConfirmCancelAll(null)
    }
  }

  // ── Derived counts ────────────────────────────────────────────────────────────
  const activeEncodeCount    = encodeJobs.filter(j => ACTIVE_ENCODE_STATUSES.has(j.status)).length
  const activeTranslateCount = translateJobs.filter(j => ACTIVE_TRANSLATE_STATUSES.has(j.status)).length
  const totalActive          = activeEncodeCount + activeTranslateCount

  const doneEncodeCount    = encodeJobs.filter(j => !ACTIVE_ENCODE_STATUSES.has(j.status)).length
  const doneTranslateCount = translateJobs.filter(j => !ACTIVE_TRANSLATE_STATUSES.has(j.status)).length

  const currentlyEncoding = encodeJobs.find(j => j.status === "encoding")

  return (
    <div className="rounded-t-lg border border-b-0 border-border/50 bg-card/50">
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-1 py-1">
        {/* Collapse toggle */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-secondary/40"
        >
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", !isExpanded && "-rotate-90")} />
          <span className="font-medium text-foreground">Queue</span>
          {totalActive > 0 && (
            <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">{totalActive}</span>
          )}
        </button>

        {/* Inline progress peek when collapsed */}
        {currentlyEncoding && !isExpanded && (
          <div className="flex flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className="truncate">{currentlyEncoding.folder_name}</span>
            <Progress value={currentlyEncoding.progress ?? 0} className="h-1 w-24 shrink-0" />
            <span className="tabular-nums">{(currentlyEncoding.progress ?? 0).toFixed(0)}%</span>
          </div>
        )}

        <div className="ml-auto" />

        {/* Tab buttons */}
        {isExpanded && (
          <div className="flex gap-0.5">
            <TabButton
              active={activeTab === "encode"}
              onClick={() => setActiveTab("encode")}
              label="Encode"
              count={activeEncodeCount}
            />
            <TabButton
              active={activeTab === "translate"}
              onClick={() => setActiveTab("translate")}
              label="Translate"
              count={activeTranslateCount}
            />
          </div>
        )}

        {/* Group controls: pause/resume + cancel-all */}
        {isExpanded && (() => {
          const isEncode    = activeTab === "encode"
          const paused      = isEncode ? encodePaused : translatePaused
          const activeCount = isEncode ? activeEncodeCount : activeTranslateCount
          // Pause toggle is meaningful even with 0 active (so user can pre-pause new jobs)
          // Cancel-all only when something is actually active
          return (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 px-2 text-[10px]",
                  paused ? "text-accent" : "text-muted-foreground"
                )}
                onClick={handleTogglePause}
                title={paused ? "Resume queue" : "Pause queue (current job finishes)"}
              >
                {paused
                  ? <><Play className="mr-1 h-2.5 w-2.5" />Resume</>
                  : <><Pause className="mr-1 h-2.5 w-2.5" />Pause</>}
              </Button>
              {activeCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmCancelAll(isEncode ? "encode" : "translate")
                  }}
                  title="Cancel all active jobs"
                >
                  <Square className="mr-1 h-2.5 w-2.5" />
                  Stop all
                </Button>
              )}
            </>
          )
        })()}

        {/* Clear finished button */}
        {isExpanded && activeTab === "encode" && doneEncodeCount > 0 && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-muted-foreground" onClick={handleClearEncode}>
            <Trash2 className="mr-1 h-2.5 w-2.5" />
            Clear {doneEncodeCount}
          </Button>
        )}
        {isExpanded && activeTab === "translate" && doneTranslateCount > 0 && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-muted-foreground" onClick={handleClearTranslate}>
            <Trash2 className="mr-1 h-2.5 w-2.5" />
            Clear {doneTranslateCount}
          </Button>
        )}

        {/* Expand to modal */}
        {isExpanded && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); setIsModalOpen(true) }}
            title="Open queue in a larger view"
          >
            <Maximize2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      {isExpanded && (
        <div className="border-t border-border/30 bg-[#0a0a0c]">
          {((activeTab === "encode" && encodePaused) || (activeTab === "translate" && translatePaused)) && (
            <div className="flex items-center gap-2 border-b border-border/30 bg-accent/5 px-3 py-1 text-[10px] text-accent">
              <Pause className="h-2.5 w-2.5" />
              Queue paused — current job will finish, no new jobs will start
            </div>
          )}
          <div className="max-h-44 overflow-y-auto">
            {activeTab === "encode" && (
              encodeJobs.length === 0
                ? <EmptyState label="No encode jobs" />
                : <div className="divide-y divide-border/20">
                    {encodeJobs.map(job => (
                      <EncodeJobRow key={job.id} job={job} onCancel={handleCancelEncode} />
                    ))}
                  </div>
            )}
            {activeTab === "translate" && (
              translateJobs.length === 0
                ? <EmptyState label="No translation jobs" />
                : <div className="divide-y divide-border/20">
                    {translateJobs.map(job => (
                      <TranslateJobRow key={job.id} job={job} onCancel={handleCancelTranslate} />
                    ))}
                  </div>
            )}
          </div>
        </div>
      )}

      {/* ── Cancel-all confirm ─────────────────────────────────────────────── */}
      <AlertDialog open={confirmCancelAll !== null} onOpenChange={(open) => !open && setConfirmCancelAll(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Cancel all {confirmCancelAll === "encode" ? "encode" : "translation"} jobs?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This stops the active job and removes everything still queued. Already-finished jobs are kept in the history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Expanded queue modal ───────────────────────────────────────────── */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
          <DialogHeader className="border-b border-border/50 px-4 py-3">
            <DialogTitle className="text-sm font-medium">Queue</DialogTitle>
          </DialogHeader>

          {/* Tabs + group controls inside the modal */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border/30 px-3 py-2">
            <div className="flex gap-0.5">
              <TabButton
                active={activeTab === "encode"}
                onClick={() => setActiveTab("encode")}
                label="Encode"
                count={activeEncodeCount}
              />
              <TabButton
                active={activeTab === "translate"}
                onClick={() => setActiveTab("translate")}
                label="Translate"
                count={activeTranslateCount}
              />
            </div>
            <div className="ml-auto flex items-center gap-1">
              {(() => {
                const isEncode    = activeTab === "encode"
                const paused      = isEncode ? encodePaused : translatePaused
                const activeCount = isEncode ? activeEncodeCount : activeTranslateCount
                return (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn("h-7 px-2 text-xs", paused ? "text-accent" : "text-muted-foreground")}
                      onClick={handleTogglePause}
                    >
                      {paused
                        ? <><Play className="mr-1 h-3 w-3" />Resume</>
                        : <><Pause className="mr-1 h-3 w-3" />Pause</>}
                    </Button>
                    {activeCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmCancelAll(isEncode ? "encode" : "translate")}
                      >
                        <Square className="mr-1 h-3 w-3" />
                        Stop all
                      </Button>
                    )}
                    {isEncode && doneEncodeCount > 0 && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={handleClearEncode}>
                        <Trash2 className="mr-1 h-3 w-3" />
                        Clear {doneEncodeCount}
                      </Button>
                    )}
                    {!isEncode && doneTranslateCount > 0 && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={handleClearTranslate}>
                        <Trash2 className="mr-1 h-3 w-3" />
                        Clear {doneTranslateCount}
                      </Button>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          {((activeTab === "encode" && encodePaused) || (activeTab === "translate" && translatePaused)) && (
            <div className="flex items-center gap-2 border-b border-border/30 bg-accent/5 px-4 py-1.5 text-xs text-accent">
              <Pause className="h-3 w-3" />
              Queue paused — current job will finish, no new jobs will start
            </div>
          )}

          <div className="flex-1 overflow-y-auto bg-[#0a0a0c]">
            {activeTab === "encode" && (
              encodeJobs.length === 0
                ? <EmptyState label="No encode jobs" />
                : <div className="divide-y divide-border/20">
                    {encodeJobs.map(job => (
                      <EncodeJobRow key={job.id} job={job} onCancel={handleCancelEncode} />
                    ))}
                  </div>
            )}
            {activeTab === "translate" && (
              translateJobs.length === 0
                ? <EmptyState label="No translation jobs" />
                : <div className="divide-y divide-border/20">
                    {translateJobs.map(job => (
                      <TranslateJobRow key={job.id} job={job} onCancel={handleCancelTranslate} />
                    ))}
                  </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────────

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}
    >
      {label}
      {count > 0 && (
        <span className={cn("tabular-nums", active ? "text-accent" : "text-muted-foreground/70")}>{count}</span>
      )}
    </button>
  )
}

function EmptyState({ label }: { label: string }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{label}</p>
}

function EncodeJobRow({
  job,
  onCancel,
}: {
  job: EncodeJob
  onCancel: (e: React.MouseEvent, id: number) => void
}) {
  const isActive = ACTIVE_ENCODE_STATUSES.has(job.status)

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-secondary/20">
      <JobStatusDot status={job.status as any} />

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="truncate font-medium text-foreground/90">
          {job.media_type === "show" && job.show_name
            ? job.show_name
            : job.folder_name}
        </div>
        {job.media_type === "show" && job.season_episode && (
          <div className="text-[10px] text-muted-foreground">{job.season_episode}</div>
        )}
        {job.status === "encoding" && (
          <div className="text-[10px] text-muted-foreground">
            {job.job_type === "rip" ? "Ripping" : job.job_type === "remux" ? "Remuxing" : "Encoding"}
            {job.speed ? ` · ${job.speed} · ETA ${formatEta(job.eta_seconds)}` : ""}
          </div>
        )}
        {job.status === "failed" && job.error_text && (
          <div className="truncate text-[10px] text-destructive">{job.error_text}</div>
        )}
      </div>

      <span className="hidden shrink-0 text-muted-foreground sm:block">{job.original_size_gb} GB</span>

      {job.status === "encoding" && job.progress !== undefined && (
        <div className="flex shrink-0 items-center gap-2">
          <Progress value={job.progress} className="h-1 w-24" />
          <span className="w-8 tabular-nums text-muted-foreground">{job.progress.toFixed(0)}%</span>
        </div>
      )}

      {job.status === "done" && job.savings_pct != null && (
        <span className="shrink-0 text-success">-{job.savings_pct}%</span>
      )}
      {job.status === "failed"    && <span className="shrink-0 text-destructive text-[10px]">Failed</span>}
      {job.status === "cancelled" && <span className="shrink-0 text-muted-foreground text-[10px]">Cancelled</span>}

      {isActive && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => onCancel(e, job.id)}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

function TranslateJobRow({
  job,
  onCancel,
}: {
  job: TranslationJob
  onCancel: (e: React.MouseEvent, id: number) => void
}) {
  const isActive  = ACTIVE_TRANSLATE_STATUSES.has(job.status)
  const statusLabel = TRANSLATE_STATUS_LABEL[job.status] ?? job.status
  const dotStatus: DotStatus =
    job.status === "pending"   ? "queued"   :
    job.status === "done"      ? "done"     :
    job.status === "failed"    ? "failed"   :
    job.status === "cancelled" ? "cancelled":
    "encoding" // extracting | ocr | translating | muxing → pulsing dot

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-secondary/20">
      <JobStatusDot status={dotStatus} />

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground/90">
            {job.media_type === "show" && job.show_name ? job.show_name : job.folder_name}
          </span>
          {job.source_lang && (
            <span className="shrink-0 text-[10px] text-muted-foreground uppercase">{job.source_lang} → SPA</span>
          )}
        </div>
        {job.media_type === "show" && job.season_episode && (
          <div className="text-[10px] text-muted-foreground">{job.season_episode}</div>
        )}
        {/* Detailed status line */}
        {isActive && (
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn(
              "text-[10px] font-medium",
              job.status === "translating" ? "text-accent" : "text-muted-foreground"
            )}>
              {statusLabel}
            </span>
            {job.progress_detail && job.progress_detail !== job.status && (
              <span className="truncate text-[10px] text-muted-foreground">{job.progress_detail}</span>
            )}
          </div>
        )}
        {job.status === "failed" && job.error_text && (
          <div className="truncate text-[10px] text-destructive">{job.error_text}</div>
        )}
      </div>

      {isActive && job.progress != null && (
        <div className="flex shrink-0 items-center gap-2">
          <Progress value={job.progress} className="h-1 w-24" />
          <span className="w-8 tabular-nums text-muted-foreground">{job.progress.toFixed(0)}%</span>
        </div>
      )}

      {job.status === "done"      && <span className="shrink-0 text-success text-[10px]">Done</span>}
      {job.status === "failed"    && <span className="shrink-0 text-destructive text-[10px]">Failed</span>}
      {job.status === "cancelled" && <span className="shrink-0 text-muted-foreground text-[10px]">Cancelled</span>}

      {isActive && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => onCancel(e, job.id)}
        >
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
    cancelled: "bg-muted-foreground/40",
  }
  return <div className={cn("h-2 w-2 shrink-0 rounded-full", styles[status] ?? "bg-muted-foreground")} />
}

function formatEta(secs?: number): string {
  if (secs === undefined || secs < 0) return "—"
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
