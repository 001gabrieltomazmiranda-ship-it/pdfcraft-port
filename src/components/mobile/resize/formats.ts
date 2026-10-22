/**
 * Formatos e unidades da ferramenta Redimensionar.
 * Tudo é convertido para pontos do PDF (1 pol. = 72 pt). Pixels usam 96 por polegada,
 * como nas telas e nos editores de imagem (1 px = 0,75 pt).
 */

export type Unit = 'px' | 'in' | 'mm' | 'cm';

export const UNITS: { id: Unit; pt: string; en: string; full: { pt: string; en: string } }[] = [
  { id: 'px', pt: 'px', en: 'px', full: { pt: 'Pixels', en: 'Pixels' } },
  { id: 'in', pt: 'pol.', en: 'in', full: { pt: 'Polegadas', en: 'Inches' } },
  { id: 'mm', pt: 'mm', en: 'mm', full: { pt: 'Milímetros', en: 'Millimeters' } },
  { id: 'cm', pt: 'cm', en: 'cm', full: { pt: 'Centímetros', en: 'Centimeters' } },
];

/** Pontos do PDF em 1 unidade. */
export const PT_PER: Record<Unit, number> = { px: 0.75, in: 72, mm: 72 / 25.4, cm: 720 / 25.4 };

/** Casas decimais mostradas em cada unidade. */
export const DECIMALS: Record<Unit, number> = { px: 0, in: 2, mm: 1, cm: 2 };

/** Limites do PDF: de 1/4 de polegada até 200 polegadas (5,08 m). */
export const MIN_PT = 18;
export const MAX_PT = 14400;

export function toPt(v: number, unit: Unit): number {
  return v * PT_PER[unit];
}

export function fromPt(pt: number, unit: Unit): number {
  const f = Math.pow(10, DECIMALS[unit]);
  return Math.round((pt / PT_PER[unit]) * f) / f;
}

export function unitLabel(unit: Unit, pt: boolean): string {
  const u = UNITS.find((x) => x.id === unit)!;
  return pt ? u.pt : u.en;
}

/** Número para mostrar (vírgula no português, sem zeros sobrando). */
export function fmtNum(v: number, unit: Unit, pt: boolean): string {
  const f = Math.pow(10, DECIMALS[unit]);
  const r = Math.round(v * f) / f;
  const s = String(r);
  return pt ? s.replace('.', ',') : s;
}

export function fmtSize(w: number, h: number, unit: Unit, pt: boolean): string {
  return `${fmtNum(w, unit, pt)} × ${fmtNum(h, unit, pt)} ${unitLabel(unit, pt)}`;
}

/** Lê o que a pessoa digitou ("27,5" ou "27.5"). NaN se não for número. */
export function parseNum(text: string): number {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return NaN;
  return parseFloat(t);
}

export interface Format {
  id: string;
  name: { pt: string; en: string };
  w: number;
  h: number;
  unit: Unit;
  /** Categoria (para a busca e a lista "Ver tudo"). */
  cat: CategoryId;
}

export type CategoryId =
  | 'social'
  | 'print'
  | 'slides'
  | 'video'
  | 'site'
  | 'whiteboard'
  | 'docs'
  | 'cards'
  | 'photos'
  | 'books'
  | 'posters';

export interface Category {
  id: CategoryId;
  name: { pt: string; en: string };
  /** Categoria com um único formato (aparece com caixa de seleção, sem seta). */
  single?: boolean;
  /** Fica dentro de "Mais". */
  more?: boolean;
}

