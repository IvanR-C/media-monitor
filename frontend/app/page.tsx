"use client"

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Header } from "@/components/media-monitor/header"
import { SettingsTab } from "@/components/media-monitor/settings-tab"
import { MediaLibraryTab } from "@/components/media-monitor/media-library-tab"
import { AuthGate } from "@/components/media-monitor/auth-gate"
import { Toaster } from "@/components/ui/sonner"

export type ScanState = {
  isScanning: boolean
  scanProgress?: { scanned: number; total: number }
  lastScanResult?: { scanned: number; total: number }
  onScan: () => void
  onFolderScan: (fileIds: number[]) => void
}

export default function MediaMonitor() {
  const [activeView, setActiveView] = useState<"library" | "settings">("library")
  const [settingsVisited, setSettingsVisited] = useState(false)
  const [librarySettingsRequest, setLibrarySettingsRequest] = useState(0)

  // ── Scan state lives here so it survives tab switches ────────────────────────
  const [isScanning, setIsScanning]       = useState(false)
  const [scanProgress, setScanProgress]   = useState<{ scanned: number; total: number } | undefined>()
  const [lastScanResult, setLastScanResult] = useState<{ scanned: number; total: number } | undefined>()
  const scanPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clean up the interval if the whole app unmounts
  useEffect(() => () => { if (scanPollRef.current) clearInterval(scanPollRef.current) }, [])

  const handleScan = useCallback(async () => {
    if (isScanning) return
    setIsScanning(true)
    try {
      const r    = await fetch('/api/media/scan', { method: 'POST' })
      const data = await r.json()
      if (data.error) toast.info(data.error)
      else toast.success('Scan started — library cleared for clean rescan')

      const stopPoll = (finalStatus?: { scanned: number; total: number }) => {
        if (scanPollRef.current) { clearInterval(scanPollRef.current); scanPollRef.current = null }
        setIsScanning(false)
        setScanProgress(undefined)
        if (finalStatus && finalStatus.total > 0) setLastScanResult(finalStatus)
        // MediaLibraryTab detects isScanning→false and reloads on its own
      }

      const doPoll = async () => {
        try {
          const st = await fetch('/api/media/scan/status').then(r => r.json())
          if (st.total > 0) setScanProgress({ scanned: st.scanned, total: st.total })
          if (!st.running) stopPoll({ scanned: st.scanned, total: st.total })
        } catch { /* ignore transient errors */ }
      }

      setTimeout(doPoll, 300)
      if (scanPollRef.current) clearInterval(scanPollRef.current)
      scanPollRef.current = setInterval(doPoll, 2000)
    } catch {
      toast.error('Scan failed to start')
      setIsScanning(false)
    }
  }, [isScanning])

  const handleFolderScan = useCallback(async (fileIds: number[]) => {
    if (isScanning) { toast.info('A scan is already in progress'); return }
    setIsScanning(true)
    try {
      const r = await fetch('/api/media/scan/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: fileIds }),
      })
      const data = await r.json()
      if (data.error) { toast.info(data.error); setIsScanning(false); return }
      toast.success('Folder scan started')

      const stopPoll = (finalStatus?: { scanned: number; total: number }) => {
        if (scanPollRef.current) { clearInterval(scanPollRef.current); scanPollRef.current = null }
        setIsScanning(false)
        setScanProgress(undefined)
        if (finalStatus && finalStatus.total > 0) setLastScanResult(finalStatus)
      }
      const doPoll = async () => {
        try {
          const st = await fetch('/api/media/scan/status').then(r => r.json())
          if (st.total > 0) setScanProgress({ scanned: st.scanned, total: st.total })
          if (!st.running) stopPoll({ scanned: st.scanned, total: st.total })
        } catch { /* ignore */ }
      }
      setTimeout(doPoll, 300)
      if (scanPollRef.current) clearInterval(scanPollRef.current)
      scanPollRef.current = setInterval(doPoll, 2000)
    } catch {
      toast.error('Folder scan failed to start')
      setIsScanning(false)
    }
  }, [isScanning])

  // Each view keeps its own page scroll position (the page scrolls on phones;
  // on desktop the library table scrolls inside its own panel).
  const pageScroll = useRef<Record<"library" | "settings", number>>({ library: 0, settings: 0 })
  const switchView = (view: "library" | "settings", openLibrarySettings = false) => {
    if (openLibrarySettings) setLibrarySettingsRequest(value => value + 1)
    if (view === activeView) return
    pageScroll.current[activeView] = window.scrollY
    if (view === "settings") setSettingsVisited(true)
    setActiveView(view)
  }
  // Runs after the DOM swap but before paint, so there's no jump.
  useLayoutEffect(() => {
    window.scrollTo({ top: pageScroll.current[activeView], behavior: "instant" })
  }, [activeView])

  const scanState: ScanState = { isScanning, scanProgress, lastScanResult, onScan: handleScan, onFolderScan: handleFolderScan }

  return (
    <AuthGate>
      <div className="min-h-screen bg-background">
        <Header activeView={activeView} onViewChange={view => switchView(view)} isScanning={isScanning} />

        <main className="mx-auto max-w-[1800px] px-4 pb-6 pt-4 sm:px-6">
          {/* Cross-view scan banner — visible whenever a scan runs outside the library view */}
          {isScanning && activeView !== "library" && (
            <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span>
                {scanProgress && scanProgress.total > 0
                  ? `Scanning library: ${scanProgress.scanned.toLocaleString()} / ${scanProgress.total.toLocaleString()} files…`
                  : 'Scanning library…'}
              </span>
            </div>
          )}

          {/* The library stays mounted while Settings is open, so the media type,
              filters, search, expanded shows/seasons and scroll position are all
              where you left them when you come back. */}
          <div hidden={activeView !== "library"}>
            <MediaLibraryTab active={activeView === "library"} scan={scanState} onOpenPosterSettings={() => switchView("settings", true)} />
          </div>
          {settingsVisited && <div hidden={activeView !== "settings"}><SettingsTab libraryRequest={librarySettingsRequest} /></div>}
        </main>
        <Toaster position="bottom-right" theme="dark" />
      </div>
    </AuthGate>
  )
}
