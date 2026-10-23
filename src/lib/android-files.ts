/**
 * Ponte com a parte Android do app (plugin "pdfcraft-files", em Kotlin):
 * - pasta escolhida pela pessoa para salvar, com aviso quando o nome já existe;
 * - PDFs que chegam de outros apps ("Abrir com" e "Compartilhar").
 *
 * Os bytes vão e voltam em pedaços (base64) para não travar com arquivos grandes.
 */
import { isTauri } from '@/lib/tauri-bridge';

const CMD = 'plugin:pdfcraft-files|';
const FOLDER_KEY = 'pdfcraft_save_folder';
const CHUNK = 1024 * 1024; // 1 MB por pedaço

export interface SaveFolder {
  uri: string;
  name: string;
}

export interface SaveReply {
  status: 'saved' | 'exists';
  name: string;
  folder?: string;
}

/** true dentro do app Android (Tauri). */
export function isAndroidApp(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(CMD + cmd, args);
}

let available: Promise<boolean> | null = null;

/** A parte Android do PDFCraft carregou? (se não, o salvar usa a janela do sistema, como antes) */
export function androidFilesReady(): Promise<boolean> {
  if (!isAndroidApp()) return Promise.resolve(false);
  if (!available) {
    available = call<{ ok: boolean }>('folder_info', { folder: '' }).then(
      () => true,
      (err) => {
        console.warn('[pdfcraft-files] indisponível', err);
        return false;
      }
    );
  }
  return available;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------ pasta

export function savedFolder(): SaveFolder | null {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    const f = raw ? (JSON.parse(raw) as SaveFolder) : null;
    return f && typeof f.uri === 'string' && f.uri ? f : null;
  } catch {
    return null;
  }
}

function rememberFolder(f: SaveFolder | null): void {
  try {
    if (f) localStorage.setItem(FOLDER_KEY, JSON.stringify(f));
    else localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* sem armazenamento: pergunta a pasta de novo na próxima vez */
  }
}

export function forgetFolder(): void {
  rememberFolder(null);
}

/** Confere se o app ainda tem acesso à pasta guardada (e atualiza o nome dela). */
export async function checkFolder(f: SaveFolder | null): Promise<SaveFolder | null> {
  if (!f) return null;
  try {
    const r = await call<{ ok: boolean; name: string }>('folder_info', { folder: f.uri });
    if (!r.ok) {
      rememberFolder(null);
      return null;
    }
    const next = { uri: f.uri, name: r.name || f.name };
    rememberFolder(next);
    return next;
  } catch {
    return f;
  }
}

/** Abre o seletor de pastas do Android. Devolve null se a pessoa voltar sem escolher. */
export async function pickFolder(current?: SaveFolder | null): Promise<SaveFolder | null> {
  const r = await call<{ picked: boolean; uri?: string; name?: string }>('pick_folder', current?.uri ? { initial: current.uri } : {});
  if (!r.picked || !r.uri) return null;
  const f = { uri: r.uri, name: r.name || '' };
  rememberFolder(f);
  return f;
}

// ------------------------------------------------------------ salvar

/** Passa o arquivo para o lado Android (fica num temporário do app até salvar). */
export async function uploadForSave(bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) {
    await call('write_temp', { data: '', append: false });
    return;
  }
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await call('write_temp', { data: toBase64(bytes.subarray(i, i + CHUNK)), append: i > 0 });
  }
}

/** Grava o que foi enviado em uploadForSave. Com overwrite=false, avisa se o nome já existe. */
export async function saveInFolder(folder: SaveFolder, fileName: string, overwrite: boolean): Promise<SaveReply> {
  const r = await call<{ status: string; name?: string; folder?: string }>('save', {
    folder: folder.uri,
    name: fileName,
    overwrite,
  });
  return {
    status: r.status === 'exists' ? 'exists' : 'saved',
    name: r.name || fileName,
    folder: r.folder || folder.name,
  };
}

// ------------------------------------------------------------ abrir com

/** PDF que outro app mandou para cá ("Abrir com"), se houver. */
export async function takeOpenedFile(onFound?: (name: string) => void): Promise<File | null> {
  const r = await call<{ found: boolean; name?: string; size?: number }>('take_opened');
  if (!r.found) return null;
  onFound?.(r.name || '');
  const size = Number(r.size || 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const part = await call<{ data: string; size: number }>('read_opened', { offset, length: CHUNK });
    const chunk = fromBase64(part.data || '');
    if (chunk.length === 0) break;
    bytes.set(chunk.subarray(0, Math.min(chunk.length, size - offset)), offset);
    offset += chunk.length;
  }
  let name = (r.name || 'documento.pdf').trim() || 'documento.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' });
}
