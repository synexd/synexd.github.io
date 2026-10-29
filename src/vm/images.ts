import { getCachedImage, putCachedImage } from './storage'
import type { BootImage } from './types'

export async function loadBundledImage(
  key: string,
  url: string,
  name: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<BootImage> {
  const cached = await getCachedImage(key)
  if (cached) {
    onProgress(cached.size, cached.size)
    return { file: cached, cached: true, source: 'indexeddb' }
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Image download failed (${response.status} ${response.statusText}).`)
  const total = Number(response.headers.get('content-length')) || 0
  let file: File

  if (response.body) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        loaded += value.byteLength
        onProgress(loaded, total)
      }
    }
    file = new File(chunks as BlobPart[], name, { type: 'application/octet-stream' })
  } else {
    const buffer = await response.arrayBuffer()
    file = new File([buffer], name, { type: 'application/octet-stream' })
    onProgress(file.size, total || file.size)
  }

  try {
    await putCachedImage(key, file)
  } catch {
    // A full or unavailable IndexedDB must not prevent an in-memory boot.
  }
  return { file, cached: false, source: 'bundled' }
}

export async function decompressGzip(file: File): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the instant desktop state. Use cold boot instead.')
  }
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).arrayBuffer()
}

export async function cacheLocalImage(key: string, file: File): Promise<BootImage> {
  try {
    await putCachedImage(key, file)
  } catch {
    // Keep the user-selected File usable even when persistence is unavailable.
  }
  return { file, cached: true, source: 'local' }
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`
}
