/**
 * Carrega o zgapdfsigner (assinatura e carimbo de tempo de PDF) já preparado para o app:
 * - os pedidos de rede (TSA e certificados da cadeia) passam pelo lado nativo do app,
 *   que não sofre o bloqueio de CORS do WebView;
 * - se a busca de um certificado intermediário falhar, a assinatura continua sem ele;
 * - se uma assinatura falhar no meio, as referências internas do pdf-lib são restauradas
 *   (o zgapdfsigner as renumera e, sem isso, os próximos PDFs abertos no app ficariam errados).
 */
import { netFetch } from '@/lib/net-fetch';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Zga = any;

interface UrlFetchParams {
  method?: string;
  headers?: Record<string, string>;
  payload?: Uint8Array | ArrayBuffer | string;
}

let loading: Promise<Zga> | null = null;

function payloadBytes(p: UrlFetchParams['payload']): Uint8Array | null {
  if (!p) return null;
  if (typeof p === 'string') {
    const out = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = p.charCodeAt(i) & 0xff;
    return out;
  }
  if (p instanceof ArrayBuffer) return new Uint8Array(p.slice(0));
  const out = new Uint8Array(p.length);
  out.set(p);
  return out;
}

export function loadZga(): Promise<Zga> {
  if (!loading) {
    loading = (async () => {
      const mod: any = await import('zgapdfsigner');
      const z: Zga = mod && mod.default && mod.default.PdfSigner ? mod.default : mod;
      if (!z || !z.PdfSigner) throw new Error('zgapdfsigner not available');
      z.urlFetch = async (url: string, params?: UrlFetchParams): Promise<Uint8Array | null> => {
        const body = payloadBytes(params?.payload);
        const method = (params?.method || (body ? 'POST' : 'GET')).toUpperCase() as 'GET' | 'POST';
        if (method === 'GET') {
          // certificados da cadeia: ajuda, mas não é obrigatório
          try {
            const r = await netFetch(url, { method: 'GET', headers: params?.headers, timeoutMs: 15000 });
            if (r.status >= 200 && r.status < 300 && r.body.length) return r.body;
          } catch (err) {
            console.warn('[assinatura] certificado da cadeia não baixou', url, err);
          }
          return null;
        }
        const r = await netFetch(url, { method, headers: params?.headers, body, timeoutMs: 30000 });
        if (r.status < 200 || r.status >= 300) {
          throw new Error(`HTTP ${r.status} (${url})`);
        }
        if (!r.body.length) throw new Error(`empty response (${url})`);
        return r.body;
      };
      return z;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** true se o PDF já tem alguma assinatura ou carimbo (aí a nova entra como revisão incremental). */
export function hasSignatures(pdf: Uint8Array): boolean {
  const needle = '/ByteRange';
  const n0 = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= pdf.length; i++) {
    if (pdf[i] !== n0) continue;
    for (let k = 1; k < needle.length; k++) if (pdf[i + k] !== needle.charCodeAt(k)) continue outer;
    // ignora o marcador provisório "/ByteRange [0 /****"
    let j = i + needle.length;
    while (j < pdf.length && (pdf[j] === 0x20 || pdf[j] === 0x0a || pdf[j] === 0x0d || pdf[j] === 0x5b)) j++;
    if (pdf[j] >= 0x30 && pdf[j] <= 0x39) return true;
  }
  return false;
}

/** Assina (ou carimba) e sempre deixa o pdf-lib em ordem, dando certo ou não. */
export async function zgaSign(z: Zga, signOptions: Record<string, unknown>, pdf: Uint8Array, encrypt?: Record<string, unknown>): Promise<Uint8Array> {
  const data = new Uint8Array(pdf.length);
  data.set(pdf);
  try {
    const signer = new z.PdfSigner({ debug: false, ...signOptions });
    // PDF ainda sem assinatura: abre sem carimbar "pdf-lib" nos dados do arquivo
    let input: unknown = data;
    if (!hasSignatures(data) && z.PDFLib?.PDFDocument) {
      try {
        const doc = await z.PDFLib.PDFDocument.load(data, { updateMetadata: false });
        doc.setProducer('PDFCraft');
        doc.setModificationDate(new Date());
        input = doc;
      } catch {
        input = data;
      }
    }
    const out = await signer.sign(input, encrypt);
    const copy = new Uint8Array(out.length);
    copy.set(out);
    return copy;
  } finally {
    try {
      if (z.newRefs && z.newRefs.size > 0 && z.newRefs.pdfcont) z.newRefs.restoreAll();
    } catch (err) {
      console.warn('[assinatura] não restaurou referências', err);
    }
  }
}
