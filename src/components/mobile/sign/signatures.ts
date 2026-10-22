/**
 * Assinaturas e rubricas salvas no aparelho, e a ponte com o editor de assinatura
 * do visualizador (PDF.js), que é quem coloca a assinatura na página.
 */

export type SigKind = 'signature' | 'initials';

/** Desenho da assinatura: traços (ou contornos preenchidos) numa área width x height. */
export interface SigDrawing {
  curves: number[][];
  thickness: number;
  width: number;
  height: number;
  /** true = contornos preenchidos (vindo de texto ou foto); false = traços desenhados */
  areContours: boolean;
  color: string;
}

export interface SavedSig extends SigDrawing {
  id: string;
  kind: SigKind;
  createdAt: number;
}

const KEY = 'pdfcraft_signatures_v1';
const IMPORTED_KEY = 'pdfcraft_signatures_imported';
const MAX_PER_KIND = 4;

export const SIG_COLORS = [
  { id: 'black', hex: '#111111', pt: 'Preto', en: 'Black' },
  { id: 'blue', hex: '#1d4ed8', pt: 'Azul', en: 'Blue' },
  { id: 'red', hex: '#c81e1e', pt: 'Vermelho', en: 'Red' },
] as const;

export function loadSignatures(): SavedSig[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedSig[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.curves) && s.curves.length) : [];
  } catch {
    return [];
  }
}

function store(list: SavedSig[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** arredonda os pontos para guardar menos */
function compact(d: SigDrawing): SigDrawing {
  return {
    ...d,
    curves: d.curves.map((c) => c.map((v) => Math.round(v * 10) / 10)),
  };
}

export function addSignature(kind: SigKind, drawing: SigDrawing): SavedSig[] {
  const item: SavedSig = {
    ...compact(drawing),
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    createdAt: Date.now(),
  };
  const list = loadSignatures();
  const same = list.filter((s) => s.kind === kind);
  const others = list.filter((s) => s.kind !== kind);
  const next = [item, ...same].slice(0, MAX_PER_KIND).concat(others);
  if (!store(next)) {
    // sem espaço: guarda só esta
    store([item, ...others]);
  }
  return loadSignatures();
}

export function removeSignature(id: string): SavedSig[] {
  store(loadSignatures().filter((s) => s.id !== id));
  return loadSignatures();
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Assinaturas que já tinham sido salvas na janela antiga (do visualizador) entram na lista
 * uma vez, para ninguém precisar assinar de novo.
 */
export async function importOldSignatures(lib: any): Promise<SavedSig[]> {
  try {
    if (window.localStorage.getItem(IMPORTED_KEY)) return loadSignatures();
    // visualizador ainda carregando: tenta de novo na próxima vez que o menu abrir
    if (!lib?.SignatureExtractor?.decompressSignature) return loadSignatures();
    window.localStorage.setItem(IMPORTED_KEY, '1');
    const raw = window.localStorage.getItem('pdfjs.signature');
    if (!raw) return loadSignatures();
    const old = JSON.parse(raw) as Record<string, { signatureData?: string }>;
    for (const v of Object.values(old)) {
      if (!v?.signatureData) continue;
      const d = await lib.SignatureExtractor.decompressSignature(v.signatureData);
      if (!d || !Array.isArray(d.outlines) || !d.outlines.length) continue;
      addSignature('signature', {
        curves: d.outlines.map((p: ArrayLike<number>) => Array.from(p)),
        thickness: d.thickness || 0,
        width: d.width,
        height: d.height,
        areContours: !!d.areContours,
        color: '#111111',
      });
    }
  } catch (err) {
    console.warn('[assinatura] não importou as antigas', err);
  }
  return loadSignatures();
}

/** Desenho em SVG (para as miniaturas). */
export function drawingToSvg(d: SigDrawing): { viewBox: string; path: string } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let path = '';
  for (const c of d.curves) {
    if (c.length < 2) continue;
    for (let i = 0; i + 1 < c.length; i += 2) {
      minX = Math.min(minX, c[i]);
      maxX = Math.max(maxX, c[i]);
      minY = Math.min(minY, c[i + 1]);
      maxY = Math.max(maxY, c[i + 1]);
    }
    path += `M${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
    if (c.length === 2) path += `l0.1 0`;
    for (let i = 2; i + 1 < c.length; i += 2) path += `L${c[i].toFixed(1)} ${c[i + 1].toFixed(1)}`;
    if (d.areContours) path += 'Z';
  }
  if (!Number.isFinite(minX)) return { viewBox: '0 0 10 10', path: '' };
  const pad = Math.max(d.thickness, 2);
  return {
    viewBox: `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`,
    path,
  };
}

/** Altura (em pontos do PDF) com que a assinatura entra na página. */
export function heightFor(kind: SigKind): number {
  return kind === 'initials' ? 34 : 54;
}

/** Dados que o editor de assinatura do visualizador entende (parâmetro "criar"). */
export function toEditorData(d: SigDrawing, kind: SigKind) {
  // A espessura do traço vem em pixels da tela de desenho; na página ela vira pontos do PDF
  // na mesma proporção do desenho, para a assinatura ficar igual à que foi feita.
  const thickness = d.areContours ? 0 : Math.max(0.8, Math.round(((d.thickness * heightFor(kind)) / Math.max(1, d.height)) * 100) / 100);
  return {
    signatureData: {
      lines: {
        curves: d.curves.map((points) => ({ points })),
        thickness,
        width: d.width,
        height: d.height,
      },
      mustSmooth: false,
      areContours: d.areContours,
      description: '',
      uuid: null,
      heightInPage: heightFor(kind),
      signatureColor: d.color,
    },
  };
}
