import { Film } from "lucide-react"

export function Header() {
  return (
    <header className="mb-8 text-center">
      <div className="mb-3 flex items-center justify-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
          <Film className="h-5 w-5 text-accent" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Media Monitor
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Automated media library management and transcoding
      </p>
    </header>
  )
}
