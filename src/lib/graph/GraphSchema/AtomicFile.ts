import { randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'


// Windows refuses a rename now and then while another process (an
// antivirus, an indexer) has the target open.
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 50


// A reader sees the old file or the new one, never a part: the data goes to
// a hidden temporary file in the same folder (same disk), which is then
// renamed over the target. A failed write leaves no temporary file behind.
/** Writes a file atomically, its folders created. */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
        await writeFile(temporary, data, { flag: 'wx' })
        await renameWithRetry(temporary, path)
    }
    catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
    }
}


/** Renames a file, retrying a few times when Windows reports it busy. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to)
            return
        }
        catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
                throw error
            }
            await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS * attempt))
        }
    }
}
