export type SaveStatus = "saved" | "pending" | "saving" | "error"

/** Send only changed fields, in order, so a slow response cannot undo a newer edit. */
export class SettingsAutosave {
  private pending: Record<string, unknown> = {}
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<boolean> | undefined
  private recalculate = false
  private status: SaveStatus = "saved"

  constructor(
    private notify: (status: SaveStatus, message?: string) => void,
    private request: typeof fetch = fetch,
  ) {}

  private report(status: SaveStatus, message?: string) {
    this.status = status
    this.notify(status, message)
  }

  get hasUnsavedChanges() {
    return this.status !== "saved"
  }

  change(key: string, value: unknown, immediate = false) {
    this.pending[key] = value
    clearTimeout(this.timer)
    this.report("pending")
    if (immediate) void this.flush()
    else this.timer = setTimeout(() => void this.flush(), 600)
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.inFlight) {
      const success = await this.inFlight
      return success ? this.flush() : false
    }
    if (!Object.keys(this.pending).length && !this.recalculate) return this.status !== "error"
    this.inFlight = this.save()
    const success = await this.inFlight
    this.inFlight = undefined
    if (success && Object.keys(this.pending).length) return this.flush()
    return success
  }

  private async save() {
    const patch = this.pending
    this.pending = {}
    this.report("saving")
    let persisted = false
    try {
      if (Object.keys(patch).length) {
        const response = await this.request("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          keepalive: true,
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || "Changes couldn’t be saved. Check your connection and retry.")
        }
        persisted = true
        if ("reencode_size_gb" in patch || "required_sub_langs" in patch) this.recalculate = true
      }
      if (this.recalculate) {
        const response = await this.request("/api/media/recalculate-status", { method: "POST", keepalive: true })
        if (!response.ok) throw new Error("Settings saved, but library statuses couldn’t refresh. Retry to finish applying the rules.")
        this.recalculate = false
      }
      this.report(Object.keys(this.pending).length ? "pending" : "saved")
      return true
    } catch (error) {
      if (!persisted) this.pending = { ...patch, ...this.pending }
      this.report("error", error instanceof Error ? error.message : "Changes couldn’t be saved. Retry to apply them.")
      return false
    }
  }
}
