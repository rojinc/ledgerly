import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

/** The rendered text's container. */
function show(text: string): HTMLElement {
  return render(<Markdown text={text} />).container
}

/** Its HTML without the classes, so a test reads the structure. */
const plain = (container: HTMLElement) => container.innerHTML.replace(/ class="[^"]*"/g, '')

describe('Markdown (#566)', () => {
  afterEach(cleanup)

  it('makes the first # the page’s one h1, and ## and ### h2 and h3', () => {
    expect(plain(show('# One\n## Two\n### Three\n#### Four'))).toBe(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><p>#### Four</p>',
    )
  })

  it('keeps one h1 whatever the file holds: a later # is an h2', () => {
    expect(plain(show('Intro\n\n# First\n\n# Second'))).toBe(
      '<p>Intro</p><h1>First</h1><h2>Second</h2>',
    )
  })

  it('joins a paragraph’s lines, and starts a new one after a blank line', () => {
    expect(plain(show('First line\nsecond line\n\n  Next  \n'))).toBe(
      '<p>First line second line</p><p>Next</p>',
    )
  })

  it('makes lists of - and 1. lines, a new list when the kind changes', () => {
    expect(plain(show('- a\n- b\n1. c\n2. d\nAfter\n\n- e'))).toBe(
      '<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol><p>After</p><ul><li>e</li></ul>',
    )
  })

  it('makes **bold**, and links to https: and mailto: only', () => {
    expect(
      plain(
        show(
          'A **bold** word, [our site](https://example.com/a) and [mail](mailto:help@example.com).',
        ),
      ),
    ).toBe(
      '<p>A <strong>bold</strong> word, <a href="https://example.com/a">our site</a> and <a href="mailto:help@example.com">mail</a>.</p>',
    )
  })

  it('shows any other link, and any HTML, as the text it is', () => {
    const links = [
      '[a](javascript:alert(1))',
      '[b](JAVASCRIPT:alert(1))',
      '[c](JaVaScRiPt:alert(1))',
      '[d](  javascript:alert(1))',
      '[e](data:text/html,<b>hi</b>)',
      '[f](//example.com)',
      '[g](http://example.com)',
      '[h](https:)',
    ].join(' ')
    const html = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    const container = show(`${links}\n\n${html}`)
    expect(container.querySelector('a, script, img, b')).toBeNull()
    expect(container.textContent).toBe(`${links}${html}`)
  })

  it('renders nothing for no text', () => {
    expect(show('\n\n').innerHTML).toBe('')
  })
})
