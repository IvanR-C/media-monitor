"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * Subscribe to a CSS media query. `serverValue` is what the static export
 * prerenders with (and what hydration starts from) before the real match is read.
 */
export function useMediaQuery(query: string, serverValue = true) {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  )
}
