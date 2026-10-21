import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { check, extractLinks, headingSlugs, slug } from './check-links.mjs'

describe('slug', () => {
  it('drops punctuation', () => {
    assert.equal(slug('Rule 1.2 (draft) / v2: why?'), 'rule-12-draft--v2-why')
  })

  it('drops backticks and *', () => {
    assert.equal(slug('The `allocate()` *helper*'), 'the-allocate-helper')
  })

  it('keeps underscores', () => {
    assert.equal(slug('`due_on` field'), 'due_on-field')
  })

  it('keeps non-ASCII letters', () => {
    assert.equal(slug('Café'), 'café')
  })

  it('turns each space into a hyphen', () => {
    assert.equal(slug('a  b c'), 'a--b-c')
  })

  it('lower-cases', () => {
    assert.equal(slug('GitHub API'), 'github-api')
  })
})

describe('headingSlugs', () => {
  it('numbers a repeated heading', () => {
    assert.deepEqual(headingSlugs('# Notes\n## Notes\n### Notes\n'), [
      'notes',
      'notes-1',
      'notes-2',
    ])
  })

  it('ignores headings in fenced code', () => {
    assert.deepEqual(headingSlugs('# Real\n```md\n# Fake\n```\n~~~\n## Fake too\n~~~\n'), ['real'])
  })

  it('takes only the text of a link', () => {
    assert.deepEqual(headingSlugs('## See [the guide](guide.md#top)\n'), ['see-the-guide'])
  })

  it('strips closing #s', () => {
    assert.deepEqual(headingSlugs('## Closing ##\n'), ['closing'])
  })

  it('takes only 1 to 6 #s followed by a space', () => {
    assert.deepEqual(headingSlugs('#tag\n####### Seven\n###### Six\n'), ['six'])
  })
})

describe('extractLinks', () => {
  it('finds links and images with their 1-based lines', () => {
    assert.deepEqual(extractLinks('Intro\n\n[a](a.md) and ![b](b.png)\n[c](c.md#x)\n'), [
      { target: 'a.md', line: 3 },
      { target: 'b.png', line: 3 },
      { target: 'c.md#x', line: 4 },
    ])
  })

  it('skips links in fenced code', () => {
    // A fence closes only on the same character, at least as long, with nothing after it. One in
    // a list item may be indented further.
    const markdown = [
      '````md',
      '```',
      '[a](a.md)',
      '```` still code',
      '[b](b.md)',
      '````',
      '~~~',
      '```',
      '[c](c.md)',
      '~~~',
      '- step',
      '    ```bash',
      '    [d](d.md)',
      '    ```',
      '[e](e.md)',
    ].join('\n')
    assert.deepEqual(extractLinks(markdown), [{ target: 'e.md', line: 15 }])
  })

  it('skips links in inline code', () => {
    assert.deepEqual(extractLinks('`[a](a.md)` ``[b](b.md) ` x`` [`c`](c.md)'), [
      { target: 'c.md', line: 1 },
    ])
  })

  it('skips external links', () => {
    assert.deepEqual(
      extractLinks('[a](https://example.com/a.md) [b](mailto:a@example.com) [c](c.md)'),
      [{ target: 'c.md', line: 1 }],
    )
  })

  it('keeps only the target of a link with a title', () => {
    assert.deepEqual(extractLinks('[a](a.md "A") [b](b.md#x \'B\')'), [
      { target: 'a.md', line: 1 },
      { target: 'b.md#x', line: 1 },
    ])
  })
})

describe('check', () => {
  let dir

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-links-'))
    mkdirSync(join(dir, 'docs'))
    mkdirSync(join(dir, 'notes'))
    const files = {
      'guide.md': '# Guide\n\n## Café au lait\n',
      'a b.md': '# Space name\n',
      'data.json': '{}\n',
      'same.md': '# Intro\n\nBack to [the intro](#intro).\n',
      'folder.md': 'See [docs](docs) and [docs/](docs/).\n',
      'notes/missing-file.md': '[guide](../guide.md)\n\n[gone](gone.md#x)\n',
      'missing-anchor.md':
        '# Intro\n[a](#nope)\n[b](guide.md#nope)\n[c](guide.md#guide)\n[d](guide.md#Guide)\n',
      'non-md.md': '[data](data.json#anything)\n',
      'encoded.md': '[a](a%20b.md#space-name) [b](guide.md#caf%C3%A9-au-lait)\n',
    }
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  })

  after(() => rmSync(dir, { recursive: true, force: true }))

  it('passes a same-file anchor that exists', () => {
    assert.deepEqual(check(dir, ['same.md']), { links: 1, problems: [] })
  })

  it('passes a folder', () => {
    assert.deepEqual(check(dir, ['folder.md']), { links: 2, problems: [] })
  })

  it('reports a missing file, relative to the linking file', () => {
    assert.deepEqual(check(dir, ['notes/missing-file.md']), {
      links: 2,
      problems: ['notes/missing-file.md:3: gone.md#x: missing file'],
    })
  })

  it('reports a missing anchor', () => {
    assert.deepEqual(check(dir, ['missing-anchor.md']), {
      links: 4,
      problems: [
        'missing-anchor.md:2: #nope: missing anchor',
        'missing-anchor.md:3: guide.md#nope: missing anchor',
        'missing-anchor.md:5: guide.md#Guide: missing anchor',
      ],
    })
  })

  it("doesn't check an anchor on a file that isn't Markdown", () => {
    assert.deepEqual(check(dir, ['non-md.md']), { links: 1, problems: [] })
  })

  it('decodes a URL-encoded target', () => {
    assert.deepEqual(check(dir, ['encoded.md']), { links: 2, problems: [] })
  })
})
