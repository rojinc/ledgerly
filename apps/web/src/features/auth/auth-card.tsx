import type { ReactNode } from 'react'

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground">Ledgerly</p>
        <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
      </div>
      {children}
    </main>
  )
}

/** A ref that focuses its element once it's on the page: for a message that replaces a form. */
export function focusOnMount(element: HTMLElement | null) {
  element?.focus()
}
