"use client"

import { useState } from "react"
import { Header } from "@/components/media-monitor/header"
import { TabNav } from "@/components/media-monitor/tab-nav"
import { DashboardTab } from "@/components/media-monitor/dashboard-tab"
import { MediaLibraryTab } from "@/components/media-monitor/media-library-tab"
import { Toaster } from "@/components/ui/sonner"

export default function MediaMonitor() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "media">("dashboard")

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Header />
        <TabNav activeTab={activeTab} onTabChange={setActiveTab} />
        
        {activeTab === "dashboard" && <DashboardTab />}
        {activeTab === "media" && <MediaLibraryTab />}
      </div>
      <Toaster position="top-right" theme="dark" />
    </div>
  )
}
