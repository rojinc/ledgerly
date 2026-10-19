import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/**
 * Shows a panel in place of the button that opened it, with focus on the panel's heading, and
 * puts focus back on the button when it closes: the focused element unmounts either way.
 */
export function useSwap() {
  const [opened, setOpened] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  return {
    opened,
    trigger,
    heading,
    open: () => {
      flushSync(() => setOpened(true))
      heading.current?.focus()
    },
    close: () => {
      flushSync(() => setOpened(false))
      trigger.current?.focus()
    },
  }
}