export const CATEGORIES: Category[] = [
  { id: 'social', name: { pt: 'Redes sociais', en: 'Social media' } },
  { id: 'print', name: { pt: 'Impressão', en: 'Print' } },
  { id: 'slides', name: { pt: 'Apresentações', en: 'Presentations' } },
  { id: 'video', name: { pt: 'Vídeos', en: 'Videos' } },
  { id: 'site', name: { pt: 'Site', en: 'Website' }, single: true },
  { id: 'whiteboard', name: { pt: 'Quadro branco', en: 'Whiteboard' }, single: true },
  { id: 'docs', name: { pt: 'Documentos', en: 'Documents' }, more: true },
  { id: 'cards', name: { pt: 'Cartões e convites', en: 'Cards and invitations' }, more: true },
  { id: 'photos', name: { pt: 'Fotos', en: 'Photos' }, more: true },
  { id: 'books', name: { pt: 'Livros e apostilas', en: 'Books' }, more: true },
  { id: 'posters', name: { pt: 'Cartazes e banners', en: 'Posters and banners' }, more: true },
];

const f = (id: string, pt: string, en: string, w: number, h: number, unit: Unit, cat: CategoryId): Format => ({
  id,
  name: { pt, en },
  w,
  h,
  unit,
  cat,
});

export const FORMATS: Format[] = [
  // Redes sociais
  f('ig-story', 'Story do Instagram', 'Instagram Story', 1080, 1920, 'px', 'social'),
  f('ig-post', 'Post para Instagram', 'Instagram Post', 1080, 1350, 'px', 'social'),
  f('ig-square', 'Post quadrado para Instagram', 'Instagram Square Post', 1080, 1080, 'px', 'social'),
  f('fb-post', 'Post para Facebook', 'Facebook Post', 940, 788, 'px', 'social'),
  f('fb-cover', 'Capa do Facebook', 'Facebook Cover', 1640, 924, 'px', 'social'),
  f('wa-status', 'Status do WhatsApp', 'WhatsApp Status', 1080, 1920, 'px', 'social'),
  f('tiktok', 'Vídeo do TikTok', 'TikTok Video', 1080, 1920, 'px', 'social'),
  f('yt-thumb', 'Miniatura do YouTube', 'YouTube Thumbnail', 1280, 720, 'px', 'social'),
  f('pinterest', 'Pin do Pinterest', 'Pinterest Pin', 1000, 1500, 'px', 'social'),
  f('linkedin', 'Post do LinkedIn', 'LinkedIn Post', 1200, 1200, 'px', 'social'),
  f('x-post', 'Post do X (Twitter)', 'X (Twitter) Post', 1600, 900, 'px', 'social'),
  // Impressão
  f('a4', 'A4', 'A4', 210, 297, 'mm', 'print'),
  f('a5', 'A5', 'A5', 148, 210, 'mm', 'print'),
  f('a3', 'A3', 'A3', 297, 420, 'mm', 'print'),
  f('a6', 'A6', 'A6', 105, 148, 'mm', 'print'),
  f('letter', 'Carta', 'Letter', 8.5, 11, 'in', 'print'),
  f('legal', 'Ofício (Legal)', 'Legal', 8.5, 14, 'in', 'print'),
  f('oficio2', 'Ofício 2', 'Folio (Ofício 2)', 216, 330, 'mm', 'print'),
  f('flyer', 'Panfleto', 'Flyer', 148, 210, 'mm', 'print'),
  f('envelope-dl', 'Envelope DL', 'DL Envelope', 110, 220, 'mm', 'print'),
  // Apresentações
  f('slide-169', 'Apresentação (16:9)', 'Presentation (16:9)', 1920, 1080, 'px', 'slides'),
  f('slide-43', 'Apresentação (4:3)', 'Presentation (4:3)', 1024, 768, 'px', 'slides'),
  f('slide-a4', 'Apresentação A4 (paisagem)', 'A4 Presentation (landscape)', 297, 210, 'mm', 'slides'),
  // Vídeos
  f('video', 'Vídeo', 'Video', 1920, 1080, 'px', 'video'),
  f('video-vertical', 'Vídeo vertical', 'Vertical video', 1080, 1920, 'px', 'video'),
  f('video-square', 'Vídeo quadrado', 'Square video', 1080, 1080, 'px', 'video'),
  // Site e quadro branco (um formato cada)
  f('site', 'Site', 'Website', 1366, 768, 'px', 'site'),
  f('whiteboard', 'Quadro branco', 'Whiteboard', 4000, 2250, 'px', 'whiteboard'),
  // Mais
  f('doc-a4', 'Documento A4', 'A4 Document', 210, 297, 'mm', 'docs'),
  f('doc-letter', 'Documento Carta', 'Letter Document', 8.5, 11, 'in', 'docs'),
  f('doc-oficio', 'Documento Ofício 2', 'Folio Document', 216, 330, 'mm', 'docs'),
  f('business-card', 'Cartão de visita', 'Business card', 9, 5, 'cm', 'cards'),
  f('invitation', 'Convite', 'Invitation', 5, 7, 'in', 'cards'),
  f('postcard', 'Cartão postal', 'Postcard', 4, 6, 'in', 'cards'),
  f('photo-10x15', 'Foto 10 × 15', 'Photo 10 × 15', 10, 15, 'cm', 'photos'),
  f('photo-13x18', 'Foto 13 × 18', 'Photo 13 × 18', 13, 18, 'cm', 'photos'),
  f('photo-15x21', 'Foto 15 × 21', 'Photo 15 × 21', 15, 21, 'cm', 'photos'),
  f('photo-20x25', 'Foto 20 × 25', 'Photo 20 × 25', 20, 25, 'cm', 'photos'),
  f('book-14x21', 'Livro 14 × 21', 'Book 14 × 21', 14, 21, 'cm', 'books'),
  f('book-16x23', 'Livro 16 × 23', 'Book 16 × 23', 16, 23, 'cm', 'books'),
  f('handout-a5', 'Apostila A5', 'A5 Handout', 148, 210, 'mm', 'books'),
  f('poster-a2', 'Cartaz A2', 'A2 Poster', 420, 594, 'mm', 'posters'),
  f('poster-a1', 'Cartaz A1', 'A1 Poster', 594, 841, 'mm', 'posters'),
  f('banner', 'Banner 60 × 90', 'Banner 60 × 90', 60, 90, 'cm', 'posters'),
];

