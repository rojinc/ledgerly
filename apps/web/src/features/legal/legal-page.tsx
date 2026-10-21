import { Link } from 'react-router'
import { Markdown } from './markdown'
import privacy from './privacy.md?raw'
import terms from './terms.md?raw'

/**
 * A legal page, signed in or out (#566): the Markdown file's text, which the owner and the lawyer
 * change without touching code (#54). The file's `#` heading is the page's h1, and its next line
 * the version and date. No app menu: a link back instead.
 */
function LegalPage({ text }: { text: string }) {
  return (
    <main className="mx-auto flex w-full max-w-prose flex-col gap-4 px-4 py-10">
      <Link to="/" className="self-start text-sm underline underline-offset-4">
        Back to Ledgerly
      </Link>
      <Markdown text={text} />
    </main>
  )
}

/** `/privacy` */
export function PrivacyPage() {
  return <LegalPage text={privacy} />
}

/** `/terms` */
export function TermsPage() {
  return <LegalPage text={terms} />
}
