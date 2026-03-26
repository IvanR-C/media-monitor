"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Loader2, RefreshCw, Search } from "lucide-react"
import type { FilterType } from "./media-library-tab"

interface FilterBarProps {
  value: FilterType
  onChange: (filter: FilterType) => void
  counts: Record<FilterType, number>
  isScanning: boolean
  scanProgress?: { scanned: number; total: number }
  lastScanResult?: { scanned: number; total: number }
  onScan: () => void
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

export function FilterBar({ value, onChange, counts, isScanning, scanProgress, lastScanResult, onScan, searchQuery, onSearchChange }: FilterBarProps) {
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

        {/* Scan button + live/static scan info */}
        <div className="flex items-center gap-2">
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

          {isScanning ? (
            /* Live counter while a scan is running */
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="tabular-nums">
                {scanProgress && scanProgress.total > 0
                  ? `${scanProgress.scanned} / ${scanProgress.total} files`
                  : 'Scanning…'}
              </span>
            </div>
          ) : lastScanResult ? (
            /* Static result from the most-recent completed scan */
            <span className="text-xs tabular-nums text-muted-foreground">
              {lastScanResult.total.toLocaleString()} files found
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
