import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { storage } from '../../lib/appwrite'
import { prepareReceipt } from './prepare-receipt'
import { ReceiptsSection } from './receipts-section'

vi.mock('../../lib/appwrite', () => ({
  client: { config: { project: 'ledgerly-test' } },
  storage: {
    createFile: vi.fn(),
    getFile: vi.fn(),
    getFilePreview: vi.fn(),
    getFileDownload: vi.fn(),
  },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
let mockVerified = true
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: { $id: 'u1', emailVerification: mockVerified } }),
}))
// The browser work has its own tests.
vi.mock('./prepare-receipt', () => ({ prepareReceipt: vi.fn() }))

const call = vi.mocked(callFunction)
const createFile = vi.mocked(storage.createFile)
const getFile = vi.mocked(storage.getFile)
const prepare = vi.mocked(prepareReceipt)

const house = { $id: 'house1', type: 'house' } as Groups

function row(receiptFileIds: string[] = []): Transactions {
  return { $id: 't1', groupId: 'house1', receiptFileIds } as unknown as Transactions
}

function renderSection(transaction: Transactions, mayChange = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The row comes from the cache, as on the transaction page, so its updates show.
  function Page() {
    const current = useQuery({
      queryKey: ['transaction', 't1'],
      queryFn: async () => transaction,
      initialData: transaction,
      staleTime: Number.POSITIVE_INFINITY,
    }).data
    return <ReceiptsSection row={current} group={house} mayChange={mayChange} />
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  )
  return { queryClient }
}
const fetches: string[] = []
let previewType = 'image/webp'
beforeEach(() => {
  mockVerified = true
  previewType = 'image/webp'
  fetches.length = 0
  localStorage.setItem('cookieFallback', '{"a_session":"s"}')
  // The SDK's methods are overloaded; the object form is the one used.
  type FileParams = { fileId: string; width?: number; output?: string }
  vi.mocked(storage.getFilePreview).mockImplementation(
    ((params: FileParams) =>
      `https://store/${params.fileId}/preview?width=${params.width}&output=${params.output}`) as never,
  )
  vi.mocked(storage.getFileDownload).mockImplementation(
    ((params: FileParams) => `https://store/${params.fileId}/download`) as never,
  )
  getFile.mockImplementation((async ({ fileId }: { fileId: string }) => ({
    $id: fileId,
    mimeType: fileId.startsWith('pdf') ? 'application/pdf' : 'image/webp',
  })) as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      fetches.push(`${url} ${JSON.stringify(init.headers)} ${init.credentials}`)
      // Appwrite's preview is the format asked for; a download is the file as stored.
      const type = url.includes('/preview') ? previewType : 'application/pdf'
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': type },
      })
    }),
  )
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  localStorage.clear()
})

const picked = new File(['x'], 'IMG_0042.JPG', { type: 'image/jpeg' })
const ready = new File(['webp'], 'receipt.webp', { type: 'image/webp' })

function pick(file = picked) {
  fireEvent.change(screen.getByLabelText('Add a receipt (photo or PDF)'), {
    target: { files: [file] },
  })
}

function view(receiptFileIds: string[]) {
  return { ok: true as const, data: { transaction: row(receiptFileIds), shares: [] } }
}

