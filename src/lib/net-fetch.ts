/**
 * Pedido de internet que funciona dentro do app Android.
 *
 * Servidores de carimbo de tempo (TSA) e de certificados atendem em http:// e não
 * liberam CORS, então o WebView não consegue chamá-los com fetch(). No app (Tauri)
 * o pedido é feito pelo lado nativo (comando `http_request`); no navegador comum
 * usa fetch() normalmente.
 */
import { isTauri } from '@/lib/tauri-bridge';

export interface NetRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  timeoutMs?: number;
}

export interface NetResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
}

interface NativeReply {
  status: number;
  content_type: string;
  body: number[] | Uint8Array | ArrayBuffer;
}

function toBytes(data: number[] | Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return copy;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return Uint8Array.from(data as number[]);
}

async function nativeRequest(url: string, req: NetRequest): Promise<NetResponse> {
  const { invoke } = await import('@tauri-apps/api/core');
  const reply = await invoke<NativeReply>('http_request', {
    method: req.method || 'GET',
    url,
    headers: req.headers || {},
    // lista simples de números: passa igual em qualquer versão do WebView
    body: req.body && req.body.length ? Array.from(req.body) : null,
    timeout: req.timeoutMs || 30000,
  });
  return { status: reply.status, contentType: reply.content_type || '', body: toBytes(reply.body || []) };
}

async function browserRequest(url: string, req: NetRequest): Promise<NetResponse> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), req.timeoutMs || 30000) : null;
  try {
    let payload: ArrayBuffer | undefined;
    if (req.body && req.body.length) {
      payload = new ArrayBuffer(req.body.length);
      new Uint8Array(payload).set(req.body);
    }
    const resp = await fetch(url, {
      method: req.method || 'GET',
      headers: req.headers,
      body: payload,
      redirect: 'follow',
      signal: ctrl?.signal,
    });
    const buf = await resp.arrayBuffer();
    return { status: resp.status, contentType: resp.headers.get('content-type') || '', body: new Uint8Array(buf) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** true quando o pedido vai pelo lado nativo do app (sem limite de CORS). */
export function canFetchWithoutCors(url: string): boolean {
  return isTauri() && /^http:\/\//i.test(url);
}

export async function netFetch(url: string, req: NetRequest = {}): Promise<NetResponse> {
  if (canFetchWithoutCors(url)) {
    return nativeRequest(url, req);
  }
  return browserRequest(url, req);
}
