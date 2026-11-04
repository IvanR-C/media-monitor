// Client-side cache for the media library list.
//
// The backend tags every /api/media response with a library version that
// SQLite bumps on any change to media rows or job status (see
// library_version() in app.py). That makes caching safe without timeouts:
//   - the last list is kept here, outside React, so leaving and re-entering the
//     Library view renders instantly instead of refetching behind a spinner;
//   - revalidation sends the cached version as If-None-Match, so an unchanged
//     library costs a bodiless 304;
//   - polling hits the tiny /api/media/progress, which returns the current
//     version (refetch only when it moved) plus live job progress, which
//     changes too often to be part of the cached list.

export interface ProgressFields {
  id: number
  encode_progress?: number | null
  encode_job_type?: string | null
  translate_status?: string | null
  translate_progress?: number | null
}

export interface ProgressSnapshot {
  version: string
  encode: { id: number; progress: number | null; job_type: string | null }[]
  translate: { id: number; status: string; progress: number | null }[]
}

type Cached<T> = { files: T[]; version: string | null }

let cached: Cached<unknown> = { files: [], version: null }

export function getCachedLibrary<T>(): Cached<T> {
  return cached as Cached<T>
}

export function setCachedLibrary<T>(files: T[], version?: string | null) {
  cached = { files, version: version === undefined ? cached.version : version }
}

export type LibraryFetchResult<T> =
  | { status: "unchanged" }
  | { status: "updated"; files: T[]; version: string | null }

// Fetch the library, revalidating against the cached version when there is
// one. `cache: "no-store"` keeps the browser's HTTP cache out of the way so a
// 304 reaches us as-is instead of being swapped for a stored body we'd parse.
export async function fetchLibrary<T>(signal?: AbortSignal): Promise<LibraryFetchResult<T>> {
  const { files, version } = getCachedLibrary<T>()
  const headers: Record<string, string> = {}
  if (version && files.length > 0) headers["If-None-Match"] = `"${version}"`
  const r = await fetch("/api/media?type=all", { signal, headers, cache: "no-store" })
  if (r.status === 304) return { status: "unchanged" }
  if (!r.ok) throw new Error(`Library request failed (${r.status})`)
  const data = await r.json()
  return {
    status: "updated",
    files: (data.files ?? []) as T[],
    version: r.headers.get("X-Library-Version"),
  }
}

export async function fetchProgress(signal?: AbortSignal): Promise<ProgressSnapshot> {
  const r = await fetch("/api/media/progress", { signal, cache: "no-store" })
  if (!r.ok) throw new Error(`Progress request failed (${r.status})`)
  return r.json()
}

// Overlay live progress onto the cached rows. Only rows whose values actually
// moved are replaced, and the original array is returned when nothing did, so
// React memoization downstream stays effective. Rows without an active job are
// left alone: a job starting or finishing bumps the library version, and the
// refetch that follows brings the authoritative row.
export function applyProgress<T extends ProgressFields>(files: T[], snap: ProgressSnapshot): T[] {
  const encode = new Map<number, { progress: number | null; job_type: string }>()
  for (const job of snap.encode) {
    // Rows arrive newest-first: the newest job sets job_type, and progress
    // comes from the first job that reports any (matches /api/media).
    const seen = encode.get(job.id)
    if (!seen) encode.set(job.id, { progress: job.progress || null, job_type: job.job_type || "encode" })
    else if (seen.progress == null && job.progress) seen.progress = job.progress
  }
  const translate = new Map(snap.translate.map(job => [job.id, job]))
  if (encode.size === 0 && translate.size === 0) return files

  let changed = false
  const next = files.map(file => {
    const enc = encode.get(file.id)
    const tr = translate.get(file.id)
    if (!enc && !tr) return file
    const patch: Partial<ProgressFields> = {}
    if (enc) {
      if (enc.progress != null && enc.progress !== file.encode_progress) patch.encode_progress = enc.progress
      if (enc.job_type !== file.encode_job_type) patch.encode_job_type = enc.job_type
    }
    if (tr) {
      if (tr.status !== file.translate_status) patch.translate_status = tr.status
      if (tr.progress !== file.translate_progress) patch.translate_progress = tr.progress
    }
    if (Object.keys(patch).length === 0) return file
    changed = true
    return { ...file, ...patch }
  })
  return changed ? next : files
}
