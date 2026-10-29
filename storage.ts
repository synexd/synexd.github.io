import type { CacheInfo, LinuxVariant, SnapshotRecord, VMMode } from './types'

const DB_NAME = 'local-system-vm'
const DB_VERSION = 1
const IMAGES = 'images'
const SNAPSHOTS = 'snapshots'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES)
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Local VM database is blocked by another tab.'))
  })
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = action(transaction.objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function getCachedImage(key: string): Promise<File | undefined> {
  return withStore<File | undefined>(IMAGES, 'readonly', store => store.get(key) as IDBRequest<File | undefined>)
}

export async function putCachedImage(key: string, file: File): Promise<void> {
  await withStore(IMAGES, 'readwrite', store => store.put(file, key))
}

export function snapshotKey(mode: VMMode, variant: LinuxVariant, imageName: string): string {
  return `${mode}:${variant}:${imageName}`
}

export async function saveSnapshot(record: SnapshotRecord): Promise<void> {
  await withStore(SNAPSHOTS, 'readwrite', store => store.put(record))
}

export async function getSnapshot(key: string): Promise<SnapshotRecord | undefined> {
  return withStore<SnapshotRecord | undefined>(SNAPSHOTS, 'readonly', store => store.get(key) as IDBRequest<SnapshotRecord | undefined>)
}

export async function listSnapshots(): Promise<SnapshotRecord[]> {
  return withStore<SnapshotRecord[]>(SNAPSHOTS, 'readonly', store => store.getAll() as IDBRequest<SnapshotRecord[]>)
}

export async function deleteSnapshot(key: string): Promise<void> {
  await withStore(SNAPSHOTS, 'readwrite', store => store.delete(key))
}

export async function getCacheInfo(): Promise<CacheInfo> {
  const db = await openDatabase()
  try {
    return await new Promise<CacheInfo>((resolve, reject) => {
      const result: CacheInfo = { images: 0, imageBytes: 0, snapshots: 0, snapshotBytes: 0 }
      const transaction = db.transaction([IMAGES, SNAPSHOTS], 'readonly')
      const imageCursor = transaction.objectStore(IMAGES).openCursor()
      imageCursor.onsuccess = () => {
        const cursor = imageCursor.result
        if (!cursor) return
        const file = cursor.value as File
        result.images += 1
        result.imageBytes += file.size || 0
        cursor.continue()
      }
      const snapshotCursor = transaction.objectStore(SNAPSHOTS).openCursor()
      snapshotCursor.onsuccess = () => {
        const cursor = snapshotCursor.result
        if (!cursor) return
        const record = cursor.value as SnapshotRecord
        result.snapshots += 1
        result.snapshotBytes += record.buffer?.byteLength || 0
        cursor.continue()
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function clearImageCache(): Promise<void> {
  await withStore(IMAGES, 'readwrite', store => store.clear())
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith('local-system-')).map(key => caches.delete(key)))
  }
}

export async function clearSnapshots(): Promise<void> {
  await withStore(SNAPSHOTS, 'readwrite', store => store.clear())
}
