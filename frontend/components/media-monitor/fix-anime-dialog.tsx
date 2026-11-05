"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AnimeSettingsPanel, type AnimeSettings } from "./anime-settings";

export interface AnimeSelection {
  label: string;
  scope?: { kind: "file" | "show" | "season"; file_id: number };
  file_ids?: number[];
  /** Single movie/episode only: the subtitle track to style (and translate if needed). */
  source_sub_idx?: number;
}

interface FilePlan { file_id: number; label: string; filename: string; reason: string | null }

async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// ── Shared Fix Anime preferences ──────────────────────────────────────────────
// Library menus need to know the workflow (track choice only applies to the
// target-language one) and whether setup is done. Settings updates this as it
// saves, so the Library, which stays mounted, never goes stale.
type AnimePrefs = { configured: boolean; mode: AnimeSettings["mode"] };
let prefs: AnimePrefs | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function setAnimePrefs(next: AnimePrefs) {
  prefs = next;
  listeners.forEach(listener => listener());
}

// Settings stays mounted in the background, so it must hear about settings
// saved from the first-run dialog, or its next autosave would overwrite them.
const savedListeners = new Set<(settings: AnimeSettings) => void>();
export function onAnimeSettingsSaved(listener: (settings: AnimeSettings) => void) {
  savedListeners.add(listener);
  return () => { savedListeners.delete(listener); };
}

function loadAnimePrefs() {
  loading ??= fetch("/api/anime/settings").then(jsonResponse)
    .then(data => setAnimePrefs({ configured: !!data.configured, mode: data.settings.mode }))
    .catch(() => { loading = null; });
  return loading;
}

export function useAnimePrefs() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    if (!prefs) void loadAnimePrefs();
    return () => listeners.delete(listener);
  }, () => prefs, () => null);
}

function summarize(files: FilePlan[]) {
  const skipped = files.filter(file => file.reason);
  return skipped.slice(0, 3).map(file => `${file.label || file.filename}: ${file.reason}`).join("\n")
    + (skipped.length > 3 ? `\n…and ${skipped.length - 3} more` : "");
}

/**
 * One-click Fix Anime: queues with the saved settings, or asks for them once
 * if they were never set up. Returns `run` and the setup dialog to render.
 */
export function useFixAnime(onQueued: () => void) {
  const [setup, setSetup] = useState<{ selection: AnimeSelection; settings: AnimeSettings; fallbackTarget: string } | null>(null);
  const busy = useRef(false);

  const queue = useCallback(async (selection: AnimeSelection, mode: AnimeSettings["mode"]) => {
    const id = toast.loading(`Starting Fix Anime · ${selection.label}…`);
    try {
      const data = await fetch("/api/anime/queue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: selection.scope, file_ids: selection.file_ids,
          ...(mode === "target" && selection.source_sub_idx != null ? { source_sub_idx: selection.source_sub_idx } : {}),
        }),
      }).then(jsonResponse);
      const files: FilePlan[] = data.files;
      const skipped = files.filter(file => file.reason).length;
      if (!data.count) {
        toast.error(files.length === 1 ? "Fix Anime couldn’t start" : `Fix Anime couldn’t start for any of ${files.length} files`, { id, description: summarize(files), duration: 12000 });
        return;
      }
      toast.success(`Fix Anime queued for ${data.count === 1 && files.length === 1 ? selection.label : `${data.count} file${data.count === 1 ? "" : "s"}`}`, { id });
      if (skipped) toast.warning(`${skipped} file${skipped === 1 ? "" : "s"} skipped`, { description: summarize(files), duration: 12000 });
      onQueued();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not queue Fix Anime", { id });
    }
  }, [onQueued]);

  const run = useCallback(async (selection: AnimeSelection) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const [anime, config] = await Promise.all([
        fetch("/api/anime/settings").then(jsonResponse),
        fetch("/api/config").then(jsonResponse).catch(() => ({})),
      ]);
      setAnimePrefs({ configured: !!anime.configured, mode: anime.settings.mode });
      if (!anime.configured) {
        setSetup({ selection, settings: anime.settings, fallbackTarget: config.translation_target_lang || "" });
        return;
      }
      await queue(selection, anime.settings.mode);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load Fix Anime settings");
    } finally { busy.current = false; }
  }, [queue]);

  const dialog = setup && <FixAnimeSetupDialog {...setup} onClose={() => setSetup(null)} onSaved={settings => {
    setSetup(null);
    setAnimePrefs({ configured: true, mode: settings.mode });
    savedListeners.forEach(listener => listener(settings));
    void queue(setup.selection, settings.mode);
  }} />;
  return { run, dialog };
}

/** Shown the first time only. Later runs use the saved settings directly. */
function FixAnimeSetupDialog({ selection, settings: initial, fallbackTarget, onClose, onSaved }: {
  selection: AnimeSelection; settings: AnimeSettings; fallbackTarget: string;
  onClose: () => void; onSaved: (settings: AnimeSettings) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const missingTarget = settings.mode === "target" && !settings.target_lang && !fallbackTarget;

  async function save() {
    setSaving(true); setError("");
    try {
      const data = await fetch("/api/anime/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }).then(jsonResponse);
      onSaved(data.settings);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save Fix Anime settings"); setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" showCloseButton={!saving}>
      <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4">
        <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Set up Fix Anime</DialogTitle>
        <DialogDescription className="pr-6">Choose these once. Fix Anime buttons in the library will use them from now on, and you can change them anytime in Settings → Fix Anime.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <AnimeSettingsPanel settings={settings} onChange={next => { setSettings(next); setError(""); }} fallbackTarget={fallbackTarget} disabled={saving} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 px-5 py-4">
        <p role={error || missingTarget ? "alert" : undefined} className={`text-xs ${error ? "text-destructive" : missingTarget ? "text-warning" : "text-muted-foreground"}`}>
          {error || (missingTarget ? "Choose a target subtitle language to continue." : `Then fix: ${selection.label}`)}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={saving || missingTarget} onClick={save}>{saving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Sparkles className="mr-2 h-3 w-3" />}Save & fix</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
