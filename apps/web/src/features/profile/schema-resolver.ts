import { type FieldErrors, type FieldValues, get, type Resolver, set } from 'react-hook-form'
import type { z } from 'zod'

function message(issue: z.core.$ZodIssue): string {
  if (issue.code === 'too_small' && issue.minimum === 1) return 'Required'
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return `At most ${issue.maximum} characters`
  }
  // `Expected 6–6 digits` from core's digits() reads better as `Expected 6 digits`.
  return issue.message.replace(/(\d+)–\1 /, '$1 ')
}

/**
 * Validates with the function's own zod schema (conventions.md#react). `toBody`
 * turns the form's strings into the request body first, e.g. dropping empty fields.
 */
export function schemaResolver<TValues extends FieldValues, TBody>(
  schema: z.ZodType<TBody>,
  toBody: (values: TValues) => unknown,
): Resolver<TValues, unknown, TBody> {
  return (values) => {
    const result = schema.safeParse(toBody(values))
    if (result.success) return { values: result.data, errors: {} }
    const errors: FieldErrors<TValues> = {}
    for (const issue of result.error.issues) {
      const path = issue.path.join('.')
      if (!get(errors, path)) set(errors, path, { type: issue.code, message: message(issue) })
    }
    return { values: {}, errors }
  }
}
