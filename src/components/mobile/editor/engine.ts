/**
 * Conversa com o "motor" que grava a edição no arquivo (PyMuPDF num Worker).
 * O motor é carregado uma vez (alguns segundos na primeira vez) e fica pronto
 * enquanto o leitor estiver aberto.
 */
import { withBasePath } from '@/lib/utils/path';

export type EngineStatus = 'loading' | 'installing' | 'ready' | 'saving';

interface Pending {
  resolve: (v: { bytes: Uint8Array; warnings: string[] }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
let ready = false;
let statusListener: ((s: EngineStatus) => void) | null = null;

function fail(err: Error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  for (const w of readyWaiters) w.reject(err);
  readyWaiters = [];
  ready = false;
  worker?.terminate();
  worker = null;
}

function ensure(): Worker {
  if (worker) return worker;
  const w = new Worker(withBasePath('/workers/pdf-edit.worker.js'), { type: 'module' });
  w.onmessage = (ev: MessageEvent) => {
    const msg = ev.data || {};
    if (msg.type === 'status') {
      statusListener?.(msg.message as EngineStatus);
      return;
    }
    if (msg.type === 'ready') {
      ready = true;
      for (const r of readyWaiters) r.resolve();
      readyWaiters = [];
      return;
    }
    if (msg.type === 'result' || (msg.type === 'error' && typeof msg.id === 'number')) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'result') p.resolve({ bytes: new Uint8Array(msg.pdf as ArrayBuffer), warnings: msg.warnings || [] });
      else p.reject(new Error(String(msg.message || 'edit failed')));
      return;
    }
    if (msg.type === 'error') {
      fail(new Error(String(msg.message || 'engine failed')));
    }
  };
  w.onerror = (ev: ErrorEvent) => {
    fail(new Error(ev.message || 'engine failed to start'));
  };
  worker = w;
  return w;
}

/** Começa a carregar o motor em segundo plano (para o Concluído ser rápido). */
export function warmupEngine(): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
    try {
      ensure().postMessage({ type: 'init' });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function onEngineStatus(fn: ((s: EngineStatus) => void) | null): void {
  statusListener = fn;
}

export function isEngineReady(): boolean {
  return ready;
}

/** Grava as mudanças no PDF e devolve o arquivo novo. */
export function applyEdits(pdf: Uint8Array, ops: unknown[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, 180000);
    pending.set(id, { resolve, reject, timer });
    try {
      const copy = pdf.slice().buffer;
      ensure().postMessage({ type: 'apply', id, pdf: copy, ops: JSON.stringify(ops) }, [copy]);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
