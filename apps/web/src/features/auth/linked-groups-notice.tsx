import { useState } from 'react'
import { Button } from '../../ui/button'
import { useBootstrap } from './use-bootstrap'
import { useCurrentUser } from './use-current-user'

/**
 * After bootstrap: tells the user about groups others had already added them to. In AppLayout,
 * after the skip link and in the column the side menu pads (#570's W33).
 */
export function LinkedGroupsNotice() {
  const userId = useCurrentUser().data?.$id ?? ''
  const count = useBootstrap(userId).data?.linkedGroupIds.length ?? 0
  const [dismissed, setDismissed] = useState(false)
  if (count === 0 || dismissed) return null
  return (
    <div role="status" className="border-b border-border bg-muted px-4 py-3 text-sm">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <span className="flex-1">
          We found {count} {count === 1 ? 'group' : 'groups'} you were added to.
        </span>
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setDismissed(true)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
