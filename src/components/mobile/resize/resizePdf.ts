/**
 * Muda o tamanho das páginas do PDF de verdade (MediaBox/CropBox), levando junto o
 * conteúdo e as anotações (comentários, assinaturas, links, campos).
 *
 * Modos para o conteúdo:
 *  - fit: cabe inteiro na página nova, sem distorcer (sobra margem se a proporção for outra)
 *  - fill: cobre a página nova inteira, sem distorcer (o que passar da borda fica cortado)
 *  - stretch: estica para ocupar exatamente a página nova (pode distorcer)
 */

export type FitMode = 'fit' | 'fill' | 'stretch';

export interface ResizeOptions {
  /** Tamanho final visto na tela, em pontos (já considerando páginas giradas). */
  width: number;
  height: number;
  mode: FitMode;
  /** Páginas (começando em 1) ou todas. */
  pages: 'all' | number[];
}

type Num = { asNumber: () => number };
type Arr = { size: () => number; get: (i: number) => unknown; asArray?: () => unknown[] };

const ANNOT_POINT_KEYS = ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL'];

export async function resizePdf(bytes: Uint8Array, opts: ResizeOptions): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib: any = await import('pdf-lib');
  const { PDFDocument, PDFName, PDFArray, PDFNumber } = lib;
  // cópia no "mundo" desta janela: os bytes podem vir do visualizador (iframe) e o pdf-lib não os reconheceria
  const data = new Uint8Array(bytes.length);
  data.set(bytes);
  const doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const wanted = opts.pages === 'all' ? null : new Set(opts.pages);

  pages.forEach((page: any, index: number) => {
    if (wanted && !wanted.has(index + 1)) return;
    const crop = page.getCropBox();
    const cw = crop.width;
    const ch = crop.height;
    if (!(cw > 0 && ch > 0)) return;
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = angle === 90 || angle === 270;
    // tamanho final no sistema da página (antes do giro)
    const tw = sideways ? opts.height : opts.width;
    const th = sideways ? opts.width : opts.height;

    let sx: number;
    let sy: number;
    if (opts.mode === 'stretch') {
      sx = tw / cw;
      sy = th / ch;
    } else {
      const s = opts.mode === 'fill' ? Math.max(tw / cw, th / ch) : Math.min(tw / cw, th / ch);
      sx = s;
      sy = s;
    }
    const dx = (tw - cw * sx) / 2;
    const dy = (th - ch * sy) / 2;
    const map = (x: number, y: number): [number, number] => [(x - crop.x) * sx + dx, (y - crop.y) * sy + dy];

    // conteúdo: leva a origem da área visível para 0,0, escala e centraliza
    // (a última chamada fica por fora, então é aplicada por último no ponto)
    page.translateContent(-crop.x, -crop.y);
    page.scaleContent(sx, sy);
    page.translateContent(dx, dy);

    page.setMediaBox(0, 0, tw, th);
    page.setCropBox(0, 0, tw, th);
    for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) {
      if (page.node.get(PDFName.of(key))) page.node.set(PDFName.of(key), doc.context.obj([0, 0, tw, th]));
    }

    // anotações: mesmas contas nos retângulos e pontos
    const annots = page.node.Annots?.() as Arr | undefined;
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = page.node.context.lookup(annots.get(i)) as { get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => void } | undefined;
      if (!annot || typeof annot.get !== 'function') continue;
      for (const key of ANNOT_POINT_KEYS) {
        const arr = page.node.context.lookup(annot.get(PDFName.of(key))) as Arr | undefined;
        if (!arr || !(arr instanceof PDFArray)) continue;
        const nums = numbers(arr, PDFNumber);
        if (!nums || nums.length % 2 !== 0) continue;
        const out: number[] = [];
        for (let k = 0; k < nums.length; k += 2) out.push(...map(nums[k], nums[k + 1]));
        if (key === 'Rect' && out.length === 4) {
          const [x0, y0, x1, y1] = out;
          annot.set(PDFName.of(key), doc.context.obj([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]));
        } else {
          annot.set(PDFName.of(key), doc.context.obj(out));
        }
      }
      const ink = page.node.context.lookup(annot.get(PDFName.of('InkList'))) as Arr | undefined;
      if (ink && ink instanceof PDFArray) {
        const paths: number[][] = [];
        for (let p = 0; p < ink.size(); p++) {
          const path = page.node.context.lookup(ink.get(p)) as Arr | undefined;
          const nums = path && path instanceof PDFArray ? numbers(path, PDFNumber) : null;
          if (!nums) continue;
          const out: number[] = [];
          for (let k = 0; k + 1 < nums.length; k += 2) out.push(...map(nums[k], nums[k + 1]));
          paths.push(out);
        }
        annot.set(PDFName.of('InkList'), doc.context.obj(paths));
      }
    }
  });

  return doc.save({ useObjectStreams: true });
}

function numbers(arr: Arr, PDFNumber: unknown): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.get(i) as Num;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(v instanceof (PDFNumber as any))) return null;
    out.push(v.asNumber());
  }
  return out;
}
