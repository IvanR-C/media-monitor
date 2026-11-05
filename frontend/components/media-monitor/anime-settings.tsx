"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LanguagePicker } from "./language-picker";
import { SettingRow } from "./settings-controls";
import { languageLabel } from "@/lib/languages";

/** Mirrors anime_subtitles.DEFAULT_SETTINGS on the backend. */
export const ANIME_DEFAULTS = {
  target_lang: "", mode: "target" as "target" | "all",
  audio_languages: ["jpn", "eng", "spa"] as string[], subtitle_languages: ["eng", "spa"] as string[],
  font_name: "Noto Sans", font_size: 54, primary_color: "#FFFFFF", outline_color: "#15151F", shadow_color: "#000000",
  outline: 2.5, shadow: 1.5, margin_v: 48, alignment: 2, bold: true, italic: false, preserve_pgs_placement: true,
};
export type AnimeSettings = typeof ANIME_DEFAULTS;

const STYLE_DEFAULTS = {
  font_name: "Noto Sans", font_size: 54, primary_color: "#FFFFFF", outline_color: "#15151F", shadow_color: "#000000",
  outline: 2.5, shadow: 1.5, margin_v: 48, alignment: 2, bold: true, italic: false,
};

const Heading = ({ children, first, action }: { children: ReactNode; first?: boolean; action?: ReactNode }) =>
  <div className={first ? "flex items-center justify-between gap-2 pt-3" : "mt-6 flex items-center justify-between gap-2 border-t border-border/50 pt-6"}>
    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{children}</h3>{action}
  </div>;

/**
 * Every Fix Anime preference, shared by Settings → Fix Anime and the one-time
 * setup prompt. Only valid values are passed to `onChange`, so callers can
 * save each change as it happens.
 */
