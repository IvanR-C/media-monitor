"use client"

import { cn } from "@/lib/utils"
import { Film, Tv } from "lucide-react"
import type { MediaType } from "./media-library-tab"

interface MediaTypeSwitchProps {
  value: MediaType
  onChange: (type: MediaType) => void
}

export function MediaTypeSwitch({ value, onChange }: MediaTypeSwitchProps) {
  return (
    <div className="flex gap-1 rounded-lg bg-secondary/50 p-1">
      <button
        onClick={() => onChange("movie")}
        className={cn(
          "flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all",
          value === "movie"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Film className="h-4 w-4" />
        Movies
      </button>
      <button
        onClick={() => onChange("show")}
        className={cn(
          "flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all",
          value === "show"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Tv className="h-4 w-4" />
        Shows
      </button>
    </div>
  )
}
