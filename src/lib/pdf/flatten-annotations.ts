/**
 * "Achata" anotações: desenha a aparência de cada anotação (comentário, realce, desenho,
 * carimbo, assinatura desenhada, campo de formulário…) no conteúdo da própria página e
 * tira a anotação. Fica igual na tela, mas não dá mais para mexer.
 *
 * Usa a aparência gravada no arquivo (/AP). Quando ela não existe, cria uma simples para os
 * tipos comuns (realce, sublinhado, riscado, retângulo, círculo, linha, desenho à mão,
 * caixa de texto e nota). Links ficam (não aparecem na página e continuam funcionando).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type PdfLib = any;

export interface FlattenAnnotationsOptions {
  /** também os campos de formulário (Widget) */
  widgets: boolean;
  /** as outras anotações */
  annotations: boolean;
}

export interface FlattenAnnotationsResult {
  flattened: number;
  widgets: number;
  kept: number;
}

const MARKUP_QUADS = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const NEVER_FLATTEN = new Set(['Link', 'Redact', 'Popup', 'Sound', 'Movie', 'Screen', '3D', 'RichMedia', 'FileAttachment']);

function num(v: any): number | undefined {
  if (v && typeof v.asNumber === 'function') return v.asNumber();
  return undefined;
}

function nums(lib: PdfLib, ctx: any, v: any): number[] | null {
  const arr = ctx.lookup(v);
  if (!(arr instanceof lib.PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const n = num(ctx.lookup(arr.get(i)));
    if (n === undefined) return null;
    out.push(n);
  }
  return out;
}

function nameOf(lib: PdfLib, ctx: any, v: any): string | undefined {
  const o = ctx.lookup(v);
  return o instanceof lib.PDFName ? o.decodeText() : undefined;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

/** cor de /C ou /IC (cinza, RGB ou CMYK) para operador de cor */
function colorOps(c: number[] | null, stroke: boolean): string | null {
  if (!c || c.length === 0) return null;
  if (c.length === 1) return `${fmt(c[0])} ${stroke ? 'G' : 'g'}`;
  if (c.length === 3) return `${c.map(fmt).join(' ')} ${stroke ? 'RG' : 'rg'}`;
  if (c.length === 4) return `${c.map(fmt).join(' ')} ${stroke ? 'K' : 'k'}`;
  return null;
}

function borderWidth(lib: PdfLib, ctx: any, annot: any): number {
  const bs = ctx.lookup(annot.get(lib.PDFName.of('BS')));
  if (bs instanceof lib.PDFDict) {
    const w = num(ctx.lookup(bs.get(lib.PDFName.of('W'))));
    if (w !== undefined) return w;
  }
  const border = nums(lib, ctx, annot.get(lib.PDFName.of('Border')));
  if (border && border.length >= 3) return border[2];
  return 1;
}

function pdfStringText(lib: PdfLib, ctx: any, v: any): string {
  const o = ctx.lookup(v);
  if (o instanceof lib.PDFString || o instanceof lib.PDFHexString) return o.decodeText();
  return '';
}

/** quebra o texto em linhas que cabem na largura */
function wrap(font: any, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const tryLine = line ? line + ' ' + w : w;
      if (line && font.widthOfTextAtSize(tryLine, size) > width) {
        out.push(line);
        line = w;
      } else {
        line = tryLine;
      }
    }
    out.push(line);
  }
  return out;
}

/** só os caracteres que a fonte padrão consegue escrever */
function encodable(font: any, text: string): string {
  let set: Set<number> | null = null;
  try {
    set = new Set<number>(font.getCharacterSet());
  } catch {
    set = null;
  }
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (ch === '\n' || !set || set.has(cp)) out += ch;
    else out += '?';
  }
  return out;
}

interface Synth {
  ops: string;
  resources?: Record<string, unknown>;
}