export function AnimeSettingsPanel({ settings, onChange, fallbackTarget, disabled }: {
  settings: AnimeSettings; onChange: (next: AnimeSettings) => void; fallbackTarget?: string; disabled?: boolean;
}) {
  const update = <K extends keyof AnimeSettings>(key: K, value: AnimeSettings[K]) => onChange({ ...settings, [key]: value });
  return <fieldset disabled={disabled} className="min-w-0">
    <Heading first>Workflow</Heading>
    <SettingRow id="anime-mode" title="Subtitle workflow" description={settings.mode === "target"
      ? "Use existing dialogue in your target language, or translate another subtitle with your AI translation provider. Text and PGS OCR are supported."
      : "Convert every kept subtitle track to the same ASS style in its original language. PGS tracks use OCR. No AI translation is used."}>
      <Select value={settings.mode} disabled={disabled} onValueChange={value => update("mode", value as AnimeSettings["mode"])}>
        <SelectTrigger id="anime-mode" className="w-full bg-input"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="target">Fix target language · translate only if missing</SelectItem><SelectItem value="all">Convert kept subtitles to ASS · no translation</SelectItem></SelectContent>
      </Select>
    </SettingRow>
    {settings.mode === "target" && <SettingRow id="anime-target" title="Target subtitle language" description={fallbackTarget && !settings.target_lang
      ? `Not set, so the AI translation target (${languageLabel(fallbackTarget)}) is used. The target language is always kept.`
      : "The target language is always kept. Translation model and style come from Settings → AI translation."}>
      <LanguagePicker id="anime-target" label="Target subtitle language" value={settings.target_lang} disabled={disabled} onChange={value => update("target_lang", value)} allowUnknown={false}
        clearable={!!fallbackTarget} clearLabel="Same as AI translation" placeholder={fallbackTarget ? `Same as AI translation · ${languageLabel(fallbackTarget)}` : "Choose a language…"} />
    </SettingRow>}

    <Heading>Languages to keep</Heading>
    <SettingRow id="anime-audio" title="Audio languages" description="Audio tracks in other languages are removed. At least one is required.">
      <LanguageKeepList title="audio languages" values={settings.audio_languages} onChange={v => update("audio_languages", v)} />
    </SettingRow>
    <SettingRow id="anime-subs" title="Subtitle languages" description="Subtitle tracks in other languages are removed. Add “Unknown / unassigned” to keep untagged tracks.">
      <LanguageKeepList title="subtitle languages" values={settings.subtitle_languages} onChange={v => update("subtitle_languages", v)} />
    </SettingRow>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Video is copied without encoding. Non-MKV files are remuxed to .mkv for ASS support; how originals are replaced follows Settings → Output files.</p>

    <Heading action={<Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange({ ...settings, ...STYLE_DEFAULTS })}><RefreshCw className="mr-1 h-3 w-3" />Reset style</Button>}>Subtitle style</Heading>
    <div className="grid gap-6 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <TextField id="anime-font" title="Font family" value={settings.font_name} onChange={v => update("font_name", v)} />
          <NumberField id="anime-size" title="Size (1080p)" value={settings.font_size} min={12} max={120} onChange={v => update("font_size", v)} />
        </div>
        <div className="grid grid-cols-3 gap-3">{([["primary_color", "Text"], ["outline_color", "Outline"], ["shadow_color", "Shadow"]] as const).map(([key, label]) =>
          <div key={key} className="space-y-1.5"><Label htmlFor={`anime-${key}`}>{label} color</Label><input id={`anime-${key}`} type="color" value={settings[key]} onChange={e => update(key, e.target.value)} className="h-9 w-full cursor-pointer rounded-md border border-input bg-input p-1" /></div>)}</div>
        <div className="grid grid-cols-3 gap-3">
          <NumberField id="anime-outline" title="Outline (px)" value={settings.outline} min={0} max={10} step={0.5} onChange={v => update("outline", v)} />
          <NumberField id="anime-shadow" title="Shadow (px)" value={settings.shadow} min={0} max={10} step={0.5} onChange={v => update("shadow", v)} />
          <NumberField id="anime-margin" title="Margin (px)" value={settings.margin_v} min={0} max={300} onChange={v => update("margin_v", v)} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-1 items-center gap-2"><Label htmlFor="anime-position">Position</Label><select id="anime-position" className="h-9 flex-1 rounded-md border border-input bg-input px-2 text-xs" value={settings.alignment} onChange={e => update("alignment", Number(e.target.value))}><option value={2}>Bottom center</option><option value={5}>Middle center</option><option value={8}>Top center</option></select></div>
          <label className="flex items-center gap-2 text-xs"><Checkbox checked={settings.bold} onCheckedChange={v => update("bold", v === true)} />Bold</label>
          <label className="flex items-center gap-2 text-xs"><Checkbox checked={settings.italic} onCheckedChange={v => update("italic", v === true)} />Italic</label>
        </div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={settings.preserve_pgs_placement} onCheckedChange={v => update("preserve_pgs_placement", v === true)} />Preserve original placement (PGS)</label>
        <p className="text-xs leading-relaxed text-muted-foreground">Keeps separate text regions and each original position change while applying your font and outline. Position and margin apply to text subtitles, or to PGS when this is off.</p>
      </div>
      <AnimeStylePreview settings={settings} />
    </div>
  </fieldset>;
}

