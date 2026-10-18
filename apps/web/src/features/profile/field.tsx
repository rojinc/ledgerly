import type { ComponentProps, ReactNode } from 'react'
import type { FieldError } from 'react-hook-form'
import { cn } from '../../lib/utils'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'

type FieldProps = {
  id: string
  label: string
  hint?: string
  error?: FieldError
  children: (aria: {
    id: string
    'aria-invalid': boolean
    'aria-describedby'?: string
  }) => ReactNode
}

/** A label, the control, an optional hint and the inline error, wired for screen readers. */
export function Field({ id, label, hint, error, children }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy || undefined,
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </div>
  )
}

export function TextField({
  label,
  hint,
  error,
  ...props
}: Omit<FieldProps, 'children'> & ComponentProps<'input'>) {
  return (
    <Field id={props.id} label={label} hint={hint} error={error}>
      {(aria) => <Input {...props} {...aria} />}
    </Field>
  )
}

export function SelectField({
  label,
  hint,
  error,
  className,
  ...props
}: Omit<FieldProps, 'children'> & ComponentProps<'select'>) {
  return (
    <Field id={props.id} label={label} hint={hint} error={error}>
      {(aria) => (
        <select
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive',
            className,
          )}
          {...props}
          {...aria}
        />
      )}
    </Field>
  )
}
