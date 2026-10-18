import type { ComponentProps } from 'react'
import { cn } from '../lib/utils'

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />
}
