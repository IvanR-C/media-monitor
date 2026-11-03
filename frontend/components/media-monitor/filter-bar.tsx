"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Loader2, RefreshCw, Search } from "lucide-react"
import type { FilterType } from "./media-library-tab"

interface FilterBarProps {
  value: FilterType; onChange: (filter: FilterType) => void; counts: Record<FilterType, number>
  isScanning: boolean; scanProgress?: { scanned: number; total: number }; lastScanResult?: { scanned: number; total: number }
  onScan: () => void; searchQuery: string; onSearchChange: (query: string) => void
}
const filters: { key: FilterType; label: string; description: string }[] = [
  { key: "all", label: "All", description: "All files in this library view." },
  { key: "needs_encoding", label: "Re-encode", description: "Files above your configured size threshold, ready to encode." },
  { key: "needs_remux", label: "Remux", description: "Files with missing language tags. Manage tracks to assign languages." },
  { key: "missing_lang", label: "Missing subtitles", description: "Files missing one or more required subtitle languages." },
  { key: "queued", label: "Queued", description: "Files waiting for a job or being processed." },
  { key: "done", label: "Done", description: "Files with a completed encode or remux job." },
  { key: "alerts", label: "Alerts", description: "Unsupported disc images or folders containing multiple video files." },
]
export function FilterBar({ value, onChange, counts, isScanning, scanProgress, lastScanResult, onScan, searchQuery, onSearchChange }: FilterBarProps) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
    <div className="relative min-w-[200px] flex-1 xl:max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="Search library" type="search" placeholder="Search titles, shows or filenames…" value={searchQuery} onChange={e => onSearchChange(e.target.value)} className="h-9 pl-8 text-sm" />
    </div>
    <div role="group" aria-label="Filter library by status" className="order-3 flex w-full flex-wrap gap-1 xl:order-none xl:w-auto xl:flex-1">
      {filters.map(filter => {
        const count = counts[filter.key] ?? 0
        const active = value === filter.key
        const disabled = filter.key !== "all" && count === 0 && !active
        return <Hint key={filter.key} content={disabled ? `No matching files. ${filter.description}` : filter.description}>
          <span tabIndex={disabled ? 0 : undefined} className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-ring">
            <button type="button" onClick={() => onChange(filter.key)} disabled={disabled} aria-pressed={active} className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-accent/15 text-accent" : disabled ? "text-muted-foreground/45" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
              {filter.label}<span className="text-[10px] tabular-nums opacity-70">{count}</span>
            </button>
          </span>
        </Hint>
      })}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <Hint content="Scan the watch directory and rebuild the library index."><Button variant="outline" size="sm" onClick={onScan} disabled={isScanning} className="h-9 gap-2 text-xs"><RefreshCw className={cn("h-3.5 w-3.5", isScanning && "animate-spin")} />{isScanning ? "Scanning…" : "Scan library"}</Button></Hint>
      {isScanning ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{scanProgress && scanProgress.total > 0 ? `${scanProgress.scanned} / ${scanProgress.total}` : "Starting…"}</span> : lastScanResult ? <span className="text-xs text-muted-foreground">{lastScanResult.total} files found</span> : null}
    </div>
  </div>
}
