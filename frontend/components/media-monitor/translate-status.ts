// Shared labels and helpers for the subtitle translation pipeline.
// Phases run in order: pending → extracting → ocr → translating → muxing → done/failed/cancelled.

export const TRANSLATE_PHASES = [
  "extracting",
  "ocr",
  "translating",
  "muxing",
] as const;

export type TranslatePhase = (typeof TRANSLATE_PHASES)[number];

export const TRANSLATE_PHASE_COUNT = TRANSLATE_PHASES.length;

export const TRANSLATE_STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  extracting: "Extracting",
  ocr: "OCR",
  translating: "Translating",
  muxing: "Muxing",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const ACTIVE_TRANSLATE_STATUSES = new Set<string>([
  "pending",
  ...TRANSLATE_PHASES,
]);

export function translatePhaseIndex(status: string | undefined): number | null {
  if (!status) return null;
  const i = (TRANSLATE_PHASES as readonly string[]).indexOf(status);
  return i >= 0 ? i + 1 : null;
}
