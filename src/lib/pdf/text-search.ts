/**
 * Busca de texto numa página do PDF (pdf.js), juntando os pedaços de texto da mesma linha.
 * Assim "João da Silva" é encontrado mesmo quando o PDF guarda cada palavra separada,
 * e o retângulo de cada resultado sai certo também em páginas giradas ou recortadas.
 *
 * As caixas usam o mesmo sistema das ferramentas de tarja: unidades da página na tela
 * (escala 1, já girada), com x a partir da esquerda e y a partir de BAIXO.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ItemGeom {
  str: string;
  /** origem (linha de base) e direções no espaço do PDF */
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  width: number;
  size: number;
}

interface Seg {
  start: number;
  end: number;
  item: number;
}

export interface PageTextIndex {
  text: string;
  segs: Seg[];
  items: ItemGeom[];
  viewport: any;
  width: number;
  height: number;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function measure(s: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
      if (measureCtx) measureCtx.font = '100px Helvetica, Arial, sans-serif';
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return s.length;
  return measureCtx.measureText(s).width;
}

/** fração da largura do pedaço até o caractere `i` (proporcional às letras) */
function frac(str: string, i: number): number {
  if (i <= 0) return 0;
  if (i >= str.length) return 1;
  const total = measure(str);
  if (!(total > 0)) return i / str.length;
  return measure(str.slice(0, i)) / total;
}

export async function buildPageIndex(page: any): Promise<PageTextIndex> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: ItemGeom[] = [];
  const segs: Seg[] = [];
  let text = '';
  let prev: ItemGeom | null = null;
  let prevEol = false;
  for (const raw of content.items as any[]) {
    if (!raw || typeof raw.str !== 'string' || !raw.transform) continue;
    const [a, b, c, d, e, f] = raw.transform as number[];
    const lu = Math.hypot(a, b) || 1;
    const lv = Math.hypot(c, d) || 1;
    const g: ItemGeom = {
      str: raw.str,
      ox: e,
      oy: f,
      ux: a / lu,
      uy: b / lu,
      vx: c / lv,
      vy: d / lv,
      width: Math.abs(raw.width || 0) || raw.str.length * lv * 0.5,
      size: Math.abs(raw.height || 0) || lv,
    };
    if (!g.str) {
      if (raw.hasEOL) prevEol = true;
      continue;
    }
    // separador entre pedaços: nada (mesma palavra), espaço ou quebra de linha
    if (prev) {
      // distância ao longo da linha e de lado, no sistema do pedaço anterior
      const dx = g.ox - prev.ox;
      const dy = g.oy - prev.oy;
      const along = dx * prev.ux + dy * prev.uy;
      const across = dx * prev.vx + dy * prev.vy;
      const sameLine = !prevEol && Math.abs(across) < Math.max(prev.size, g.size) * 0.5 && along > -prev.size * 0.5;
      if (!sameLine) text += '\n';
      else {
        const gap = along - prev.width;
        const endsSpace = /\s$/.test(prev.str) || /^\s/.test(g.str);
        if (!endsSpace && gap > Math.min(prev.size, g.size) * 0.18) text += ' ';
      }
    }
    const idx = items.length;
    items.push(g);
    segs.push({ start: text.length, end: text.length + g.str.length, item: idx });
    text += g.str;
    prev = g;
    prevEol = !!raw.hasEOL;
  }
  return { text, segs, items, viewport, width: viewport.width, height: viewport.height };
}

function itemBox(index: PageTextIndex, it: ItemGeom, from: number, to: number, pad: number): TextBox {
  const s0 = it.width * frac(it.str, from);
  const s1 = it.width * frac(it.str, to);
  const t0 = -it.size * 0.24;
  const t1 = it.size * 0.96;
  const pts: number[] = [];
  for (const s of [s0, s1]) {
    for (const t of [t0, t1]) {
      pts.push(it.ox + it.ux * s + it.vx * t, it.oy + it.uy * s + it.vy * t);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const [vx, vy] = index.viewport.convertToViewportPoint(pts[k], pts[k + 1]);
    minX = Math.min(minX, vx);
    maxX = Math.max(maxX, vx);
    minY = Math.min(minY, vy);
    maxY = Math.max(maxY, vy);
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { x: minX, y: index.height - maxY, width: maxX - minX, height: maxY - minY };
}

/** Caixas de um trecho [start, end) do texto da página (uma por linha). */
export function boxesForRange(index: PageTextIndex, start: number, end: number, pad = 1): TextBox[] {
  const raw: TextBox[] = [];
  for (const seg of index.segs) {
    if (seg.end <= start || seg.start >= end) continue;
    const from = Math.max(start, seg.start) - seg.start;
    const to = Math.min(end, seg.end) - seg.start;
    if (to <= from) continue;
    raw.push(itemBox(index, index.items[seg.item], from, to, pad));
  }
  // junta as caixas da mesma linha
  const out: TextBox[] = [];
  for (const b of raw) {
    const same = out.find((o) => Math.abs(o.y + o.height / 2 - (b.y + b.height / 2)) < Math.min(o.height, b.height) * 0.5);
    if (same) {
      const x0 = Math.min(same.x, b.x);
      const y0 = Math.min(same.y, b.y);
      const x1 = Math.max(same.x + same.width, b.x + b.width);
      const y1 = Math.max(same.y + same.height, b.y + b.height);
      same.x = x0;
      same.y = y0;
      same.width = x1 - x0;
      same.height = y1 - y0;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/** Palavra inteira que entende acentos (\b do JavaScript não entende "ção"). */
export function wholeWordPattern(escaped: string): string {
  return `(?<![\\p{L}\\p{N}_])(?:${escaped})(?![\\p{L}\\p{N}_])`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
