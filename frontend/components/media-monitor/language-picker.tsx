"use client"

import { useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { languageLabel, normalizeLanguage, LANGUAGE_OPTIONS } from "@/lib/languages"
import { cn } from "@/lib/utils"

export function LanguagePicker({ value, onChange, label, disabled = false, allowUnknown = true }: {
  value: string; onChange: (value: string) => void; label: string; disabled?: boolean; allowUnknown?: boolean
}) {
  const [open, setOpen] = useState(false)
  const normalized = normalizeLanguage(value)
  const selected = LANGUAGE_OPTIONS.find(item => item.code === normalized)
  const custom = normalized && !selected
  const choose = (code: string) => { onChange(code); setOpen(false) }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="outline" role="combobox" aria-label={label} aria-expanded={open} disabled={disabled} className="h-9 w-full min-w-0 justify-between bg-input text-xs font-normal hover:bg-secondary hover:text-foreground">
        <span className="truncate">{languageLabel(value)}</span><ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] p-0">
      <Command defaultValue={selected ? `${selected.name} ${selected.code} ${selected.aliases.join(" ")}` : normalized || "Unknown und unassigned"}>
        <CommandInput placeholder="Search language or code…" aria-label={`Search ${label.toLowerCase()}`} />
        <CommandList className="max-h-56">
          <CommandEmpty>No matching language.</CommandEmpty>
          <CommandGroup>
            {allowUnknown && <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" value="Unknown und unassigned" onSelect={() => choose("")}><Check className={cn("h-3.5 w-3.5", normalized && "invisible")} />Unknown / unassigned</CommandItem>}
            {custom && <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" value={normalized} onSelect={() => choose(normalized)}><Check className="h-3.5 w-3.5" />{languageLabel(value)}<span className="ml-auto font-mono text-xs text-muted-foreground">{value}</span></CommandItem>}
            {LANGUAGE_OPTIONS.filter(item => item.code !== "und").map(item => <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" key={item.code} value={`${item.name} ${item.code} ${item.aliases.join(" ")}`} onSelect={() => choose(item.code)}>
              <Check className={cn("h-3.5 w-3.5 shrink-0", normalized !== item.code && "invisible")} /><span className="min-w-0 truncate">{item.name}</span><span className="ml-auto font-mono text-xs text-muted-foreground">{item.code}</span>
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