/** Renders the style with libass on the server, debounced while editing. */
export function AnimeStylePreview({ settings }: { settings: AnimeSettings }) {
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [sample, setSample] = useState("Even across the stars,\nI will always find my way back to you.");
  const [scene, setScene] = useState("style");
  const body = JSON.stringify({ settings, text: sample, scene });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/anime/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Preview failed (${response.status})`);
        }
        const blob = await response.blob();
        if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setPreview(objectUrl); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not render preview");
      } finally { if (!controller.signal.aborted) setBusy(false); }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [body]);

  return <div className="min-w-0 space-y-3 lg:sticky lg:top-20 lg:self-start">
    <div className="flex items-center justify-between"><span className="text-sm font-medium">Preview</span><span className="text-[10px] uppercase tracking-wide text-muted-foreground">ASS · 1920 × 1080</span></div>
    <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-[#172438]" aria-busy={busy}>
      {preview && !error && <img src={preview} alt="Rendered preview of your ASS subtitle style on a sample background" className="h-full w-full object-contain" />}
      {(busy || error) && <div className={`absolute inset-0 flex items-center justify-center bg-background/70 px-6 text-center text-xs ${error && !busy ? "text-destructive" : "text-muted-foreground"}`} role={error && !busy ? "alert" : "status"}>
        {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Rendering ASS…</> : error}
      </div>}
    </div>
    <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
      <div className="space-y-1.5"><Label htmlFor="anime-preview-scene">Scene</Label><select id="anime-preview-scene" value={scene} onChange={e => setScene(e.target.value)} className="h-9 w-full rounded-md border border-input bg-input px-2 text-xs"><option value="style">Style sample</option><option value="pgs_top">PGS · top of screen</option><option value="pgs_bottom">PGS · bottom of screen</option><option value="pgs_right">PGS · right side</option></select></div>
      <div className="space-y-1.5"><Label htmlFor="anime-sample">Dialogue</Label><textarea id="anime-sample" value={sample} maxLength={400} rows={2} onChange={e => setSample(e.target.value)} className="w-full resize-y rounded-md border border-input bg-input px-3 py-2 text-sm" /></div>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">Rendered with libass using server fonts; missing fonts use a fallback. PGS scenes simulate source placement so you can compare the preservation setting.</p>
  </div>;
}

// Inputs keep a local draft so half-typed values ("1" on the way to "54") are
// never saved; only in-range values reach onChange.
function NumberField({ id, title, value, min, max, step = 1, onChange }: {
  id: string; title: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { if (Number(draft) !== value) setDraft(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = Number(draft);
  const invalid = !draft.trim() || !Number.isFinite(n) || n < min || n > max;
  return <div className="space-y-1.5"><Label htmlFor={id}>{title}</Label>
    <Input id={id} type="number" min={min} max={max} step={step} value={draft} aria-invalid={invalid} className="bg-input" onChange={e => {
      setDraft(e.target.value);
      const next = Number(e.target.value);
      if (e.target.value.trim() && Number.isFinite(next) && next >= min && next <= max) onChange(next);
    }} />
    {invalid && <p className="text-[11px] text-destructive">{min}–{max}</p>}
  </div>;
}

function TextField({ id, title, value, onChange }: { id: string; title: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (draft.trim() !== value) setDraft(value); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const error = !draft.trim() ? "Enter a font name." : /[,{}\\]/.test(draft) ? "Commas, braces and backslashes aren’t allowed." : "";
  return <div className="space-y-1.5"><Label htmlFor={id}>{title}</Label>
    <Input id={id} list="anime-fonts" value={draft} maxLength={80} aria-invalid={!!error} className="bg-input" onChange={e => {
      setDraft(e.target.value);
      const next = e.target.value.trim();
      if (next && !/[,{}\\]/.test(next)) onChange(next);
    }} />
    <datalist id="anime-fonts"><option>Noto Sans</option><option>Noto Serif</option><option>Arial</option><option>Verdana</option></datalist>
    {error && <p className="text-[11px] text-destructive">{error}</p>}
  </div>;
}

function LanguageKeepList({ title, values, onChange }: { title: string; values: string[]; onChange: (v: string[]) => void }) {
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-1.5">{values.map(value => <span key={value} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/40 py-1 pl-2 text-xs">
      <span className="truncate">{languageLabel(value)}</span>
      <button type="button" disabled={values.length === 1} aria-label={`Remove ${languageLabel(value)} from ${title}`} title={values.length === 1 ? "Keep at least one language" : undefined} onClick={() => onChange(values.filter(v => v !== value))} className="rounded p-1 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:text-current"><X className="h-3 w-3" /></button>
    </span>)}</div>
    <LanguagePicker label={`Add to ${title}`} placeholder="Add a language…" value="" onChange={value => { const lang = value || "und"; if (!values.includes(lang)) onChange([...values, lang]); }} />
  </div>;
}
