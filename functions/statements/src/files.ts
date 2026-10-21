import { clientFromRequest } from '@ledgerly/server/appwrite/client'
import { AppwriteException, Storage } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'

// data-model.md#storage-buckets
export const STATEMENTS_BUCKET = 'statements'

/** The parts of Appwrite Storage the statements function uses. Tests pass a fake. */
export interface Files {
  /**
   * Uploads a PDF to the statements bucket. A file that already has this ID was uploaded by
   * an interrupted finalize (the file ID is the statement's), so that counts as done.
   */
  upload(fileId: string, name: string, content: Uint8Array, permissions: string[]): Promise<void>
  download(fileId: string): Promise<Uint8Array>
}

/** Storage for this execution, with the per-execution API key. */
export function filesFromRequest(headers: Record<string, string>): Files {
  return statementsBucket(new Storage(clientFromRequest(headers)))
}

/** The statements bucket through `storage`. Its tests pass a stub. */
export function statementsBucket(storage: Storage): Files {
  return {
    async upload(fileId, name, content, permissions) {
      try {
        const file = InputFile.fromBuffer(content, name)
        await storage.createFile({ bucketId: STATEMENTS_BUCKET, fileId, file, permissions })
      } catch (error) {
        if (!(error instanceof AppwriteException && error.code === 409)) throw error
      }
    },
    async download(fileId) {
      const bytes = await storage.getFileDownload({ bucketId: STATEMENTS_BUCKET, fileId })
      return new Uint8Array(bytes)
    },
  }
}
