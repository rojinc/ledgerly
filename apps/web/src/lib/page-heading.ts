import type { createBrowserRouter } from 'react-router'

type Router = Pick<ReturnType<typeof createBrowserRouter>, 'state' | 'subscribe'>

/**
 * The page a location shows: its path, and on Bills its group too, since `/bills` and
 * `/bills?groupId=` are two pages (#556). Any other query (a calendar month, a filter) isn't.
 */
function pageOf({ pathname, search }: { pathname: string; search?: string }): string {
  if (!pathname.startsWith('/bills')) return pathname
  return `${pathname}?${new URLSearchParams(search).get('groupId') ?? ''}`
}

/**
 * Names the tab after the page's one h1 ("History · Ledgerly"), or its `data-title` where the h1
 * greets rather than names the page. Once the router moves to another page, it focuses that h1,
 * so a screen reader says where it went (#539). A query change (a calendar month, a filter) stays
 * on the same page, but for Bills' group (pageOf). Focus the page or the person moved meanwhile
 * stays where it is. An h1 shown while the page loads hands the focus on to the loaded page's.
 * Returns a function that stops it.
 */
export function followPageHeading(router: Router, root: HTMLElement): () => void {
  let page = pageOf(router.state.location)
  // Where focus was when the page changed, until the new page's h1 is there.
  let from: Element | null | undefined
  // The old page's h1, and its text, when the page changed. The router renders the move in a
  // transition, so the old page can render again first (a form after its save), and that h1 isn't
  // the new page's. A route that keeps the same component keeps the node, with new text.
  let stale: { h1: Element | null; text: string | null } | undefined
  // The h1 the move focused. A page can show an h1 while it loads and then swap it for the loaded
  // page's, which takes the focus on with it while it's still on nothing (#556).
  let focused: Element | undefined
  const focus = (h1: HTMLElement) => {
    // Focusable only from here, so it's no Tab stop.
    if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1
    h1.focus()
    focused = h1
  }
  const update = () => {
    const h1 = root.querySelector('h1')
    const title = (h1?.dataset.title ?? h1?.textContent)?.trim()
    document.title = title ? `${title} · Ledgerly` : 'Ledgerly'
    if (!h1) return
    const active = document.activeElement
    if (focused && h1 !== focused && !focused.isConnected) {
      if (active === document.body || active === null) focus(h1)
      else focused = undefined
      return
    }
    if (from === undefined) return
    if (h1 === stale?.h1 && h1.textContent === stale.text) return
    if (active === from || active === document.body || active === null) focus(h1)
    from = undefined
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const unsubscribe = router.subscribe((state) => {
    if (pageOf(state.location) === page) return
    page = pageOf(state.location)
    from = document.activeElement
    focused = undefined
    const old = root.querySelector('h1')
    stale = { h1: old, text: old?.textContent ?? null }
  })
  update()
  return () => {
    observer.disconnect()
    unsubscribe()
  }
}
