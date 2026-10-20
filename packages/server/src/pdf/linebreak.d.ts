// `linebreak` ships no types. Only what divide-pdf.ts uses.
declare module 'linebreak' {
  /** UAX #14 line breaking, as pdfmake splits text into words with it. */
  export default class LineBreaker {
    constructor(text: string)
    nextBreak(): { position: number; required: boolean } | null
  }
}
