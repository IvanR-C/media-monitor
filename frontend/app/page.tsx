"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Header } from "@/components/media-monitor/header"
import { TabNav } from "@/components/media-monitor/tab-nav"
import { DashboardTab } from "@/components/media-monitor/dashboard-tab"
import { MediaLibraryTab } from "@/components/media-monitor/media-library-tab"
import { Toaster } from "@/components/ui/sonner"

export type ScanState = {
  isScanning: boolean
  scanProgress?: { scanned: number; total: number }
  lastScanResult?: { scanned: number; total: number }
  onScan: () => void
}

export default function MediaMonitor() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "media">("dashboard")

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

  const scanState: ScanState = { isScanning, scanProgress, lastScanResult, onScan: handleScan }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6">
        <Header />
        <TabNav activeTab={activeTab} onTabChange={setActiveTab} isScanning={isScanning} />

        {/* Cross-tab scan banner — visible whenever a scan runs outside the media tab */}
        {isScanning && activeTab !== "media" && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            <span>
              {scanProgress && scanProgress.total > 0
                ? `Scanning library: ${scanProgress.scanned.toLocaleString()} / ${scanProgress.total.toLocaleString()} files…`
                : 'Scanning library…'}
            </span>
          </div>
        )}

        {activeTab === "dashboard" && <DashboardTab />}
        {activeTab === "media"     && <MediaLibraryTab scan={scanState} />}
      </div>
      <Toaster position="top-right" theme="dark" />
    </div>
  )
}
