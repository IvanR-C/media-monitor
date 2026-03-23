"use client"

import { cn } from "@/lib/utils"
import { LayoutDashboard, Library } from "lucide-react"

interface TabNavProps {
  activeTab: "dashboard" | "media"
  onTabChange: (tab: "dashboard" | "media") => void
  isScanning?: boolean
}

export function TabNav({ activeTab, onTabChange, isScanning }: TabNavProps) {
  return (
    <nav className="mb-8 flex gap-1 rounded-lg bg-secondary/50 p-1">
      <button
        onClick={() => onTabChange("dashboard")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all",
          activeTab === "dashboard"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <LayoutDashboard className="h-4 w-4" />
        Dashboard
      </button>
      <button
        onClick={() => onTabChange("media")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all",
          activeTab === "media"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Library className="h-4 w-4" />
        Media Library
        {isScanning && (
          <span className="h-2 w-2 rounded-full bg-accent animate-pulse" title="Scan in progress" />
        )}
      </button>
    </nav>
  )
}