async function synthesize(lib: PdfLib, doc: any, annot: any, subtype: string, rect: number[], helv: () => Promise<any>): Promise<Synth | null> {
  const ctx = doc.context;
  const C = nums(lib, ctx, annot.get(lib.PDFName.of('C')));
  const IC = nums(lib, ctx, annot.get(lib.PDFName.of('IC')));
  const w = borderWidth(lib, ctx, annot);
  const [x0, y0, x1, y1] = rect;

  if (MARKUP_QUADS.has(subtype)) {
    const q = nums(lib, ctx, annot.get(lib.PDFName.of('QuadPoints'))) || [x0, y1, x1, y1, x0, y0, x1, y0];
    const color = C && C.length ? C : [1, 1, 0];
    const parts: string[] = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
      const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const bottom = Math.min(...ys);
      const top = Math.max(...ys);
      const h = top - bottom;
      if (subtype === 'Highlight') {
        parts.push(`${fmt(q[i])} ${fmt(q[i + 1])} m ${fmt(q[i + 2])} ${fmt(q[i + 3])} l ${fmt(q[i + 6])} ${fmt(q[i + 7])} l ${fmt(q[i + 4])} ${fmt(q[i + 5])} l h f`);
      } else if (subtype === 'Underline') {
        parts.push(`${fmt(left)} ${fmt(bottom + h * 0.06)} m ${fmt(right)} ${fmt(bottom + h * 0.06)} l S`);
      } else if (subtype === 'StrikeOut') {
        parts.push(`${fmt(left)} ${fmt(bottom + h * 0.45)} m ${fmt(right)} ${fmt(bottom + h * 0.45)} l S`);
      } else {
        const amp = Math.max(0.8, h * 0.06);
        let s = `${fmt(left)} ${fmt(bottom + amp)} m`;
        let up = false;
        for (let x = left + amp * 2; x <= right; x += amp * 2) {
          s += ` ${fmt(x)} ${fmt(bottom + (up ? amp * 2 : 0) + amp * 0.2)} l`;
          up = !up;
        }
        parts.push(s + ' S');
      }
    }
    const lineW = subtype === 'Highlight' ? 0 : Math.max(0.6, (Math.max(...q.filter((_, k) => k % 2 === 1)) - Math.min(...q.filter((_, k) => k % 2 === 1))) / 16);
    const head =
      subtype === 'Highlight'
        ? `/GS0 gs ${colorOps(color, false)}`
        : `${colorOps(color, true)} ${fmt(lineW)} w 1 J 1 j`;
    return {
      ops: `${head}\n${parts.join('\n')}`,
      resources: subtype === 'Highlight' ? { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } } : undefined,
    };
  }

  if (subtype === 'Square' || subtype === 'Circle') {
    // sem cor definida os leitores desenham a borda preta
    const fill = colorOps(IC, false);
    const stroke = colorOps(C, true) || (C && C.length === 0 ? null : fill ? null : '0 G');
    if (!stroke && !fill) return null;
    const i = w / 2;
    const left = x0 + i;
    const bottom = y0 + i;
    const width = Math.max(0, x1 - x0 - w);
    const height = Math.max(0, y1 - y0 - w);
    let path: string;
    if (subtype === 'Square') {
      path = `${fmt(left)} ${fmt(bottom)} ${fmt(width)} ${fmt(height)} re`;
    } else {
      const k = 0.5523;
      const cx = left + width / 2;
      const cy = bottom + height / 2;
      const rx = width / 2;
      const ry = height / 2;
      path =
        `${fmt(cx + rx)} ${fmt(cy)} m ` +
        `${fmt(cx + rx)} ${fmt(cy + ry * k)} ${fmt(cx + rx * k)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c ` +
        `${fmt(cx - rx * k)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ry * k)} ${fmt(cx - rx)} ${fmt(cy)} c ` +
        `${fmt(cx - rx)} ${fmt(cy - ry * k)} ${fmt(cx - rx * k)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c ` +
        `${fmt(cx + rx * k)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ry * k)} ${fmt(cx + rx)} ${fmt(cy)} c h`;
    }
    const paint = stroke && fill && w > 0 ? 'B' : fill ? 'f' : 'S';
    return { ops: `${stroke || ''} ${fill || ''} ${fmt(w)} w\n${path} ${paint}` };
  }

  if (subtype === 'Line' || subtype === 'Ink' || subtype === 'PolyLine' || subtype === 'Polygon') {
    const stroke = colorOps(C && C.length ? C : [0, 0, 0], true);
    const paths: number[][] = [];
    if (subtype === 'Line') {
      const l = nums(lib, ctx, annot.get(lib.PDFName.of('L')));
      if (l && l.length >= 4) paths.push(l.slice(0, 4));
    } else if (subtype === 'Ink') {
      const ink = ctx.lookup(annot.get(lib.PDFName.of('InkList')));
      if (ink instanceof lib.PDFArray) {
        for (let k = 0; k < ink.size(); k++) {
          const p = nums(lib, ctx, ink.get(k));
          if (p && p.length >= 2) paths.push(p);
        }
      }
    } else {
      const v = nums(lib, ctx, annot.get(lib.PDFName.of('Vertices')));
      if (v && v.length >= 4) paths.push(subtype === 'Polygon' ? [...v, v[0], v[1]] : v);
    }
    if (!paths.length) return null;
    const segs = paths.map((p) => {
      let s = `${fmt(p[0])} ${fmt(p[1])} m`;
      if (p.length === 2) s += ` ${fmt(p[0] + 0.01)} ${fmt(p[1])} l`;
      for (let k = 2; k + 1 < p.length; k += 2) s += ` ${fmt(p[k])} ${fmt(p[k + 1])} l`;
      return s + ' S';
    });
    return { ops: `${stroke} ${fmt(Math.max(0.5, w))} w 1 J 1 j\n${segs.join('\n')}` };
  }

  if (subtype === 'FreeText') {
    const text = pdfStringText(lib, ctx, annot.get(lib.PDFName.of('Contents')));
    if (!text.trim()) return null;
    const da = pdfStringText(lib, ctx, annot.get(lib.PDFName.of('DA')));
    const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 12;
    const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    const gray = /([\d.]+)\s+g(\s|$)/.exec(da);
    const color = rgb ? `${rgb[1]} ${rgb[2]} ${rgb[3]} rg` : gray ? `${gray[1]} g` : '0 g';
    const font = await helv();
    const pad = 2;
    const lines = wrap(font, encodable(font, text), size, Math.max(10, x1 - x0 - pad * 2));
    const lead = size * 1.2;
    let ops = `BT /Helv ${fmt(size)} Tf ${color}\n`;
    let y = y1 - pad - size;
    for (const line of lines) {
      if (y < y0 - size) break;
      const hex = font.encodeText(line).toString();
      ops += `1 0 0 1 ${fmt(x0 + pad)} ${fmt(y)} Tm ${hex} Tj\n`;
      y -= lead;
    }
    ops += 'ET';
    const fill = IC ? colorOps(IC, false) : null;
    return {
      ops: (fill ? `${fill} ${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re f\n` : '') + ops,
      resources: { Font: { Helv: font.ref } },
    };
  }

  if (subtype === 'Text') {
    // nota adesiva: desenha o ícone de nota no canto
    const s = 18;
    const top = y1;
    const left = x0;
    const color = colorOps(C && C.length ? C : [1, 0.85, 0.2], false);
    return {
      ops:
        `${color} 0.3 0.3 0.3 RG 0.6 w\n${fmt(left)} ${fmt(top - s)} ${fmt(s)} ${fmt(s)} re B\n` +
        `0.35 0.35 0.35 RG 0.8 w ${fmt(left + 3.5)} ${fmt(top - 6)} m ${fmt(left + s - 3.5)} ${fmt(top - 6)} l S ` +
        `${fmt(left + 3.5)} ${fmt(top - 9.5)} m ${fmt(left + s - 3.5)} ${fmt(top - 9.5)} l S ` +
        `${fmt(left + 3.5)} ${fmt(top - 13)} m ${fmt(left + s - 6)} ${fmt(top - 13)} l S`,
    };
  }
  return null;
}

