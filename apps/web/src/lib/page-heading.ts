import type { createBrowserRouter } from 'react-router'

type Router = Pick<ReturnType<typeof createBrowserRouter>, 'state' | 'subscribe'>

/**
 * Names the tab after the page's one h1 ("History · Ledgerly"), or its `data-title` where the h1
 * greets rather than names the page, and once the router moves to
 * another page, focuses that h1, so a screen reader says where it went (#539). A query change (a
 * calendar month, a filter) stays on the same page. Focus the page or the person moved meanwhile
 * stays where it is. Returns a function that stops it.
 */
export function followPageHeading(router: Router, root: HTMLElement): () => void {
  let pathname = router.state.location.pathname
  // Where focus was when the page changed, until the new page's h1 is there.
  let from: Element | null | undefined
  const update = () => {
    const h1 = root.querySelector('h1')
    const title = (h1?.dataset.title ?? h1?.textContent)?.trim()
    document.title = title ? `${title} · Ledgerly` : 'Ledgerly'
    if (from === undefined || !h1) return
    const active = document.activeElement
    if (active === from || active === document.body || active === null) {
      // Focusable only from here, so it's no Tab stop.
      if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1
      h1.focus()
    }
    from = undefined
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const unsubscribe = router.subscribe((state) => {
    if (state.location.pathname === pathname) return
    pathname = state.location.pathname
    from = document.activeElement
  })
  update()
  return () => {
    observer.disconnect()
    unsubscribe()
  }
}
