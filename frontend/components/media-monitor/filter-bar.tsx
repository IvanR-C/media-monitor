"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Loader2, RefreshCw, Search, RotateCcw } from "lucide-react"
import type { FilterType } from "./media-library-tab"

interface FilterBarProps {
  value: FilterType
  onChange: (filter: FilterType) => void
  counts: Record<FilterType, number>
  isScanning: boolean
  scanProgress?: { scanned: number; total: number }
  onScan: () => void
  onRecalculate: () => void
  searchQuery: string
  onSearchChange: (query: string) => void
}

const filters: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_encoding", label: "Re-encode" },
  { key: "needs_remux", label: "Remux" },
  { key: "missing_lang", label: "Missing Sub" },
  { key: "queued", label: "Queued" },
  { key: "done", label: "Done" },
  { key: "alerts", label: "Alerts" }
]

export function FilterBar({ value, onChange, counts, isScanning, scanProgress, onScan, onRecalculate, searchQuery, onSearchChange }: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="relative flex-1 sm:max-w-xs">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-8 pl-8 text-sm"
        />
      </div>
      
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {filters.map(filter => (
            <button
              key={filter.key}
              onClick={() => onChange(filter.key)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all",
                value === filter.key
                  ? "bg-accent/15 text-accent"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              {filter.label}
              <span className={cn(
                "tabular-nums",
                value === filter.key ? "text-accent/70" : "text-muted-foreground/70"
              )}>
                {counts[filter.key]}
              </span>
            </button>
          ))}
        </div>

        {isScanning && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              {scanProgress && scanProgress.total > 0
                ? `Scanning ${scanProgress.scanned}/${scanProgress.total}`
                : 'Scanning…'}
            </span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={onScan}
          disabled={isScanning}
          className="h-7 px-2 text-xs"
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", isScanning && "animate-spin")} />
          Scan
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRecalculate}
          disabled={isScanning}
          className="h-7 px-2 text-xs"
          title="Recalculate status from stored track data (fast — no ffprobe)"
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          Recalc
        </Button>
      </div>
    </div>
  )
}
