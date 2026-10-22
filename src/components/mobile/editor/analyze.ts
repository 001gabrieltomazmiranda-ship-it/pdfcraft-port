/**
 * Descobre o que dá para editar numa página: blocos de texto (parágrafos/linhas)
 * e imagens, usando o PDF.js que já está aberto no leitor.
 * Todas as medidas ficam em coordenadas do PDF (pontos, y para cima).
 */

/** [x0, y0, x1, y1] em pontos do PDF, y para cima. */
export type Rect = [number, number, number, number];

export interface TextBlock {
  rect: Rect;
  text: string;
  /** Tamanho da letra mais comum (pt). */
  size: number;
  /** Distância entre as linhas de base (pt). */
  pitch: number;
  family: 'sans' | 'serif' | 'mono';
  bold: boolean;
  italic: boolean;
  /** Quantas linhas o bloco tem na página. */
  lineCount: number;
}

export interface ImageBlock {
  rect: Rect;
}

export interface PageAnalysis {
  texts: TextBlock[];
  images: ImageBlock[];
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  fontName?: string;
}

interface TextStyleLike {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

export interface PdfPageLike {
  rotate: number;
  view: number[];
  getTextContent: () => Promise<{ items: TextItemLike[]; styles: Record<string, TextStyleLike> }>;
  getOperatorList: (opts?: Record<string, unknown>) => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  commonObjs: { has: (id: string) => boolean; get: (id: string) => unknown };
}

export interface PdfLibLike {
  OPS: Record<string, number>;
  AnnotationMode?: Record<string, number>;
}

interface Run {
  x0: number;
  x1: number;
  base: number;
  size: number;
  text: string;
  font: string;
  top: number;
  bottom: number;
}

interface Line extends Run {
  fonts: Record<string, number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fontStyle(page: PdfPageLike, fontName: string, style: TextStyleLike | undefined) {
  let name = '';
  let bold = false;
  let italic = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | null;
      name = (f?.name || '').toLowerCase();
      bold = !!(f?.bold || f?.black);
      italic = !!f?.italic;
    }
  } catch {
    /* fonte ainda não carregada: usa o padrão */
  }
  if (/bold|black|heavy|semibold|demi/.test(name)) bold = true;
  if (/italic|oblique/.test(name)) italic = true;
  const fam = (style?.fontFamily || '').toLowerCase() + ' ' + name;
  const family: TextBlock['family'] = /mono|courier|consol/.test(fam)
    ? 'mono'
    : /serif|times|georgia|garamond|roman/.test(fam) && !/sans/.test(fam)
      ? 'serif'
      : 'sans';
  return { family, bold, italic };
}

function readRuns(items: TextItemLike[], styles: Record<string, TextStyleLike>): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    const str = item.str;
    const t = item.transform;
    if (!str || !t || t.length < 6) continue;
    const [a, b, c, d, e, f] = t;
    // só texto "em pé" (sem giro); o resto não é editável aqui
    if (a <= 0 || d <= 0 || Math.abs(b) > 0.01 * a || Math.abs(c) > 0.01 * d) continue;
    const style = styles[item.fontName || ''];
    if (style?.vertical) continue;
    const size = d;
    const ascent = clamp(style?.ascent || 0.8, 0.5, 1.1);
    const descent = clamp(style?.descent ?? -0.2, -0.5, -0.05);
    const width = item.width && item.width > 0 ? item.width : str.length * size * 0.5;
    runs.push({
      x0: e,
      x1: e + width,
      base: f,
      size,
      text: str,
      font: item.fontName || '',
      top: f + ascent * size,
      bottom: f + descent * size,
    });
  }
  return runs;
}

function buildLines(runs: Run[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const r of runs) {
    const ref = cur ? Math.max(r.size, cur.size) : r.size;
    const sameLine =
      cur &&
      Math.abs(r.base - cur.base) <= 0.35 * ref &&
      r.x0 >= cur.x1 - 0.6 * r.size &&
      r.x0 - cur.x1 <= 1.0 * ref &&
      r.size / cur.size > 0.6 &&
      r.size / cur.size < 1.7;
    if (cur && sameLine) {
      const gap = r.x0 - cur.x1;
      if (gap > 0.15 * r.size && !/\s$/.test(cur.text) && !/^\s/.test(r.text)) cur.text += ' ';
      cur.text += r.text;
      cur.x1 = Math.max(cur.x1, r.x1);
      cur.size = Math.max(cur.size, r.size);
      cur.top = Math.max(cur.top, r.top);
      cur.bottom = Math.min(cur.bottom, r.bottom);
      cur.fonts[r.font] = (cur.fonts[r.font] || 0) + r.text.length;
      continue;
    }
    if (!r.text.trim()) continue;
    cur = { ...r, fonts: { [r.font]: r.text.length } };
    lines.push(cur);
  }
  for (const l of lines) l.text = l.text.replace(/\s+$/, '');
  return lines.filter((l) => l.text.trim().length > 0);
}

