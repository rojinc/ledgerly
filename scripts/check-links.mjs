// Checks every relative link and image in the tracked Markdown files: the file or folder must
// exist, and an anchor into a Markdown file must match one of its headings, by GitHub's rules.
// External links aren't checked. Usage: node scripts/check-links.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// A code span: a run of backticks, closed by a run of the same length.
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g

// The anchor GitHub gives a heading (github-slugger): lower-case, keep letters, numbers, spaces,
// `-` and `_`, and one hyphen for each space.
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replaceAll(' ', '-')
}

// The anchors of a file's headings. A repeated one gets -1, then -2 and so on.
export function headingSlugs(markdown) {
  const counts = new Map()
  for (const { text } of proseLines(markdown)) {
    const heading = text.match(/^ {0,3}#{1,6}(?:[ \t](.*))?$/)
    if (!heading) continue
    const base = slug(
      (heading[1] ?? '')
        .replace(/#+\s*$/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    let anchor = base
    while (counts.has(anchor)) {
      counts.set(base, counts.get(base) + 1)
      anchor = `${base}-${counts.get(base)}`
    }
    counts.set(anchor, 0)
  }
  return [...counts.keys()]
}

// The links and images with no URL scheme, outside code, with their 1-based line numbers.
export function extractLinks(markdown) {
  const links = []
  for (const { text, line } of proseLines(markdown)) {
    for (const [, inside] of text.replace(CODE_SPAN, '').matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
      // A title may follow the target: [a](b "t").
      const target = inside.trim().split(' ')[0]
      if (!/^[a-z][a-z\d+.-]*:/i.test(target)) links.push({ target, line })
    }
  }
  return links
}

// Every broken link in files (paths relative to root), one `path:line: target: why` each.
export function check(root, files) {
  const anchors = new Map()
  const problems = []
  let links = 0
  for (const file of files) {
    for (const { target, line } of extractLinks(readFileSync(join(root, file), 'utf8'))) {
      links++
      const [, path, anchor] = target.match(/^([^#]*)(?:#(.*))?$/)
      const to = path ? join(root, dirname(file), decodeURIComponent(path)) : join(root, file)
      if (!existsSync(to)) {
        problems.push(`${file}:${line}: ${target}: missing file`)
      } else if (anchor && (!path || path.endsWith('.md'))) {
        if (!anchors.has(to)) anchors.set(to, headingSlugs(readFileSync(to, 'utf8')))
        if (!anchors.get(to).includes(decodeURIComponent(anchor))) {
          problems.push(`${file}:${line}: ${target}: missing anchor`)
        }
      }
    }
  }
  return { links, problems }
}

// The lines outside fenced code blocks. A fence closes on the same character, at least as long.
function proseLines(markdown) {
  const lines = []
  let fence = ''
  for (const [i, text] of markdown.split(/\r?\n/).entries()) {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (!fence && marker) {
      fence = marker[1]
    } else if (fence) {
      const closes = marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
      if (closes && !marker[2].trim()) fence = ''
    } else {
      lines.push({ text, line: i + 1 })
    }
  }
  return lines
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const { links, problems } = check(root, files)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log(`Checked ${links} links in ${files.length} files.`)
}
