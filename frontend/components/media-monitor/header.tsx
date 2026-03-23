export function Header() {
  return (
    <header className="mb-8 text-center">
      <div className="mb-3 flex items-center justify-center gap-3">
        <img src="/icon.svg" alt="Media Monitor" className="h-10 w-10 rounded-lg" />
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
