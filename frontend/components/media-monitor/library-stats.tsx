import { HardDrive, FileVideo, AlertCircle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface LibraryStatsProps {
  stats: {
    total_files: number
    total_bytes: number
    needs_encoding: number
    encoding_active: number
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes < 1e12) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${(bytes / 1e12).toFixed(2)} TB`
}

export function LibraryStats({ stats }: LibraryStatsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatItem
        icon={FileVideo}
        value={stats.total_files.toLocaleString()}
        label="Total Files"
      />
      <StatItem
        icon={HardDrive}
        value={formatBytes(stats.total_bytes)}
        label="Total Size"
      />
      <StatItem
        icon={AlertCircle}
        value={stats.needs_encoding.toString()}
        label="Need Encoding"
        variant="warning"
      />
      <StatItem
        icon={Loader2}
        value={stats.encoding_active.toString()}
        label="In Queue / Active"
        variant="active"
        spinning={stats.encoding_active > 0}
      />
    </div>
  )
}

interface StatItemProps {
  icon: React.ElementType
  value: string
  label: string
  variant?: "default" | "warning" | "active"
  spinning?: boolean
}

function StatItem({ icon: Icon, value, label, variant = "default", spinning = false }: StatItemProps) {
  const iconClassName = {
    default: "text-muted-foreground",
    warning: "text-warning",
    active: "text-accent",
  }[variant]

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/30 px-4 py-3">
      <Icon className={cn(`h-4 w-4`, iconClassName, spinning && "animate-spin")} />
      <div>
        <div className="text-lg font-semibold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
