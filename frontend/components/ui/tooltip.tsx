'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground border border-border/70 shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit max-w-[min(360px,calc(100vw-24px))] origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-2 text-xs leading-relaxed break-words',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }

// ── Hint: lightweight tooltips for large lists ────────────────────────────────
// A full Radix Tooltip per hint costs several component layers each, and the
// media table renders thousands of hints. Instead, Hint only attaches hover/
// focus handlers to its child, and one shared <HintLayer> (mounted once in the
// root layout) shows a real Radix tooltip anchored to a fixed-position proxy
// over the hovered element. The child is never wrapped or remounted, so focus
// and clicks are unaffected. Timing mirrors TooltipProvider's defaults.

const HINT_DELAY_MS = 300
const HINT_SKIP_DELAY_MS = 300
const HINT_DESCRIPTION_ID = "app-hint-description"

type HintSide = React.ComponentProps<typeof TooltipPrimitive.Content>["side"]

interface ActiveHint {
  owner: number
  element: HTMLElement
  rect: DOMRect
  content: React.ReactNode
  side?: HintSide
  className?: string
}

const hintStore = {
  active: null as ActiveHint | null,
  lastClosedAt: 0,
  listeners: new Set<() => void>(),
  set(next: ActiveHint | null) {
    const previous = this.active
    if (previous === next) return
    if (previous && !next) this.lastClosedAt = performance.now()
    if (previous && previous.element !== next?.element) previous.element.removeAttribute("aria-describedby")
    if (next) next.element.setAttribute("aria-describedby", HINT_DESCRIPTION_ID)
    this.active = next
    this.listeners.forEach(listener => listener())
  },
  close(owner?: number) {
    if (this.active && (owner === undefined || this.active.owner === owner)) this.set(null)
  },
  subscribe(listener: () => void) {
    hintStore.listeners.add(listener)
    return () => { hintStore.listeners.delete(listener) }
  },
}

let nextHintOwner = 1

type HintChildProps = {
  onPointerEnter?: React.PointerEventHandler<HTMLElement>
  onPointerLeave?: React.PointerEventHandler<HTMLElement>
  onPointerDown?: React.PointerEventHandler<HTMLElement>
  onFocus?: React.FocusEventHandler<HTMLElement>
  onBlur?: React.FocusEventHandler<HTMLElement>
}

export function Hint({ children, content, side, className }: {
  children: React.ReactElement
  content: React.ReactNode
  side?: HintSide
  className?: string
}) {
  const owner = React.useRef(0)
  if (!owner.current) owner.current = nextHintOwner++
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerDown = React.useRef(false)
  const latest = React.useRef({ content, side, className })
  latest.current = { content, side, className }

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const show = (element: HTMLElement, immediate: boolean) => {
    cancel()
    const open = () => {
      if (!element.isConnected) return
      hintStore.set({ owner: owner.current, element, rect: element.getBoundingClientRect(), ...latest.current })
    }
    const warm = hintStore.active !== null || performance.now() - hintStore.lastClosedAt < HINT_SKIP_DELAY_MS
    if (immediate || warm) open()
    else timer.current = setTimeout(open, HINT_DELAY_MS)
  }
  const hide = () => {
    cancel()
    hintStore.close(owner.current)
  }

  // Close if the hovered element unmounts (e.g. a row filtered away mid-hover).
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    hintStore.close(owner.current)
  }, [])

  const own = children.props as HintChildProps
  return React.cloneElement(children as React.ReactElement<HintChildProps>, {
    onPointerEnter: event => {
      own.onPointerEnter?.(event)
      if (event.pointerType !== "touch") show(event.currentTarget, false)
    },
    onPointerLeave: event => {
      own.onPointerLeave?.(event)
      hide()
    },
    onPointerDown: event => {
      own.onPointerDown?.(event)
      pointerDown.current = true
      document.addEventListener("pointerup", () => { pointerDown.current = false }, { once: true })
      hide()
    },
    onFocus: event => {
      own.onFocus?.(event)
      // Like Radix: a click focuses the element but shouldn't pop its hint.
      if (!pointerDown.current) show(event.currentTarget, true)
    },
    onBlur: event => {
      own.onBlur?.(event)
      hide()
    },
  })
}

/** The single tooltip instance behind every <Hint>. Mount once near the root. */
export function HintLayer() {
  const active = React.useSyncExternalStore(
    hintStore.subscribe,
    () => hintStore.active,
    () => null,
  )

  // The proxy is positioned once, so close rather than drift when anything scrolls.
  React.useEffect(() => {
    if (!active) return
    const close = () => hintStore.close()
    window.addEventListener("scroll", close, { capture: true, passive: true })
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, { capture: true })
      window.removeEventListener("resize", close)
    }
  }, [active])

  if (!active) return null
  const { rect } = active
  return (
    <>
      <div id={HINT_DESCRIPTION_ID} hidden>{active.content}</div>
      <TooltipPrimitive.Provider delayDuration={0}>
        <TooltipPrimitive.Root key={active.owner} open onOpenChange={open => { if (!open) hintStore.close() }}>
          <TooltipPrimitive.Trigger asChild>
            <span
              aria-hidden
              tabIndex={-1}
              style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none" }}
            />
          </TooltipPrimitive.Trigger>
          <TooltipContent side={active.side} className={active.className}>
            {active.content}
          </TooltipContent>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    </>
  )
}
