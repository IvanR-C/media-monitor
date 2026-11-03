import languageData from "./data/iso-639-2.json"

// Public language-code data: Library of Congress ISO 639-2 code list.
// https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt
export const LANGUAGE_OPTIONS = languageData
const codes = new Map(languageData.flatMap(item => [item.code, ...item.aliases].map(code => [code, item] as const)))

export function normalizeLanguage(value?: string): string {
  const code = (value || "").trim().toLowerCase()
  if (!code || code === "und") return ""
  return codes.get(code)?.code || code
}

export function languageLabel(value?: string): string {
  const code = normalizeLanguage(value)
  return !code ? "Unknown / unassigned" : codes.get(code)?.name || `Unlisted language (${code})`
}

export function languageSummary(tracks: { lang?: string; action?: string }[]): string {
  const languages = [...new Set(tracks.filter(t => t.action !== "drop").map(t => normalizeLanguage(t.lang) || "?"))]
  return languages.length ? languages.slice(0, 2).map(code => code.toUpperCase()).join(" · ") + (languages.length > 2 ? ` +${languages.length - 2}` : "") : "None"
}
