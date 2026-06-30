"use client"

import { cn } from "@/lib/utils"
import { Library, Settings } from "lucide-react"

interface TabNavProps {
  activeTab: "library" | "settings"
  onTabChange: (tab: "library" | "settings") => void
  isScanning?: boolean
}

export function TabNav({ activeTab, onTabChange, isScanning }: TabNavProps) {
  return (
    <nav className="mb-8 flex gap-1 rounded-lg bg-secondary/50 p-1">
      <button
        onClick={() => onTabChange("library")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all",
          activeTab === "library"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Library className="h-4 w-4" />
        Library
        {isScanning && (
          <span className="h-2 w-2 rounded-full bg-accent animate-pulse" title="Scan in progress" />
        )}
      </button>
      <button
        onClick={() => onTabChange("settings")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all",
          activeTab === "settings"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Settings className="h-4 w-4" />
        Settings
      </button>
    </nav>
  )
}
