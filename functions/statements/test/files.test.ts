import { AppwriteException, type Storage } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'
import { describe, expect, it, vi } from 'vitest'
import { statementsBucket } from '../src/files'

// The real adapter over a stub Storage: the other tests use a fake Files, and the e2e mock its own.
describe('the statements bucket', () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46])
  const READ = ['read("team:house")']
  const stub = (fields: Partial<Record<'createFile' | 'getFileDownload', unknown>>) =>
    ({ createFile: vi.fn(), getFileDownload: vi.fn(), ...fields }) as unknown as Storage

  it('uploads a PDF under the statement’s ID, with its name and permissions', async () => {
    const createFile = vi.fn().mockResolvedValue({})
    await statementsBucket(stub({ createFile })).upload('s1', 'INV-0001.pdf', PDF, READ)
    expect(createFile).toHaveBeenCalledWith({
      bucketId: 'statements',
      fileId: 's1',
      file: InputFile.fromBuffer(PDF, 'INV-0001.pdf'),
      permissions: READ,
    })
  })

  it('counts a file already there as uploaded, and passes any other failure on', async () => {
    // An interrupted finalize uploaded it: the file ID is the statement's.
    const exists = new AppwriteException('Exists', 409, 'storage_file_already_exists')
    const tooBig = new AppwriteException('Too big', 400, 'storage_invalid_file_size')
    const down = new Error('socket hang up')
    const createFile = vi
      .fn()
      .mockRejectedValueOnce(exists)
      .mockRejectedValueOnce(tooBig)
      .mockRejectedValueOnce(down)
    const bucket = statementsBucket(stub({ createFile }))
    await expect(bucket.upload('s1', 'INV-0001.pdf', PDF, READ)).resolves.toBeUndefined()
    await expect(bucket.upload('s1', 'INV-0001.pdf', PDF, READ)).rejects.toBe(tooBig)
    await expect(bucket.upload('s1', 'INV-0001.pdf', PDF, READ)).rejects.toBe(down)
  })

  it('downloads a PDF as bytes', async () => {
    const getFileDownload = vi.fn().mockResolvedValue(PDF.slice().buffer)
    expect(await statementsBucket(stub({ getFileDownload })).download('s1')).toEqual(PDF)
    expect(getFileDownload).toHaveBeenCalledWith({ bucketId: 'statements', fileId: 's1' })
  })
})