/** acha a aparência normal (/AP /N) – direta ou pelo estado /AS */
function appearanceRef(lib: PdfLib, ctx: any, annot: any): any {
  const ap = ctx.lookup(annot.get(lib.PDFName.of('AP')));
  if (!(ap instanceof lib.PDFDict)) return null;
  const nRaw = ap.get(lib.PDFName.of('N'));
  const n = ctx.lookup(nRaw);
  if (n instanceof lib.PDFStream) return nRaw instanceof lib.PDFRef ? nRaw : ctx.register(n);
  if (n instanceof lib.PDFDict) {
    const as = annot.get(lib.PDFName.of('AS'));
    const stateName = as instanceof lib.PDFName ? as : null;
    if (!stateName) return null;
    const sRaw = n.get(stateName);
    const s = ctx.lookup(sRaw);
    if (s instanceof lib.PDFStream) return sRaw instanceof lib.PDFRef ? sRaw : ctx.register(s);
  }
  return null;
}

function transformBox(m: number[], b: number[]): number[] {
  const pts = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Achata as anotações de todas as páginas. Não salva: quem chama faz o `save()`.
 */
export async function flattenAnnotations(lib: PdfLib, doc: any, opts: FlattenAnnotationsOptions): Promise<FlattenAnnotationsResult> {
  const ctx = doc.context;
  const N = lib.PDFName;
  const res: FlattenAnnotationsResult = { flattened: 0, widgets: 0, kept: 0 };
  let helvFont: any = null;
  const helv = async () => {
    if (!helvFont) helvFont = await doc.embedFont(lib.StandardFonts.Helvetica);
    return helvFont;
  };
  const removedRefs = new Set<string>();

  for (const page of doc.getPages()) {
    const annotsRaw = page.node.get(N.of('Annots'));
    const annots = ctx.lookup(annotsRaw);
    if (!(annots instanceof lib.PDFArray) || annots.size() === 0) continue;
    const keep: any[] = [];
    const draws: { key: any; m: number[]; gs?: any }[] = [];
    const flattenedHere = new Set<string>();

    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const annot = ctx.lookup(ref);
      if (!(annot instanceof lib.PDFDict)) continue;
      const subtype = nameOf(lib, ctx, annot.get(N.of('Subtype'))) || '';
      const isWidget = subtype === 'Widget';
      if ((isWidget && !opts.widgets) || (!isWidget && !opts.annotations) || NEVER_FLATTEN.has(subtype)) {
        keep.push(ref);
        continue;
      }
      const flags = num(ctx.lookup(annot.get(N.of('F')))) || 0;
      const rect = nums(lib, ctx, annot.get(N.of('Rect')));
      // escondida ou "não aparece na tela": só sai
      if (flags & 2 || flags & 32 || !rect || rect.length < 4) {
        if (ref instanceof lib.PDFRef) flattenedHere.add(ref.toString());
        continue;
      }
      const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      if (r[2] - r[0] < 0.01 || r[3] - r[1] < 0.01) {
        // assinatura invisível etc.: não tem o que desenhar
        if (isWidget) {
          keep.push(ref);
        } else if (ref instanceof lib.PDFRef) {
          flattenedHere.add(ref.toString());
        }
        continue;
      }

      let apRef = appearanceRef(lib, ctx, annot);
      let matrix: number[] | null = null;
      if (apRef) {
        const stream = ctx.lookup(apRef);
        const sd = stream.dict;
        if (!sd.get(N.of('Subtype'))) sd.set(N.of('Subtype'), N.of('Form'));
        if (!sd.get(N.of('Type'))) sd.set(N.of('Type'), N.of('XObject'));
        let bbox = nums(lib, ctx, sd.get(N.of('BBox')));
        if (!bbox || bbox.length < 4) {
          bbox = [0, 0, r[2] - r[0], r[3] - r[1]];
          sd.set(N.of('BBox'), ctx.obj(bbox));
        }
        const fm = nums(lib, ctx, sd.get(N.of('Matrix'))) || [1, 0, 0, 1, 0, 0];
        const tb = transformBox(fm, bbox);
        const bw = tb[2] - tb[0];
        const bh = tb[3] - tb[1];
        if (bw <= 0 || bh <= 0) {
          apRef = null;
        } else {
          const sx = (r[2] - r[0]) / bw;
          const sy = (r[3] - r[1]) / bh;
          matrix = [sx, 0, 0, sy, r[0] - tb[0] * sx, r[1] - tb[1] * sy];
        }
      }
      if (!apRef && !isWidget) {
        const synth = await synthesize(lib, doc, annot, subtype, r, helv);
        if (synth) {
          const dict: Record<string, unknown> = { Type: 'XObject', Subtype: 'Form', BBox: r };
          if (synth.resources) dict.Resources = synth.resources;
          const stream = ctx.flateStream(synth.ops, dict);
          apRef = ctx.register(stream);
          matrix = [1, 0, 0, 1, 0, 0];
        }
      }
      if (!apRef || !matrix) {
        keep.push(ref);
        res.kept++;
        continue;
      }
      const key = page.node.newXObject('FlatAnnot', apRef);
      const ca = num(ctx.lookup(annot.get(N.of('CA'))));
      let gs: any;
      if (ca !== undefined && ca < 1) {
        gs = page.node.newExtGState('FlatGS', ctx.obj({ Type: 'ExtGState', ca, CA: ca }));
      }
      draws.push({ key, m: matrix, gs });
      if (ref instanceof lib.PDFRef) flattenedHere.add(ref.toString());
      if (isWidget) res.widgets++;
      else res.flattened++;
    }

    if (draws.length) {
      page.node.normalize();
      const ops: any[] = [];
      for (const d of draws) {
        ops.push(lib.pushGraphicsState());
        if (d.gs) ops.push(lib.setGraphicsState(d.gs));
        ops.push(lib.concatTransformationMatrix(d.m[0], d.m[1], d.m[2], d.m[3], d.m[4], d.m[5]));
        ops.push(lib.drawObject(d.key));
        ops.push(lib.popGraphicsState());
      }
      page.pushOperators(...ops);
    }
    // popups das anotações achatadas saem junto
    const finalKeep = keep.filter((ref) => {
      const a = ctx.lookup(ref);
      if (!(a instanceof lib.PDFDict)) return true;
      if (nameOf(lib, ctx, a.get(N.of('Subtype'))) !== 'Popup') return true;
      const parent = a.get(N.of('Parent'));
      return !(parent instanceof lib.PDFRef && flattenedHere.has(parent.toString()));
    });
    flattenedHere.forEach((k) => removedRefs.add(k));
    if (finalKeep.length) page.node.set(N.of('Annots'), ctx.obj(finalKeep));
    else page.node.delete(N.of('Annots'));
  }

  // campos do formulário que viraram desenho saem da lista de campos
  if (opts.widgets && removedRefs.size) {
    const acro = ctx.lookup(doc.catalog.get(N.of('AcroForm')));
    if (acro instanceof lib.PDFDict) {
      const prune = (arrRaw: any): any => {
        const arr = ctx.lookup(arrRaw);
        if (!(arr instanceof lib.PDFArray)) return arrRaw;
        const kept: any[] = [];
        for (let i = 0; i < arr.size(); i++) {
          const fr = arr.get(i);
          if (fr instanceof lib.PDFRef && removedRefs.has(fr.toString())) continue;
          const f = ctx.lookup(fr);
          if (f instanceof lib.PDFDict && f.get(N.of('Kids'))) {
            const kids = prune(f.get(N.of('Kids')));
            const kArr = ctx.lookup(kids);
            if (kArr instanceof lib.PDFArray && kArr.size() === 0) continue;
            f.set(N.of('Kids'), kids);
          }
          kept.push(fr);
        }
        return ctx.obj(kept);
      };
      const fields = prune(acro.get(N.of('Fields')));
      const fArr = ctx.lookup(fields);
      if (fArr instanceof lib.PDFArray && fArr.size() === 0) doc.catalog.delete(N.of('AcroForm'));
      else acro.set(N.of('Fields'), fields);
    }
  }
  return res;
}
