import { isTauri } from '@/lib/tauri-bridge';

export interface RecentDoc {
  id: string;
  name: string;
  size: number;
  time: number;
  fav: boolean;
}

const KEY = 'pdfcraft_recent_docs';
const DB_NAME = 'pdfcraft-mobile';
const STORE = 'files';
const MAX = 20;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function delBlob(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadBlob(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

export function listRecent(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as RecentDoc[]) : [];
  } catch {
    return [];
  }
}

function saveList(list: RecentDoc[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export async function addRecent(file: File): Promise<RecentDoc> {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  await putBlob(id, file);
  const doc: RecentDoc = { id, name: file.name, size: file.size, time: Date.now(), fav: false };
  const all = [doc, ...listRecent()];
  const keep = all.filter((d, i) => i < MAX || d.fav);
  for (const d of all) {
    if (!keep.includes(d)) {
      try {
        await delBlob(d.id);
      } catch {
        /* ignore */
      }
    }
  }
  saveList(keep);
  return doc;
}

export function toggleFav(id: string): RecentDoc[] {
  const list = listRecent().map((d) => (d.id === id ? { ...d, fav: !d.fav } : d));
  saveList(list);
  return list;
}

export function removeRecent(id: string): RecentDoc[] {
  const list = listRecent().filter((d) => d.id !== id);
  saveList(list);
  delBlob(id).catch(() => undefined);
  return list;
}

export async function saveBytes(name: string, bytes: Uint8Array): Promise<'saved' | 'cancelled'> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: name,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!path) return 'cancelled';
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return 'saved';
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'saved';
}
