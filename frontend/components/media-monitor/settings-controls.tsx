"use client"

import { useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export function SettingRow({ id, title, description, toggle, children }: { id: string; title: string; description: string; toggle?: boolean; children: ReactNode }) {
  return <div className={cn("flex gap-3 border-b border-border/30 py-4 last:border-b-0", toggle ? "items-center justify-between" : "flex-col sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-6")}>
    <div className="min-w-0"><Label htmlFor={id} className="text-sm font-medium">{title}</Label><p id={`${id}-description`} className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
    <div className={toggle ? "shrink-0" : "min-w-0"}>{children}</div>
  </div>
}

export function DraftInput({ id, label, value, type = "text", placeholder, max, step, maxLength, list, validate, onValueChange, onValidityChange }: {
  id: string; label: string; value: string; type?: "text" | "password" | "number"; placeholder?: string; max?: number; step?: string; maxLength?: number; list?: string;
  validate?: (value: string) => string | undefined; onValueChange: (value: string) => void; onValidityChange: (invalid: boolean) => void
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | undefined>()
  // Loaded values arrive before this field mounts. Keep invalid drafts visible until corrected.
  return <div className="w-full"><Input id={id} aria-label={label} aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`} aria-invalid={!!error} type={type} value={draft} placeholder={placeholder} min={type === "number" ? step === "any" ? 0 : 1 : undefined} max={max} step={step} maxLength={maxLength} list={list} autoComplete="off" className="h-9 bg-input text-sm" onChange={event => {
    const next = event.target.value
    setDraft(next)
    const message = validate?.(next)
    setError(message)
    onValidityChange(!!message)
    if (!message) onValueChange(next)
  }} />{error && <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive">{error}</p>}</div>
}
