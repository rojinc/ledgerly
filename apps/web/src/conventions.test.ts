import { describe, expect, it } from 'vitest'

// The app's own source, as text: rules of conventions.md that no rendered test can see, since
// jsdom loads no Tailwind.
const sources = import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('conventions.md, in the source', () => {
  it('reads the app’s components', () => {
    expect(Object.keys(sources)).toContain('./app-layout.tsx')
    expect(Object.keys(sources).some((path) => path.endsWith('.test.tsx'))).toBe(false)
  })

  // display: none takes an empty status out of the accessibility tree, so its text would arrive
  // as a new region, which often isn't read out: empty:sr-only keeps it there (#539).
  it('hides no empty status with empty:hidden', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => source.includes('empty:hidden'))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