describe('ReceiptsSection', () => {
  it('shows photos as previews in order, fetched with the session, and opens one larger', async () => {
    renderSection(row(['img1', 'img2']))
    const first = await screen.findByRole('img', { name: 'Receipt 1 of 2' })
    expect(await screen.findByRole('img', { name: 'Receipt 2 of 2' })).toBeTruthy()
    expect(first.getAttribute('src')).toMatch(/^blob:/)
    // Fetched, not linked: Safari sends no third-party cookie on an <img>.
    expect(fetches[0]).toBe(
      'https://store/img1/preview?width=320&output=webp {"X-Appwrite-Project":"ledgerly-test","X-Fallback-Cookies":"{\\"a_session\\":\\"s\\"}"} include',
    )
    fireEvent.click(first.closest('button') as HTMLElement)
    const dialog = screen.getByRole('dialog', { name: 'Receipt 1 of 2' })
    await waitFor(() =>
      expect(fetches.some((f) => f.includes('img1/preview?width=1600&output=webp'))).toBe(true),
    )
    expect(await within(dialog).findByRole('img', { name: 'Receipt 1 of 2' })).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(first.closest('button'))
  })

  it('offers a PDF as a download only, never shown in the page', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderSection(row(['pdf1']))
    fireEvent.click(await screen.findByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(fetches[0]).toMatch(/^https:\/\/store\/pdf1\/download /)
    expect(document.querySelector('iframe, object, embed')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('uploads a prepared photo for the group’s team only, then attaches it', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockResolvedValue({ $id: 'new1' } as never)
    call.mockResolvedValue(view(['img1', 'new1']))
    renderSection(row(['img1']))
    pick()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(prepare).toHaveBeenCalledWith(picked)
    expect(createFile).toHaveBeenCalledWith({
      bucketId: 'receipts',
      fileId: expect.any(String),
      file: ready,
      permissions: ['read("team:house1")'],
    })
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/receipts', {
      receiptFileIds: ['img1', 'new1'],
    })
    expect(await screen.findByRole('img', { name: 'Receipt 2 of 2' })).toBeTruthy()
  })

  it('attaches again without uploading again after a refusal, and says why', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockResolvedValue({ $id: 'new1' } as never)
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    call.mockResolvedValueOnce(view(['new1']))
    renderSection(row())
    pick()
    expect(await screen.findByText('Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(createFile).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[1]?.[3]).toEqual({ receiptFileIds: ['new1'] })
  })

  it('asks to upload again when the ledger refuses the file itself', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockResolvedValue({ $id: 'new1' } as never)
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'receiptFileIds.0 is not valid' },
    })
    renderSection(row())
    pick()
    expect(
      await screen.findByText('We couldn’t attach this receipt. Upload it again.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it.each([
    [{ error: 'Add a photo or a PDF.' }, undefined, 'Add a photo or a PDF.'],
    [
      { file: ready },
      new AppwriteException('Too big', 413, 'storage_invalid_file_size'),
      'This file is over 10 MB. Try a smaller photo or PDF.',
    ],
    [
      { file: ready },
      new TypeError('Failed to fetch'),
      'We couldn’t upload it. Check your connection and try again.',
    ],
  ])('refuses with a plain message, attaching nothing', async (prepared, uploadError, message) => {
    prepare.mockResolvedValue(prepared as never)
    if (uploadError) createFile.mockRejectedValue(uploadError)
    renderSection(row())
    pick()
    expect(await screen.findByText(message)).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('removes a receipt at once, and brings it back if refused', async () => {
    let answer: (result: unknown) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never)
    renderSection(row(['img1', 'img2']))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove receipt 1' }))
    // Gone at once, while the function answers.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove receipt 2' })).toBeNull(),
    )
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/receipts', {
      receiptFileIds: ['img2'],
    })
    answer({
      ok: false,
      error: { code: 'LOCKED', message: 'It’s on a final invoice, so it can’t be changed.' },
    })
    expect(await screen.findByText('It’s on a final invoice, so it can’t be changed.')).toBeTruthy()
    expect(await screen.findByRole('img', { name: 'Receipt 1 of 2' })).toBeTruthy()
  })

  it('asks an unverified user to verify, and gives viewers the view only', async () => {
    mockVerified = false
    renderSection(row(['img1']))
    expect(screen.getByText('Verify your email to add receipts.')).toBeTruthy()
    expect(screen.queryByLabelText('Add a receipt (photo or PDF)')).toBeNull()
    cleanup()
    mockVerified = true
    renderSection(row(['img1']), false)
    expect(await screen.findByRole('img', { name: 'Receipt 1 of 1' })).toBeTruthy()
    expect(screen.queryByLabelText('Add a receipt (photo or PDF)')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove receipt 1' })).toBeNull()
    cleanup()
    renderSection(row(), false)
    expect(screen.queryByRole('heading', { name: 'Receipts' })).toBeNull()
  })

  it('attaches to the list as it is now, not as it was when the photo was picked', async () => {
    prepare.mockResolvedValue({ file: ready })
    let uploaded: (file: unknown) => void = () => {}
    createFile.mockReturnValue(new Promise((resolve) => (uploaded = resolve)) as never)
    call.mockResolvedValue(view(['img1', 'b2', 'new1']))
    const { queryClient } = renderSection(row(['img1']))
    pick()
    // Someone else adds a receipt while this upload is on its way (Realtime refreshes the row).
    await waitFor(() => expect(createFile).toHaveBeenCalled())
    queryClient.setQueryData(['transaction', 't1'], row(['img1', 'b2']))
    uploaded({ $id: 'new1' })
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toEqual({ receiptFileIds: ['img1', 'b2', 'new1'] })
  })

  it('counts a receipt already attached, when its answer was lost, as done', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockResolvedValue({ $id: 'new1' } as never)
    call.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { queryClient } = renderSection(row())
    pick()
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    // It was saved after all: Realtime brings the row with it.
    queryClient.setQueryData(['transaction', 't1'], row(['new1']))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull())
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reloads the row and the group when a change is refused as locked or archived', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'LOCKED', message: 'Locked.' } })
    const { queryClient } = renderSection(row(['img1']))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove receipt 1' }))
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction', 't1'], exact: true }),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'house1'] })
  })

  it('keeps the new list once a removal is done, with focus on the heading', async () => {
    call.mockResolvedValue(view(['img2']))
    const { queryClient } = renderSection(row(['img1', 'img2']))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove receipt 1' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Receipts' }))
    await waitFor(() =>
      expect(queryClient.getQueryData<Transactions>(['transaction', 't1'])?.receiptFileIds).toEqual(
        ['img2'],
      ),
    )
    expect(await screen.findByRole('img', { name: 'Receipt 1 of 1' })).toBeTruthy()
  })

  it('takes no second file or removal while one is on its way', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockResolvedValue({ $id: 'new1' } as never)
    call.mockReturnValueOnce(new Promise(() => {}) as never)
    renderSection(row(['img1']))
    pick()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(
      (screen.getByLabelText('Add a receipt (photo or PDF)') as HTMLInputElement).disabled,
    ).toBe(true)
    const remove = screen.getByRole('button', { name: 'Remove receipt 1' })
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(remove)
    // A removal would reach the function after a tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows only raster previews, and keeps Tab on Close in the larger view', async () => {
    renderSection(row(['img1']))
    const thumb = await screen.findByRole('img', { name: 'Receipt 1 of 1' })
    fireEvent.click(thumb.closest('button') as HTMLElement)
    const close = screen.getByRole('button', { name: 'Close' })
    // Tab is kept from leaving the dialog for the page behind it.
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(close)
    fireEvent.click(close)
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    previewType = 'image/svg+xml'
    renderSection(row(['img1']))
    expect(await screen.findByText('We couldn’t load receipt 1.')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('lets go of preview memory when it goes', async () => {
    renderSection(row(['img1']))
    const thumb = await screen.findByRole('img', { name: 'Receipt 1 of 1' })
    const src = thumb.getAttribute('src')
    cleanup()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src)
  })

  it('says when the bucket refuses the file type', async () => {
    prepare.mockResolvedValue({ file: ready })
    createFile.mockRejectedValue(new AppwriteException('No', 400, 'storage_file_type_unsupported'))
    renderSection(row())
    pick()
    expect(await screen.findByText('Add a photo or a PDF.')).toBeTruthy()
  })

  it('stops offering Add at 10 receipts', async () => {
    renderSection(row(Array.from({ length: 10 }, (_, n) => `img${n}`)))
    expect(await screen.findAllByRole('button', { name: /^Remove receipt/ })).toHaveLength(10)
    expect(screen.queryByLabelText('Add a receipt (photo or PDF)')).toBeNull()
  })
})
