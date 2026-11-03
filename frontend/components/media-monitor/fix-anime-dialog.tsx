"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LanguagePicker } from "./language-picker";
import { languageLabel } from "@/lib/languages";

export interface AnimeSelection {
  label: string;
  scope?: { kind: "file" | "show" | "season"; file_id: number };
  file_ids?: number[];
}

interface AnimeSettings {
  target_lang: string;
  mode: "target" | "all";
  audio_languages: string[];
  subtitle_languages: string[];
  font_name: string;
  font_size: number;
  primary_color: string;
  outline_color: string;
  shadow_color: string;
  outline: number;
  shadow: number;
  margin_v: number;
  alignment: number;
  bold: boolean;
  italic: boolean;
  preserve_pgs_placement: boolean;
}

interface FilePlan {
  file_id: number;
  filename: string;
  label: string;
  reason: string | null;
  needs_translation: boolean;
  ass_tracks: number;
  audio_removed: number;
  subtitles_removed: number;
  output_filename: string;
  converts_container: boolean;
}

async function jsonResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function FixAnimeDialog({ selection, onClose, onQueued }: {
  selection: AnimeSelection; onClose: () => void; onQueued: () => void;
}) {
  const [settings, setSettings] = useState<AnimeSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<FilePlan[]>([]);
  const [planKey, setPlanKey] = useState("");
  const [planError, setPlanError] = useState("");
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(true);
  const [sample, setSample] = useState("Even across the stars,\nI will always find my way back to you.");
  const [previewScene, setPreviewScene] = useState("style");
  const payload = JSON.stringify({ scope: selection.scope, file_ids: selection.file_ids, settings });
  const planning = planKey !== payload;
  const eligible = planning ? [] : plan.filter(file => !file.reason);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    fetch("/api/anime/settings", { signal: controller.signal }).then(jsonResponse)
      .then(data => setSettings(data.settings))
      .catch(e => { if (!controller.signal.aborted) setLoadError(e.message); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!settings) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/anime/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: controller.signal })
        .then(jsonResponse).then(data => {
          if (!controller.signal.aborted) { setPlan(data.files); setPlanError(""); setPlanKey(payload); }
        }).catch(e => { if (!controller.signal.aborted) { setPlanError(e.message); setPlanKey(payload); } });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [payload, settings]);

  useEffect(() => {
    if (!settings) return;
    const controller = new AbortController();
    let objectUrl = "";
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/anime/preview", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings, text: sample, scene: previewScene }), signal: controller.signal });
        if (!response.ok) { await jsonResponse(response); return; }
        const blob = await response.blob();
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setPreview(objectUrl); setPreviewError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setPreviewError(e instanceof Error ? e.message : "Could not render preview");
      } finally { if (!controller.signal.aborted) setPreviewBusy(false); }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [settings, sample, previewScene]);

  function update<K extends keyof AnimeSettings>(key: K, value: AnimeSettings[K]) {
    setSettings(previous => previous && { ...previous, [key]: value });
    setSaved(false); setError("");
  }

  async function save(queue: boolean) {
    setSaving(true); setError("");
    try {
      const data = await fetch(queue ? "/api/anime/queue" : "/api/anime/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: queue ? payload : JSON.stringify(settings),
      }).then(jsonResponse);
      setSaved(true);
      if (queue) {
        const skipped = data.files.filter((file: FilePlan) => file.reason);
        if (data.count) {
          toast.success(`Fix Anime queued for ${data.count} file${data.count === 1 ? "" : "s"}. Settings saved.`);
          if (skipped.length) toast.info(`${skipped.length} file(s) skipped. Open Fix Anime again to review.`);
          onQueued(); onClose();
        } else {
          setPlan(data.files); setError("No files could be queued. Review the reasons below.");
        }
      } else toast.success("Anime settings saved for next time");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save anime settings"); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl lg:h-[92dvh]" showCloseButton={!saving}>
      <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4">
        <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Fix Anime</DialogTitle>
        <DialogDescription className="pr-6">{selection.label} · Style subtitles and keep the languages you want.</DialogDescription>
      </DialogHeader>
      {!settings ? <div className="p-10 text-center text-sm text-muted-foreground">
        {loadError ? <div role="alert">{loadError}<Button variant="outline" size="sm" className="ml-3" onClick={() => setReload(v => v + 1)}>Retry</Button></div> : <><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Loading saved settings…</>}
      </div> : <>
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <div className="grid gap-6 p-5 lg:h-full lg:min-h-0 lg:grid-cols-[1fr_1.05fr]">
            <fieldset disabled={saving} className="min-w-0 space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-2">
              <div className="space-y-2">
                <Label htmlFor="anime-mode">Subtitle workflow</Label>
                <select id="anime-mode" value={settings.mode} onChange={e => update("mode", e.target.value as AnimeSettings["mode"])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="target">Fix target language · translate only if missing</option>
                  <option value="all">Convert kept subtitles to ASS · no translation</option>
                </select>
                <p className="text-xs leading-relaxed text-muted-foreground">{settings.mode === "target"
                  ? "Use existing dialogue in your target language, or translate another subtitle with your configured AI provider. Text and PGS OCR are supported."
                  : "Convert every kept subtitle track to the same ASS style in its original language. PGS tracks use OCR. No AI translation is used."}</p>
              </div>
              {settings.mode === "target" && <div className="space-y-2"><Label>Target subtitle language</Label>
                <LanguagePicker label="Target subtitle language" value={settings.target_lang} onChange={v => update("target_lang", v)} allowUnknown={false} />
                <p className="text-xs text-muted-foreground">The target language is always kept. Spanish uses the existing Cuban Spanish translation style.</p>
              </div>}
              <LanguageKeepList title="Keep audio languages" values={settings.audio_languages} onChange={v => update("audio_languages", v)} />
              <LanguageKeepList title="Keep subtitle languages" values={settings.subtitle_languages} onChange={v => update("subtitle_languages", v)} />
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                Other embedded languages, including untagged tracks, will be removed. Add “Unknown / unassigned” to keep untagged tracks. Video is copied without encoding.
              </div>
              <div className="space-y-3 border-t border-border/60 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">ASS style</h3><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
                  setSettings(s => s && { ...s, font_name: "Noto Sans", font_size: 54, primary_color: "#FFFFFF", outline_color: "#15151F", shadow_color: "#000000", outline: 2.5, shadow: 1.5, margin_v: 48, alignment: 2, bold: true, italic: false }); setSaved(false);
                }}><RefreshCw className="mr-1 h-3 w-3" />Reset style</Button></div>
                <div className="grid grid-cols-[1fr_100px] gap-3">
                  <div className="space-y-1.5"><Label htmlFor="anime-font">Font family</Label><Input id="anime-font" list="anime-fonts" value={settings.font_name} maxLength={80} onChange={e => update("font_name", e.target.value)} /><datalist id="anime-fonts"><option>Noto Sans</option><option>Noto Serif</option><option>Arial</option><option>Verdana</option></datalist></div>
                  <NumberField id="anime-size" title="Size (1080p)" value={settings.font_size} min={12} max={120} onChange={v => update("font_size", v)} />
                </div>
                <div className="grid grid-cols-3 gap-3">{([['primary_color', 'Text'], ['outline_color', 'Outline'], ['shadow_color', 'Shadow']] as const).map(([key, label]) =>
                  <div key={key} className="space-y-1.5"><Label htmlFor={`anime-${key}`}>{label} color</Label><input id={`anime-${key}`} type="color" value={settings[key]} onChange={e => update(key, e.target.value)} className="h-9 w-full cursor-pointer rounded-md border border-input bg-input p-1" /></div>)}</div>
                <div className="grid grid-cols-3 gap-3">
                  <NumberField id="anime-outline" title="Outline (px)" value={settings.outline} min={0} max={10} step={0.5} onChange={v => update("outline", v)} />
                  <NumberField id="anime-shadow" title="Shadow (px)" value={settings.shadow} min={0} max={10} step={0.5} onChange={v => update("shadow", v)} />
                  <NumberField id="anime-margin" title="Margin (px)" value={settings.margin_v} min={0} max={300} onChange={v => update("margin_v", v)} />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex flex-1 items-center gap-2"><Label htmlFor="anime-position">Position</Label><select id="anime-position" className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-xs" value={settings.alignment} onChange={e => update("alignment", Number(e.target.value))}><option value={2}>Bottom center</option><option value={5}>Middle center</option><option value={8}>Top center</option></select></div>
                  <label className="flex items-center gap-2 text-xs"><Checkbox checked={settings.bold} onCheckedChange={v => update("bold", v === true)} />Bold</label>
                  <label className="flex items-center gap-2 text-xs"><Checkbox checked={settings.italic} onCheckedChange={v => update("italic", v === true)} />Italic</label>
                </div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={settings.preserve_pgs_placement} onCheckedChange={v => update("preserve_pgs_placement", v === true)} />Preserve original placement (PGS)</label>
                <p className="text-xs leading-relaxed text-muted-foreground">Keep separate text regions and each original position change while applying your font and outline. Position and margin above apply to text subtitles, or to PGS when this option is off. Fonts and translated text fitting the source space remain approximate.</p>
              </div>
            </fieldset>
            <div className="min-w-0 space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-2">
              <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Subtitle preview</h3><span className="text-[10px] uppercase tracking-wide text-muted-foreground">ASS · 1920 × 1080</span></div>
              <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-[#172438]" aria-busy={previewBusy}>
                {preview && !previewError && <img src={preview} alt="Rendered preview of your ASS subtitle style on a sample background" className="h-full w-full object-contain" />}
                {(previewBusy || previewError) && <div className={`absolute inset-0 flex items-center justify-center bg-background/70 px-6 text-center text-xs ${previewError && !previewBusy ? "text-destructive" : "text-muted-foreground"}`} role={previewError && !previewBusy ? "alert" : "status"}>
                  {previewBusy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Rendering ASS…</> : previewError}
                </div>}
              </div>
              <div className="space-y-2"><Label htmlFor="anime-preview-scene">Preview scene</Label><select id="anime-preview-scene" value={previewScene} disabled={saving} onChange={e => setPreviewScene(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="style">Style sample</option><option value="pgs_top">PGS example · top of screen</option><option value="pgs_bottom">PGS example · bottom of screen</option><option value="pgs_right">PGS example · right side</option></select></div>
              <p className="text-xs leading-relaxed text-muted-foreground">Rendered with libass using server fonts; missing fonts use a fallback. PGS examples simulate source placement so you can compare the preservation setting. Actual PGS output follows each cue’s source position and timing. Other typesetting and graphical effects are flattened.</p>
              <div className="space-y-2"><Label htmlFor="anime-sample">Preview dialogue</Label><textarea id="anime-sample" value={sample} disabled={saving} maxLength={400} rows={2} onChange={e => setSample(e.target.value)} className="w-full resize-y rounded-md border border-input bg-input px-3 py-2 text-sm" /></div>
              <div className="rounded-lg border border-border/70 bg-secondary/20 p-4">
                <h3 className="mb-2 text-sm font-medium">Review before running</h3>
                {planning ? <p role="status" className="flex items-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-3 w-3 animate-spin" />Checking files and language filters…</p> : planError ? <p role="alert" className="text-xs text-destructive">{planError}</p> : <>
                  <p className="text-xs leading-relaxed text-muted-foreground">{eligible.length} of {plan.length} files ready · {eligible.filter(f => f.needs_translation).length} need AI translation</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{eligible.reduce((n, f) => n + f.ass_tracks, 0)} styled ASS tracks · remove {eligible.reduce((n, f) => n + f.audio_removed, 0)} audio and {eligible.reduce((n, f) => n + f.subtitles_removed, 0)} unwanted subtitle tracks</p>
                  <div className="mt-3 max-h-52 space-y-2 overflow-y-auto pr-1">{plan.map(file => <div key={file.file_id} className="border-t border-border/40 pt-2 text-xs"><div className="truncate font-medium" title={file.filename}>{file.label}</div><p className={`mt-0.5 leading-relaxed ${file.reason ? "text-warning" : "text-muted-foreground"}`}>{file.reason ? `Skipped: ${file.reason}` : `${file.ass_tracks} ASS · ${file.needs_translation ? "AI translation" : "No translation"} · remove ${file.audio_removed} audio / ${file.subtitles_removed} unwanted subs`}</p>{!file.reason && file.converts_container && <p className="mt-1 break-all text-accent">Remux to {file.output_filename}</p>}</div>)}</div>
                </>}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">All supported video formats can be processed. Non-MKV files are remuxed to .mkv for ASS support, without re-encoding video or audio. After verification, the library is updated and the original container is removed. Existing MKVs are updated in place. Files without a readable subtitle source are skipped.</p>
            </div>
          </div>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border/60 px-5 py-4">
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{saved ? "Settings saved for next time." : "Settings are saved when you save or queue."}</p>
            <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>Cancel</Button><Button variant="outline" size="sm" disabled={saving} onClick={() => save(false)}>Save settings</Button><Button size="sm" disabled={saving || planning || !!planError || !eligible.length} onClick={() => save(true)}>{saving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Sparkles className="mr-2 h-3 w-3" />}Save & queue{eligible.length ? ` ${eligible.length} file${eligible.length === 1 ? "" : "s"}` : ""}</Button></div>
          </div>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

function NumberField({ id, title, value, min, max, step = 1, onChange }: {
  id: string; title: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  return <div className="space-y-1.5"><Label htmlFor={id}>{title}</Label><Input id={id} type="number" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></div>;
}

function LanguageKeepList({ title, values, onChange }: { title: string; values: string[]; onChange: (v: string[]) => void }) {
  return <div className="space-y-2"><Label>{title}</Label><div className="flex flex-wrap gap-1.5">{values.map(value => <span key={value} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/40 py-1 pl-2 text-xs"><span className="truncate">{languageLabel(value)}</span><button type="button" aria-label={`Remove ${languageLabel(value)} from ${title.toLowerCase()}`} onClick={() => onChange(values.filter(v => v !== value))} className="rounded p-1 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3 w-3" /></button></span>)}</div><LanguagePicker label={`Add to ${title.toLowerCase()}`} placeholder="Add a language…" value="" onChange={value => { const lang = value || "und"; if (!values.includes(lang)) onChange([...values, lang]); }} /></div>;
}
