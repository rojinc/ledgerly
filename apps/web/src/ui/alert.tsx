import type { ComponentProps } from 'react'
import { cn } from '../lib/utils'

export function Alert({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border px-4 py-3 text-sm',
        variant === 'destructive' ? 'border-destructive/50 text-destructive' : 'border-border',
        className,
      )}
      {...props}
    />
  )
}
