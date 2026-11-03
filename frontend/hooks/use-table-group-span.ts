"use client"

import { useEffect, useState } from "react"

/** Match the table's visible columns so grouped rows cannot create phantom columns. */
export function useTableGroupSpan() {
  const [span, setSpan] = useState(8)
  useEffect(() => {
    const queries = [768, 1024, 1280, 1536].map(width => window.matchMedia(`(min-width: ${width}px)`))
    const update = () => setSpan(3 + Number(queries[0].matches) + Number(queries[1].matches)
      + 2 * Number(queries[2].matches) + Number(queries[3].matches))
    update()
    queries.forEach(query => query.addEventListener("change", update))
    return () => queries.forEach(query => query.removeEventListener("change", update))
  }, [])
  return span
}
