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
  if (workerBroken) return Promise.resolve();
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
  return ready && !workerBroken;
}

// ---------- plano B: o mesmo motor na tela principal ----------
// Alguns aparelhos não deixam o Worker carregar o motor. Aí ele roda aqui mesmo
// (a tela fica parada uns segundos, mas com o aviso "Salvando a edição…").

interface PyLike {
  FS: { writeFile: (p: string, d: Uint8Array) => void; readFile: (p: string) => Uint8Array; unlink: (p: string) => void };
  globals: { set: (k: string, v: unknown) => void };
  runPython: (code: string) => unknown;
  loadPackage: (url: string) => Promise<unknown>;
}

let mainEngine: Promise<PyLike> | null = null;
let workerBroken = false;

async function loadMainEngine(): Promise<PyLike> {
  statusListener?.('loading');
  const base = new URL(withBasePath('/pymupdf-wasm/'), window.location.href).href;
  const mod = (await import(/* webpackIgnore: true */ base + 'pyodide.js')) as {
    loadPyodide: (o: Record<string, unknown>) => Promise<PyLike>;
  };
  const py = await mod.loadPyodide({ indexURL: base, fullStdLib: false });
  statusListener?.('installing');
  await py.loadPackage(base + 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl');
  const src = await (await fetch(withBasePath('/workers/pdf-edit-engine.py'))).text();
  py.runPython(src);
  return py;
}

async function applyOnMain(pdf: Uint8Array, ops: unknown[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (!mainEngine) {
    mainEngine = loadMainEngine().catch((err) => {
      mainEngine = null;
      throw err;
    });
  }
  const py = await mainEngine;
  statusListener?.('saving');
  const id = ++seq;
  const inPath = '/main_in_' + id + '.pdf';
  const outPath = '/main_out_' + id + '.pdf';
  py.FS.writeFile(inPath, pdf);
  py.globals.set('EDIT_OPS', JSON.stringify(ops));
  const report = String(py.runPython("apply_edits('" + inPath + "', '" + outPath + "', EDIT_OPS)"));
  const out = py.FS.readFile(outPath);
  try {
    py.FS.unlink(inPath);
    py.FS.unlink(outPath);
  } catch {
    /* sem problema */
  }
  const bytes = new Uint8Array(out.length);
  bytes.set(out);
  const parsed = JSON.parse(report) as { warnings?: string[] };
  return { bytes, warnings: parsed.warnings || [] };
}

/** Grava as mudanças no PDF e devolve o arquivo novo (Worker; se falhar, na tela principal). */
export async function applyEdits(pdf: Uint8Array, ops: unknown[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (!workerBroken && typeof Worker !== 'undefined' && !(globalThis as { __pcForceMain?: boolean }).__pcForceMain) {
    try {
      // se o motor não ficar pronto em 1 minuto, desiste do Worker e usa o plano B
      await Promise.race([
        warmupEngine(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('engine start timeout')), 60000)),
      ]);
      return await applyInWorker(pdf, ops);
    } catch (err) {
      console.warn('[edit] worker falhou, tentando na tela principal', err);
      workerBroken = true;
      try {
        worker?.terminate();
      } catch {
        /* ignora */
      }
      worker = null;
      ready = false;
    }
  }
  return applyOnMain(pdf, ops);
}

function applyInWorker(pdf: Uint8Array, ops: unknown[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, 120000);
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