/** Sugestões mostradas em cartões (depois do "Personalizado" = tamanho atual). */
export const SUGGESTED = ['ig-story', 'ig-post', 'a4', 'slide-169'];

/** Tira acentos e deixa minúsculo, para a busca. */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Texto em que a busca procura: nome, categoria e medidas em vários jeitos. */
export function searchText(fm: Format): string {
  const cat = CATEGORIES.find((c) => c.id === fm.cat);
  const dims = [`${fm.w}x${fm.h}`, `${fm.w} x ${fm.h}`, `${fm.w}`, `${fm.h}`, String(fm.w).replace('.', ','), String(fm.h).replace('.', ',')];
  return norm([fm.name.pt, fm.name.en, cat?.name.pt, cat?.name.en, fm.unit, fm.unit === 'in' ? 'pol polegadas' : '', ...dims].join(' '));
}

export function searchFormats(query: string): Format[] {
  const q = norm(query).replace(/×/g, 'x').trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  return FORMATS.filter((fm) => {
    const hay = searchText(fm).replace(/×/g, 'x');
    return tokens.every((t) => hay.includes(t));
  });
}

/** "200x300 mm", "1080 × 1920 px", "8,5x11 pol" → medida digitada na busca. */
export function parseSizeQuery(query: string): { w: number; h: number; unit: Unit } | null {
  const q = norm(query).replace(/×/g, 'x').replace(/,/g, '.');
  const m = q.match(/^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(px|mm|cm|in|pol\.?|polegadas?)?\s*$/);
  if (!m) return null;
  const raw = m[3] || 'mm';
  const unit: Unit = raw.startsWith('pol') || raw === 'in' ? 'in' : (raw as Unit);
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0 && h > 0)) return null;
  return { w, h, unit };
}
