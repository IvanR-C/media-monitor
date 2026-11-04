"use client"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"

export type GeminiModel = {
  id: string; name: string; input_tokens: number | null; output_tokens: number | null; thinking: boolean; known: boolean
  free: { rpm: number; tpm: number; rpd: number } | null
  price: { input: number; output: number } | null
  note: string
}
export type GeminiCatalog = { models: GeminiModel[]; as_of: string }

// Rate limits are decimal (250,000 → 250K); context windows are binary (65,536 → 64K).
const tokens = (n: number) => n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}K`
const context = (n: number) => n >= 1_048_576 ? `${Math.round(n / 1_048_576)}M` : `${Math.round(n / 1024)}K`
const usd = (n: number) => `$${n.toFixed(2)}`

/** Short tag shown next to each model name in the list. */
const tag = (m: GeminiModel) => m.free ? `Free · ${m.free.rpd.toLocaleString()}/day` : m.known ? "Paid only" : "No pricing info"

export function GeminiModelPicker({ value, onChange, catalog, loading, error, onReload, requestsPerMinute }: {
  value: string; onChange: (id: string) => void; catalog: GeminiCatalog | null; loading: boolean; error: string
  onReload: () => void; requestsPerMinute: number
}) {
  const models = catalog?.models ?? []
  const selected = models.find(m => m.id === value)
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Select value={value || undefined} onValueChange={onChange} disabled={!catalog}>
          <SelectTrigger id="gemini_model" aria-describedby="gemini_model-description" className="w-full min-w-0 bg-input">
            <SelectValue placeholder={loading ? "Loading models…" : "Add your API key to load models"} />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {!selected && value && <SelectItem value={value}>{value} · not available to this key</SelectItem>}
            {models.map(m => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}<span className="ml-1.5 text-xs opacity-60">{tag(m)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="icon" aria-label="Reload model list" title="Reload model list" disabled={loading} onClick={onReload}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error && <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}</p>}
      {selected && <ModelDetails model={selected} asOf={catalog!.as_of} requestsPerMinute={requestsPerMinute} />}
      {!selected && value && catalog && <p className="text-xs text-warning">“{value}” isn’t available to this key. Choose another model.</p>}
    </div>
  )
}

function ModelDetails({ model: m, asOf, requestsPerMinute }: { model: GeminiModel; asOf: string; requestsPerMinute: number }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs">
      {m.known ? <>
        <dt className="text-muted-foreground">Free tier</dt>
        <dd>{m.free ? `${m.free.rpm} requests/min · ${tokens(m.free.tpm)} tokens/min · ${m.free.rpd.toLocaleString()} requests/day` : "No free quota"}</dd>
        <dt className="text-muted-foreground">Paid</dt>
        <dd>{m.price ? `${usd(m.price.input)} input · ${usd(m.price.output)} output per 1M tokens` : "Not offered"}</dd>
      </> : <>
        <dt className="text-muted-foreground">Pricing</dt>
        <dd>Not in Media Monitor’s price list. Check AI Studio’s pricing and Rate limit pages.</dd>
      </>}
      {m.input_tokens && m.output_tokens && <><dt className="text-muted-foreground">Context</dt><dd>{context(m.input_tokens)} in · {context(m.output_tokens)} out</dd></>}
      {m.note && <dd className="col-span-2 text-warning">{m.note}</dd>}
      {m.free && requestsPerMinute > m.free.rpm && <dd className="col-span-2 text-warning">Requests per minute is {requestsPerMinute}, above this model’s free limit of {m.free.rpm}. Lower it unless your project is on a paid tier.</dd>}
      {m.known && <dd className="col-span-2 text-muted-foreground">Figures as of {asOf}. Your project’s own limits are under Rate limit in AI Studio.</dd>}
    </dl>
  )
}
