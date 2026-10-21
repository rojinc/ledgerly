import type { ReactNode } from 'react'

/**
 * The privacy policy's and terms' Markdown, as React elements (#566): a fixed subset, with no
 * dependency and never raw HTML. Headings `#`, `##` and `###`, the file's first `#` being the
 * page's one h1 and any other an h2; paragraphs, `-` and `1.` lists, `**bold**`, and links whose
 * URL parses with an `https:` or `mailto:` protocol. Anything else, a `javascript:` link or a
 * `<script>` tag included, shows as the text it is.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text).map(render)}</>
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

const HEADING = /^(#{1,3}) (.+)$/
const UNORDERED = /^- (.+)$/
const ORDERED = /^\d+\. (.+)$/

/** The text's blocks: a blank line ends a paragraph or a list; a heading is one line. */
function blocks(text: string): Block[] {
  const out: Block[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const last = out.at(-1)
    const heading = HEADING.exec(line)
    const item = UNORDERED.exec(line) ?? ORDERED.exec(line)
    if (line === '') {
      out.push({ kind: 'paragraph', text: '' })
    } else if (heading) {
      out.push({
        kind: 'heading',
        level: (heading[1] as string).length as 1 | 2 | 3,
        text: heading[2] as string,
      })
    } else if (item) {
      const ordered = /^\d/.test(line)
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item[1] as string)
      else out.push({ kind: 'list', ordered, items: [item[1] as string] })
    } else if (last?.kind === 'paragraph' && last.text !== '') {
      last.text = `${last.text} ${line}`
    } else {
      out.push({ kind: 'paragraph', text: line })
    }
  }
  return out.filter((block) => block.kind !== 'paragraph' || block.text !== '')
}

function render(block: Block, index: number, all: Block[]): ReactNode {
  if (block.kind === 'heading') {
    // One h1 per page (conventions.md), whatever the file holds: its first `#` heading.
    const first = all.findIndex((other) => other.kind === 'heading' && other.level === 1)
    const Tag =
      block.level === 1 ? (index === first ? 'h1' : 'h2') : block.level === 2 ? 'h2' : 'h3'
    const size = { h1: 'text-2xl', h2: 'text-xl', h3: 'text-lg' }[Tag]
    return (
      <Tag key={index} className={`${size} font-semibold`}>
        {inline(block.text)}
      </Tag>
    )
  }
  if (block.kind === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
      <Tag key={index} className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-6`}>
        {block.items.map((item, at) => (
          // The list never changes order: its text is the file's.
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list
          <li key={at}>{inline(item)}</li>
        ))}
      </Tag>
    )
  }
  return <p key={index}>{inline(block.text)}</p>
}

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** Whether a link's URL parses, with an `https:` or `mailto:` protocol: never a prefix match. */
function safe(href: string): boolean {
  try {
    return ['https:', 'mailto:'].includes(new URL(href).protocol)
  } catch {
    return false
  }
}

/** `**bold**` and safe links in a line of text; any other characters stay text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const match of text.matchAll(INLINE)) {
    const [whole, bold, label, href] = match
    out.push(text.slice(at, match.index))
    if (bold !== undefined) {
      out.push(<strong key={match.index}>{bold}</strong>)
    } else if (href !== undefined && safe(href)) {
      out.push(
        <a key={match.index} href={href} className="underline underline-offset-4">
          {label}
        </a>,
      )
    } else {
      out.push(whole)
    }
    at = match.index + whole.length
  }
  out.push(text.slice(at))
  return out.filter((part) => part !== '')
}
