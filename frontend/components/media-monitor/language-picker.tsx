"use client"

import { useState } from "react"
import { Check, ChevronsUpDown, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { languageLabel, normalizeLanguage, LANGUAGE_OPTIONS } from "@/lib/languages"
import { cn } from "@/lib/utils"

export function LanguagePicker({ value, onChange, label, disabled = false, allowUnknown = true, placeholder, id, clearable = false, clearLabel = "No target selected" }: {
  value: string; onChange: (value: string) => void; label: string; disabled?: boolean; allowUnknown?: boolean; placeholder?: string; id?: string; clearable?: boolean; clearLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const normalized = normalizeLanguage(value)
  const selected = LANGUAGE_OPTIONS.find(item => item.code === normalized)
  const custom = normalized && !selected
  const choose = (code: string) => { onChange(code); setOpen(false) }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button id={id} variant="outline" role="combobox" aria-label={label} aria-expanded={open} disabled={disabled} className="h-9 w-full min-w-0 justify-between bg-input text-xs font-normal hover:bg-secondary hover:text-foreground">
        <span className="truncate">{!normalized && placeholder ? placeholder : languageLabel(value)}</span><ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] p-0">
      <Command defaultValue={selected ? `${selected.name} ${selected.code} ${selected.aliases.join(" ")}` : normalized || "Unknown und unassigned"}>
        <CommandInput placeholder="Search language or code…" aria-label={`Search ${label.toLowerCase()}`} />
        <CommandList className="max-h-56">
          <CommandEmpty>No matching language.</CommandEmpty>
          <CommandGroup>
            {clearable && <CommandItem value={`Clear ${clearLabel}`} onSelect={() => choose("")}>{clearLabel}</CommandItem>}
            {allowUnknown && <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" value="Unknown und unassigned" onSelect={() => choose("")}><Check className={cn("h-3.5 w-3.5", normalized && "invisible")} />Unknown / unassigned</CommandItem>}
            {custom && <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" value={normalized} onSelect={() => choose(normalized)}><Check className="h-3.5 w-3.5" />{languageLabel(value)}<span className="ml-auto font-mono text-xs text-muted-foreground">{value}</span></CommandItem>}
            {LANGUAGE_OPTIONS.filter(item => item.code !== "und" && (allowUnknown || !["mis", "mul", "zxx"].includes(item.code))).map(item => <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" key={item.code} value={`${item.name} ${item.code} ${item.aliases.join(" ")}`} onSelect={() => choose(item.code)}>
              <Check className={cn("h-3.5 w-3.5 shrink-0", normalized !== item.code && "invisible")} /><span className="min-w-0 truncate">{item.name}</span><span className="ml-auto font-mono text-xs text-muted-foreground">{item.code}</span>
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}

/** Searchable multi-select: selected languages as removable chips plus an "Add language" search. */
export function LanguageMultiPicker({ value, onChange, label, id, emptyLabel, disabled = false }: {
  value: string[]; onChange: (value: string[]) => void; label: string; id?: string; emptyLabel: string; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = new Set(value.map(normalizeLanguage).filter(Boolean))
  const toggle = (code: string) => onChange(selected.has(code) ? value.filter(c => normalizeLanguage(c) !== code) : [...value, code])
  return <div id={id} role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
    {!selected.size && <span className="text-xs text-muted-foreground">{emptyLabel}</span>}
    {[...selected].map(code => <span key={code} className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 py-1 pl-2 pr-1 text-xs text-accent">
      {languageLabel(code)}
      <button type="button" disabled={disabled} aria-label={`Remove ${languageLabel(code)}`} onClick={() => toggle(code)} className="rounded p-0.5 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3 w-3" /></button>
    </span>)}
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={`Add to ${label.toLowerCase()}`} className="h-7 bg-input px-2 text-xs font-normal"><Plus className="h-3 w-3" />Add language</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] p-0">
        <Command>
          <CommandInput placeholder="Search language or code…" aria-label={`Search ${label.toLowerCase()}`} />
          <CommandList className="max-h-56">
            <CommandEmpty>No matching language.</CommandEmpty>
            <CommandGroup>
              {LANGUAGE_OPTIONS.filter(item => !["und", "mis", "mul", "zxx"].includes(item.code)).map(item => <CommandItem className="data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground" key={item.code} value={`${item.name} ${item.code} ${item.aliases.join(" ")}`} onSelect={() => toggle(item.code)}>
                <Check className={cn("h-3.5 w-3.5 shrink-0", !selected.has(item.code) && "invisible")} /><span className="min-w-0 truncate">{item.name}</span><span className="ml-auto font-mono text-xs text-muted-foreground">{item.code}</span>
              </CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>
}