function buildBlocks(page: PdfPageLike, lines: Line[], styles: Record<string, TextStyleLike>): TextBlock[] {
  const groups: Line[][] = [];
  for (const line of lines) {
    const g = groups[groups.length - 1];
    if (g && g.length < 40) {
      const last = g[g.length - 1];
      const first = g[0];
      const sizeOk = Math.abs(line.size - last.size) <= 0.2 * last.size;
      const dy = last.base - line.base;
      let spacingOk = dy >= 0.8 * last.size && dy <= 1.9 * last.size;
      if (spacingOk && g.length >= 2) {
        const pitch = g[g.length - 2].base - last.base;
        spacingOk = Math.abs(dy - pitch) <= 0.25 * last.size;
      }
      const x0 = Math.min(...g.map((l) => l.x0));
      const x1 = Math.max(...g.map((l) => l.x1));
      const overlap = line.x0 < x1 && line.x1 > x0;
      const aligned =
        Math.abs(line.x0 - first.x0) <= 1.5 * last.size ||
        Math.abs((line.x0 + line.x1) / 2 - (last.x0 + last.x1) / 2) <= 1.5 * last.size;
      if (sizeOk && spacingOk && overlap && aligned) {
        g.push(line);
        continue;
      }
    }
    groups.push([line]);
  }

  return groups.map((g) => {
    const x0 = Math.min(...g.map((l) => l.x0));
    const x1 = Math.max(...g.map((l) => l.x1));
    const top = Math.max(...g.map((l) => l.top));
    const bottom = Math.min(...g.map((l) => l.bottom));
    const size = median(g.map((l) => l.size));
    const pitch = g.length > 1 ? median(g.slice(1).map((l, i) => g[i].base - l.base)) : size * 1.2;
    // linha que ocupa a largura toda continua na de baixo (quebra automática);
    // senão (linhas curtas, alinhadas à direita/centro), a quebra é de verdade
    const slack = Math.max(3 * size, 0.12 * (x1 - x0));
    const fills = (l: Line) => l.x0 <= x0 + 0.6 * size && l.x1 >= x1 - slack;
    let text = '';
    g.forEach((l, i) => {
      text += l.text;
      if (i < g.length - 1) text += fills(l) && g[i + 1].x0 <= x0 + 0.6 * size ? ' ' : '\n';
    });
    const fonts: Record<string, number> = {};
    for (const l of g) for (const [f, n] of Object.entries(l.fonts)) fonts[f] = (fonts[f] || 0) + n;
    const main = Object.entries(fonts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const st = fontStyle(page, main, styles[main]);
    return { rect: [x0, bottom, x1, top] as Rect, text, size, pitch, lineCount: g.length, ...st };
  });
}

type Mat = [number, number, number, number, number, number];

function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function findImages(page: PdfPageLike, lib: PdfLibLike, fnArray: number[], argsArray: unknown[]): ImageBlock[] {
  const OPS = lib.OPS;
  const [vx0, vy0, vx1, vy1] = page.view;
  const pageArea = Math.abs((vx1 - vx0) * (vy1 - vy0));
  const out: ImageBlock[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  let formDepth = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform && args) ctm = mul(Array.from(args as number[]).slice(0, 6) as Mat, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      formDepth++;
      const m = args?.[0] as number[] | null | undefined;
      if (m && m.length >= 6) ctm = mul(Array.from(m).slice(0, 6) as Mat, ctm);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() || ctm;
      formDepth = Math.max(0, formDepth - 1);
    } else if ((fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject) && formDepth === 0) {
      // imagem desenhada no quadrado 0..1 transformado pela matriz atual
      const [a, b, c, d, e, f] = ctm;
      // só imagens "em pé" (sem giro)
      if (Math.abs(b) > 1e-3 * Math.abs(a) || Math.abs(c) > 1e-3 * Math.abs(d)) continue;
      const xs = [e, a + e];
      const ys = [f, d + f];
      const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const w = rect[2] - rect[0];
      const h = rect[3] - rect[1];
      if (w < 6 || h < 6) continue;
      if (w * h > 0.85 * pageArea) continue; // fundo/página escaneada inteira
      out.push({ rect });
    }
  }
  return out;
}

export async function analyzePage(page: PdfPageLike, lib: PdfLibLike): Promise<PageAnalysis> {
  const content = await page.getTextContent();
  const runs = readRuns(content.items, content.styles);
  const lines = buildLines(runs);
  const texts = buildBlocks(page, lines, content.styles);
  let images: ImageBlock[] = [];
  try {
    const opts: Record<string, unknown> = {};
    if (lib.AnnotationMode && typeof lib.AnnotationMode.DISABLE === 'number') opts.annotationMode = lib.AnnotationMode.DISABLE;
    const ops = await page.getOperatorList(opts);
    images = findImages(page, lib, ops.fnArray, ops.argsArray);
  } catch {
    images = [];
  }
  return { texts, images };
}
