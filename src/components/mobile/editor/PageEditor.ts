/**
 * "Editar PDF" do leitor, no estilo do Acrobat: mostra caixas em volta dos textos e
 * imagens da página; tocar seleciona, arrastar move, tocar de novo no texto edita o
 * próprio texto. Nada é gravado até o Concluído: aí as mudanças viram uma lista de
 * operações para o motor (engine.ts) escrever no arquivo de verdade.
 *
 * Roda na janela do app, mas mexe no documento do visualizador (iframe da mesma origem).
 */
import { analyzePage, type PdfLibLike, type PdfPageLike, type Rect } from './analyze';

interface ViewportLike {
  width: number;
  height: number;
  convertToViewportRectangle: (r: number[]) => number[];
  convertToPdfPoint: (x: number, y: number) => number[];
}

interface PageViewLike {
  id: number;
  div: HTMLElement;
  viewport: ViewportLike;
  pdfPage?: PdfPageLike | null;
}

type Handler = (e: { pageNumber?: number }) => void;

export interface EditorApp {
  eventBus: { _on: (name: string, fn: Handler) => void; _off: (name: string, fn: Handler) => void };
  pdfViewer?: {
    getPageView: (i: number) => PageViewLike | undefined;
    pagesCount: number;
    currentPageNumber: number;
    currentScale: number;
    currentScaleValue: string;
    pagesRotation?: number;
  };
}

export interface EditSelection {
  kind: 'text' | 'image';
  size: number;
  bold: boolean;
  color: string;
  editing: boolean;
}

export interface EditStatus {
  sel: EditSelection | null;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  adding: boolean;
}

interface ElState {
  rect: Rect;
  text: string;
  size: number;
  color: string;
  bold: boolean;
  deleted: boolean;
}

interface El extends ElState {
  id: string;
  kind: 'text' | 'image';
  page: number;
  orig: Rect | null;
  isNew: boolean;
  o: ElState;
  family: 'sans' | 'serif' | 'mono';
  italic: boolean;
  pitch: number;
  /** Texto de uma linha só (título, rótulo): cresce para o lado em vez de quebrar. */
  single: boolean;
  bg: string | null;
  data?: string;
  snapshot?: string;
}

interface Drag {
  el: El;
  mode: 'move' | 'resize' | 'width';
  view: PageViewLike;
  pointerId: number;
  x: number;
  y: number;
  start: Rect;
  moved: boolean;
  wasSelected: boolean;
  box: HTMLElement;
}

const CSS = `
.pc-editing .textLayer,.pc-editing .annotationLayer{pointer-events:none!important}
.pc-layer{position:absolute;inset:0;z-index:40;pointer-events:none}
.pc-box{position:absolute;box-sizing:border-box;pointer-events:auto;outline:1px dashed rgba(124,58,237,.55);outline-offset:1px;border-radius:2px;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}
.pc-box.pc-sel{outline:2px solid #7c3aed;outline-offset:2px;touch-action:none}
.pc-box.pc-i.pc-sel{background:rgba(124,58,237,.10)}
.pc-box.pc-edit{touch-action:auto;-webkit-user-select:text;user-select:text}
.pc-cover{position:absolute;pointer-events:none;z-index:0}
.pc-box{z-index:1}.pc-box.pc-sel{z-index:2}
.pc-txt{white-space:pre-wrap;overflow-wrap:break-word;min-height:100%;outline:none;caret-color:#7c3aed}
.pc-edit .pc-txt{-webkit-user-select:text;user-select:text;cursor:text}
.pc-box img{width:100%;height:100%;display:block;pointer-events:none}
.pc-h{position:absolute;width:26px;height:26px;border-radius:50%;background:#7c3aed;border:3px solid #fff;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.45);pointer-events:auto;touch-action:none}
.pc-hr{right:-15px;bottom:-15px}
.pc-hw{right:-15px;top:50%;margin-top:-13px}
.pc-adding .pc-box{opacity:.55}
`;

const FAMILY = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' } as const;

const same = (a: Rect, b: Rect) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
const copyState = (s: ElState): ElState => ({
  rect: [...s.rect] as Rect,
  text: s.text,
  size: s.size,
  color: s.color,
  bold: s.bold,
  deleted: s.deleted,
});

function normRect(r: number[]): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
}

export class PageEditor {
  private win: Window & { pdfjsLib?: PdfLibLike };
  private doc: Document;
  private app: EditorApp;
  private onStatus: (s: EditStatus) => void;
  private els = new Map<string, El>();
  private analyzed = new Set<number>();
  private analyzing = new Set<number>();
  private layers = new Map<number, HTMLElement>();
  private selectedId: string | null = null;
  private editingId: string | null = null;
  private editStartText = '';
  private adding = false;
  private history: string[] = [];
  private hIndex = 0;
  private newCount = 0;
  /** Imagens novas (data URL), fora do histórico para não duplicar memória. */
  private imageData = new Map<string, string>();
  private drag: Drag | null = null;
  private tap: { x: number; y: number; id: number } | null = null;
  private style: HTMLStyleElement | null = null;
  private container: HTMLElement | null = null;
  private destroyed = false;
  /** Caixa que deve ficar com o foco quando o "clique" do toque chegar (ele tiraria o foco). */
  private focusAfterClick: HTMLElement | null = null;

  constructor(win: Window, app: EditorApp, onStatus: (s: EditStatus) => void) {
    this.win = win as Window & { pdfjsLib?: PdfLibLike };
    this.doc = win.document;
    this.app = app;
    this.onStatus = onStatus;
  }

  // ---------- ciclo de vida ----------

  start(): void {
    const viewer = this.app.pdfViewer;
    if (!viewer) return;
    this.style = this.doc.createElement('style');
    this.style.textContent = CSS;
    this.doc.head.appendChild(this.style);
    this.container = this.doc.getElementById('viewerContainer');
    this.container?.classList.add('pc-editing');
    // zoom fixo: abrir o teclado não pode redesenhar as páginas no meio da edição
    if (!/^[\d.]+$/.test(viewer.currentScaleValue || '')) viewer.currentScaleValue = String(viewer.currentScale);
    this.app.eventBus._on('pagerendered', this.onRendered);
    this.win.addEventListener('keydown', this.onKey, true);
    const c = this.container;
    if (c) {
      c.addEventListener('pointerdown', this.onDown, true);
      c.addEventListener('pointermove', this.onMove, true);
      c.addEventListener('pointerup', this.onUp, true);
      c.addEventListener('pointercancel', this.onCancel, true);
      c.addEventListener('input', this.onInput, true);
      c.addEventListener('click', this.onClick, true);
    }
    this.history = [this.snapshot()];
    this.hIndex = 0;
    for (let i = 0; i < viewer.pagesCount; i++) {
      const v = viewer.getPageView(i);
      if (v?.div?.querySelector('canvas')) this.ensurePage(i);
    }
    this.emit();
  }

  destroy(): void {
    this.destroyed = true;
    this.app.eventBus._off('pagerendered', this.onRendered);
    this.win.removeEventListener('keydown', this.onKey, true);
    const c = this.container;
    if (c) {
      c.removeEventListener('pointerdown', this.onDown, true);
      c.removeEventListener('pointermove', this.onMove, true);
      c.removeEventListener('pointerup', this.onUp, true);
      c.removeEventListener('pointercancel', this.onCancel, true);
      c.removeEventListener('input', this.onInput, true);
      c.removeEventListener('click', this.onClick, true);
      c.classList.remove('pc-editing', 'pc-adding');
    }
    for (const layer of this.layers.values()) layer.remove();
    this.layers.clear();
    this.style?.remove();
  }

  // ---------- comandos da barra ----------

  hasChanges(): boolean {
    for (const el of this.els.values()) if (this.changed(el)) return true;
    return false;
  }

  status(): EditStatus {
    const el = this.selectedId ? this.els.get(this.selectedId) : null;
    return {
      sel: el
        ? { kind: el.kind, size: el.size, bold: el.bold, color: el.color || '#000000', editing: this.editingId === el.id }
        : null,
      canUndo: this.hIndex > 0,
      canRedo: this.hIndex < this.history.length - 1,
      dirty: this.hasChanges(),
      adding: this.adding,
    };
  }

  startAddText(): void {
    this.commitEditing();
    this.select(null);
    this.adding = !this.adding;
    this.container?.classList.toggle('pc-adding', this.adding);
    this.emit();
  }

  addImage(dataUrl: string, width: number, height: number): void {
    this.commitEditing();
    const viewer = this.app.pdfViewer;
    if (!viewer) return;
    const page = Math.max(0, viewer.currentPageNumber - 1);
    const view = viewer.getPageView(page);
    if (!view) return;
    const tl = view.viewport.convertToPdfPoint(0, 0);
    const br = view.viewport.convertToPdfPoint(view.viewport.width, view.viewport.height);
    const pw = Math.abs(br[0] - tl[0]);
    const ph = Math.abs(br[1] - tl[1]);
    let w = Math.min(pw * 0.5, width * 0.75);
    let h = (w * height) / Math.max(1, width);
    if (h > ph * 0.5) {
      h = ph * 0.5;
      w = (h * width) / Math.max(1, height);
    }
    // centro da parte da página que está na tela
    const c = this.container;
    let cx = Math.min(tl[0], br[0]) + pw / 2;
    let cy = Math.min(tl[1], br[1]) + ph / 2;
    if (c) {
      const pr = view.div.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const midY = Math.min(Math.max(cr.top + cr.height / 2, pr.top), pr.bottom) - pr.top;
      const p = view.viewport.convertToPdfPoint(view.viewport.width / 2, midY);
      cx = p[0];
      cy = p[1];
    }
    const rect: Rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    const el = this.newEl('image', page, rect);
    el.data = dataUrl;
    this.imageData.set(el.id, dataUrl);
    this.els.set(el.id, el);
    this.selectedId = el.id;
    this.push();
    this.renderPage(page);
  }

  deleteSelected(): void {
    const el = this.selectedId ? this.els.get(this.selectedId) : null;
    if (!el) return;
    this.editingId = null;
    if (el.isNew) this.els.delete(el.id);
    else {
      this.sample(el);
      el.deleted = true;
    }
    this.selectedId = null;
    this.push();
    this.renderPage(el.page);
  }

  setSize(delta: number): void {
    this.formatSelected((el) => {
      el.size = Math.max(4, Math.min(96, Math.round((el.size + delta) * 2) / 2));
    });
  }

  toggleBold(): void {
    this.formatSelected((el) => {
      el.bold = !el.bold;
    });
  }

  setColor(hex: string): void {
    this.formatSelected((el) => {
      el.color = hex;
    });
  }

  undo(): void {
    if (this.hIndex === 0) return;
    this.endEditingSilently();
    this.hIndex--;
    this.restore(this.history[this.hIndex]);
  }

  redo(): void {
    if (this.hIndex >= this.history.length - 1) return;
    this.endEditingSilently();
    this.hIndex++;
    this.restore(this.history[this.hIndex]);
  }

  /** Termina a digitação em andamento (antes de salvar). */
  commitEditing(): void {
    if (!this.editingId) return;
    const el = this.els.get(this.editingId);
    this.editingId = null;
    if (!el) return;
    if (el.isNew && !el.text.trim()) {
      this.els.delete(el.id);
      if (this.selectedId === el.id) this.selectedId = null;
    }
    if (el.text !== this.editStartText || el.isNew) this.push();
    this.renderPage(el.page);
  }

  /** Lista de operações para o motor gravar no arquivo. */
  getOps(): Record<string, unknown>[] {
    const ops: Record<string, unknown>[] = [];
    for (const el of this.els.values()) {
      if (!this.changed(el)) continue;
      if (el.kind === 'text') {
        if (el.isNew) {
          if (el.deleted || !el.text.trim()) continue;
          ops.push({ kind: 'newtext', page: el.page, rect: el.rect, text: el.text, size: el.size, color: el.color || '#000000', bold: el.bold });
        } else if (el.deleted) {
          ops.push({ kind: 'text', page: el.page, orig: el.orig, deleted: true });
        } else {
          const o = el.orig as Rect;
          ops.push({
            kind: 'text',
            page: el.page,
            orig: o,
            text: el.text,
            changed: el.text !== el.o.text,
            dx: el.rect[0] - o[0],
            dy: el.rect[3] - o[3],
            width: el.rect[2] - el.rect[0],
            resized: Math.abs(el.rect[2] - el.rect[0] - (o[2] - o[0])) > 0.5,
            scale: el.size !== el.o.size ? el.size / el.o.size : null,
            color: el.color && el.color !== el.o.color ? el.color : null,
            bold: el.bold !== el.o.bold ? el.bold : null,
          });
        }
      } else if (el.isNew) {
        if (el.deleted || !el.data) continue;
        ops.push({ kind: 'newimage', page: el.page, rect: el.rect, data: el.data.slice(el.data.indexOf(',') + 1) });
      } else if (el.deleted) {
        ops.push({ kind: 'image', page: el.page, orig: el.orig, deleted: true });
      } else {
        ops.push({ kind: 'image', page: el.page, orig: el.orig, rect: el.rect });
      }
    }
    return ops;
  }

  // ---------- modelo ----------

  private changed(el: El): boolean {
    if (el.isNew) return !el.deleted;
    if (el.deleted) return true;
    return (
      !same(el.rect, el.o.rect) ||
      el.text !== el.o.text ||
      el.size !== el.o.size ||
      el.bold !== el.o.bold ||
      (!!el.color && !!el.o.color && el.color !== el.o.color)
    );
  }

  private newEl(kind: 'text' | 'image', page: number, rect: Rect): El {
    const state: ElState = { rect, text: '', size: 14, color: '#000000', bold: false, deleted: false };
    return {
      ...copyState(state),
      id: 'n' + ++this.newCount,
      kind,
      page,
      orig: null,
      isNew: true,
      o: copyState(state),
      family: 'sans',
      italic: false,
      pitch: 14 * 1.2,
      single: false,
      bg: null,
    };
  }

  private snapshot(): string {
    const st: Record<string, ElState> = {};
    const added: El[] = [];
    for (const el of this.els.values()) {
      if (el.isNew) {
        const { data: _data, snapshot: _snap, ...rest } = el;
        added.push({ ...rest, rect: [...el.rect] as Rect, o: copyState(el.o) });
      }
      else if (this.changed(el)) st[el.id] = copyState(el);
    }
    return JSON.stringify({ st, added, n: this.newCount });
  }

  private restore(snap: string): void {
    const data = JSON.parse(snap) as { st: Record<string, ElState>; added: El[] };
    const pages = new Set<number>();
    for (const el of [...this.els.values()]) {
      if (el.isNew) {
        this.els.delete(el.id);
        pages.add(el.page);
        continue;
      }
      const s = data.st[el.id] || el.o;
      if (data.st[el.id] || this.changed(el)) pages.add(el.page);
      Object.assign(el, copyState(s));
    }
    for (const a of data.added) {
      if (a.kind === 'image') a.data = this.imageData.get(a.id);
      this.els.set(a.id, a);
      pages.add(a.page);
    }
    this.selectedId = null;
    for (const p of pages) this.renderPage(p);
    this.emit();
  }

  private push(): void {
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(this.snapshot());
    this.hIndex = this.history.length - 1;
    this.emit();
  }

  private formatSelected(fn: (el: El) => void): void {
    const el = this.selectedId ? this.els.get(this.selectedId) : null;
    if (!el || el.kind !== 'text') return;
    this.sample(el);
    const editing = this.editingId === el.id;
    if (editing) this.readEditing(el);
    fn(el);
    this.push();
    if (editing) this.applyTextStyle(el);
    else this.renderPage(el.page);
  }

  private emit(): void {
    if (!this.destroyed) this.onStatus(this.status());
  }

  // ---------- páginas ----------

  private view(page: number): PageViewLike | undefined {
    return this.app.pdfViewer?.getPageView(page);
  }

  private onRendered: Handler = (e) => {
    const page = (e.pageNumber || 0) - 1;
    if (page >= 0) this.ensurePage(page);
  };

  private ensurePage(page: number): void {
    if (this.analyzed.has(page)) {
      this.renderPage(page);
      return;
    }
    if (this.analyzing.has(page)) return;
    const view = this.view(page);
    const pdfPage = view?.pdfPage;
    const lib = this.win.pdfjsLib;
    if (!view || !pdfPage || !lib) return;
    this.analyzing.add(page);
    const rotated = (pdfPage.rotate || 0) % 360 !== 0 || (this.app.pdfViewer?.pagesRotation || 0) % 360 !== 0;
    const work = rotated ? Promise.resolve({ texts: [], images: [] }) : analyzePage(pdfPage, lib);
    work
      .then((res) => {
        if (this.destroyed) return;
        res.images.forEach((im, k) => {
          const st: ElState = { rect: im.rect, text: '', size: 0, color: '', bold: false, deleted: false };
          this.els.set(`i${page}_${k}`, {
            ...copyState(st),
            id: `i${page}_${k}`,
            kind: 'image',
            page,
            orig: [...im.rect] as Rect,
            isNew: false,
            o: copyState(st),
            family: 'sans',
            italic: false,
            pitch: 0,
            single: false,
            bg: null,
          });
        });
        res.texts.forEach((t, k) => {
          const st: ElState = { rect: t.rect, text: t.text, size: t.size, color: '', bold: t.bold, deleted: false };
          this.els.set(`t${page}_${k}`, {
            ...copyState(st),
            id: `t${page}_${k}`,
            kind: 'text',
            page,
            orig: [...t.rect] as Rect,
            isNew: false,
            o: copyState(st),
            family: t.family,
            italic: t.italic,
            pitch: t.pitch,
            single: t.lineCount === 1,
            bg: null,
          });
        });
        this.analyzed.add(page);
        this.renderPage(page);
      })
      .catch(() => {
        this.analyzed.add(page);
      })
      .finally(() => this.analyzing.delete(page));
  }

  private pct(view: PageViewLike, r: Rect, pad = 0) {
    const v = normRect(view.viewport.convertToViewportRectangle([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]));
    const W = view.viewport.width || 1;
    const H = view.viewport.height || 1;
    return {
      left: (v.x0 / W) * 100 + '%',
      top: (v.y0 / H) * 100 + '%',
      width: ((v.x1 - v.x0) / W) * 100 + '%',
      height: ((v.y1 - v.y0) / H) * 100 + '%',
    };
  }

  private renderPage(page: number): void {
    if (this.destroyed) return;
    const view = this.view(page);
    if (!view?.div) return;
    let layer = this.layers.get(page);
    if (!layer) {
      layer = this.doc.createElement('div');
      layer.className = 'pc-layer';
      this.layers.set(page, layer);
    }
    if (layer.parentElement !== view.div) view.div.appendChild(layer);
    // durante a digitação, não recria a caixa que está com o teclado (senão ele fecha)
    const editing = this.editingId ? this.els.get(this.editingId) : null;
    const keep = editing && editing.page === page ? layer.querySelector(`.pc-box[data-id="${editing.id}"]`) : null;
    for (const node of Array.from(layer.children)) if (node !== keep) node.remove();
    const items = [...this.els.values()].filter((e) => e.page === page);
    // imagens primeiro (ficam por baixo), depois os textos
    items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'image' ? -1 : 1));
    for (const el of items) this.buildEl(view, layer, el, !!keep && el.id === editing?.id);
  }

  private buildEl(view: PageViewLike, layer: HTMLElement, el: El, coverOnly = false): void {
    const changed = this.changed(el);
    const editing = this.editingId === el.id;
    if (!el.isNew && el.orig && (changed || editing)) {
      this.sample(el);
      const cover = this.doc.createElement('div');
      cover.className = 'pc-cover';
      cover.dataset.cover = el.id;
      Object.assign(cover.style, this.pct(view, el.orig, 0.8));
      cover.style.background = el.bg || '#ffffff';
      layer.appendChild(cover);
    }
    if (el.deleted || coverOnly) return;
    const box = this.doc.createElement('div');
    box.dataset.id = el.id;
    const sel = this.selectedId === el.id;
    box.className = 'pc-box ' + (el.kind === 'text' ? 'pc-t' : 'pc-i') + (sel ? ' pc-sel' : '') + (editing ? ' pc-edit' : '');
    const pos = this.pct(view, el.rect);
    box.style.left = pos.left;
    box.style.top = pos.top;
    box.style.width = pos.width;
    if (el.kind === 'image') {
      box.style.height = pos.height;
      if (changed) {
        const img = this.doc.createElement('img');
        img.alt = '';
        img.src = el.data || el.snapshot || '';
        box.appendChild(img);
      }
      if (sel) {
        const h = this.doc.createElement('div');
        h.className = 'pc-h pc-hr';
        h.dataset.handle = 'resize';
        box.appendChild(h);
      }
    } else {
      const grow = el.single && same([0, 0, el.rect[2] - el.rect[0], 0], [0, 0, (el.orig || el.rect)[2] - (el.orig || el.rect)[0], 0]);
      if (changed || editing) {
        box.style.minHeight = pos.height;
        if (grow) {
          box.style.width = 'auto';
          box.style.minWidth = pos.width;
          box.style.whiteSpace = 'pre';
        }
        const txt = this.doc.createElement('div');
        txt.className = 'pc-txt';
        if (grow) txt.style.whiteSpace = 'pre';
        txt.textContent = el.text;
        box.appendChild(txt);
        this.applyTextStyle(el, txt);
        if (editing) {
          txt.setAttribute('contenteditable', 'plaintext-only');
          if (txt.contentEditable !== 'plaintext-only') txt.setAttribute('contenteditable', 'true');
          txt.spellcheck = false;
        }
      } else {
        box.style.height = pos.height;
      }
      if (sel && !editing) {
        const h = this.doc.createElement('div');
        h.className = 'pc-h pc-hw';
        h.dataset.handle = 'width';
        box.appendChild(h);
      }
    }
    layer.appendChild(box);
  }

  private applyTextStyle(el: El, node?: HTMLElement | null): void {
    const txt =
      node || (this.layers.get(el.page)?.querySelector(`[data-id="${el.id}"] .pc-txt`) as HTMLElement | null);
    if (!txt) return;
    const pitch = el.isNew ? el.size * 1.2 : el.pitch * (el.size / (el.o.size || el.size));
    const lead = Math.max(0, (pitch - el.size * 1.15) / 2);
    txt.style.fontSize = `calc(var(--scale-factor, 1) * ${el.size}px)`;
    txt.style.lineHeight = String(Math.max(1, pitch / el.size));
    txt.style.marginTop = `calc(var(--scale-factor, 1) * ${-lead}px)`;
    txt.style.fontFamily = FAMILY[el.family];
    txt.style.fontWeight = el.bold ? '700' : '400';
    txt.style.fontStyle = el.italic ? 'italic' : 'normal';
    txt.style.color = el.color || '#000000';
  }

  // ---------- cores ----------

  /** Lê da imagem da página a cor do fundo (e a do texto) em volta do elemento. */
  private sample(el: El): void {
    if (el.bg !== null || !el.orig) return;
    el.bg = '#ffffff';
    if (el.kind === 'text' && !el.o.color) {
      el.o.color = '#000000';
      if (!el.color) el.color = '#000000';
    }
    const view = this.view(el.page);
    const canvas = view?.div.querySelector('canvas') as HTMLCanvasElement | null;
    if (!view || !canvas || !canvas.width) return;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const k = canvas.width / (view.viewport.width || canvas.width);
      const v = normRect(view.viewport.convertToViewportRectangle(el.orig));
      const ring = el.kind === 'image' ? 4 : 0;
      const x = Math.max(0, Math.floor((v.x0 - ring) * k));
      const y = Math.max(0, Math.floor((v.y0 - ring) * k));
      const w = Math.min(canvas.width - x, Math.ceil((v.x1 - v.x0 + 2 * ring) * k));
      const h = Math.min(canvas.height - y, Math.ceil((v.y1 - v.y0 + 2 * ring) * k));
      if (w <= 0 || h <= 0) return;
      const data = ctx.getImageData(x, y, w, h).data;
      const inner = ring * k;
      const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          if (ring && px > inner && px < w - inner && py > inner && py < h - inner) continue;
          const i = (py * w + px) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const c = counts.get(key);
          if (c) {
            c.n++;
            c.r += r;
            c.g += g;
            c.b += b;
          } else counts.set(key, { n: 1, r, g, b });
        }
      }
      const list = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
      if (!list.length) return;
      const hex = (c: { n: number; r: number; g: number; b: number }) =>
        '#' + [c.r, c.g, c.b].map((s) => Math.round(s / c.n).toString(16).padStart(2, '0')).join('');
      const bgKey = list[0][0];
      el.bg = hex(list[0][1]);
      if (el.kind === 'text') {
        const dist = (key: number) =>
          Math.abs((key >> 8) - (bgKey >> 8)) + Math.abs(((key >> 4) & 15) - ((bgKey >> 4) & 15)) + Math.abs((key & 15) - (bgKey & 15));
        const far = list.filter(([key, c]) => dist(key) >= 8 && c.n >= 2);
        const pick = far[0] || [...list].sort((a, b) => dist(b[0]) - dist(a[0]))[0];
        if (pick && pick[0] !== bgKey) {
          const color = hex(pick[1]);
          // a cor lida da página é a original (não conta como mudança)
          if (el.color === el.o.color) el.color = color;
          el.o.color = color;
        }
      }
    } catch {
      /* sem leitura da imagem: fica branco/preto */
    }
  }

  private takeSnapshot(el: El): void {
    if (el.snapshot || el.isNew || !el.orig) return;
    const view = this.view(el.page);
    const canvas = view?.div.querySelector('canvas') as HTMLCanvasElement | null;
    if (!view || !canvas) return;
    try {
      const k = canvas.width / (view.viewport.width || canvas.width);
      const v = normRect(view.viewport.convertToViewportRectangle(el.orig));
      const sx = Math.max(0, Math.floor(v.x0 * k));
      const sy = Math.max(0, Math.floor(v.y0 * k));
      const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil((v.x1 - v.x0) * k)));
      const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil((v.y1 - v.y0) * k)));
      const tmp = this.doc.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      tmp.getContext('2d')?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      el.snapshot = tmp.toDataURL('image/png');
    } catch {
      el.snapshot = '';
    }
  }

  // ---------- toque ----------

  private boxOf(target: EventTarget | null): HTMLElement | null {
    const t = target as Element | null;
    return (t && typeof t.closest === 'function' ? t.closest('.pc-box') : null) as HTMLElement | null;
  }

  private pageOf(target: EventTarget | null): number {
    const t = target as Element | null;
    const pageDiv = t && typeof t.closest === 'function' ? (t.closest('.page') as HTMLElement | null) : null;
    const n = Number(pageDiv?.dataset.pageNumber || 0);
    return n - 1;
  }

  /** Teclas fora da caixa de texto não podem virar atalhos do visualizador (girar, trocar de página...). */
  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (!typing) e.stopImmediatePropagation();
  };

  private onDown = (e: PointerEvent) => {
    if (this.drag) {
      // segundo dedo (pinça): desiste de arrastar
      this.cancelDrag();
      return;
    }
    const box = this.boxOf(e.target);
    this.tap = { x: e.clientX, y: e.clientY, id: e.pointerId };
    // no "Adicionar texto", o toque não pode tirar o foco da caixa nova que vai abrir
    if (this.adding && !box) e.preventDefault();
    if (!box) return;
    const el = this.els.get(box.dataset.id || '');
    if (!el) return;
    const handle = (e.target as HTMLElement).dataset?.handle;
    if (this.editingId === el.id && !handle) return; // cursor do texto
    const view = this.view(el.page);
    if (!view) return;
    this.drag = {
      el,
      mode: handle === 'resize' ? 'resize' : handle === 'width' ? 'width' : 'move',
      view,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: [...el.rect] as Rect,
      moved: false,
      wasSelected: this.selectedId === el.id,
      box,
    };
    if (this.drag.wasSelected || handle) {
      try {
        box.setPointerCapture(e.pointerId);
      } catch {
        /* ignora */
      }
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!d.moved && dist < 7) return;
    if (!d.wasSelected) {
      // arrastar uma caixa não selecionada = rolar a página
      this.drag = null;
      return;
    }
    if (!d.moved) {
      d.moved = true;
      this.sample(d.el);
      if (d.el.kind === 'image') this.takeSnapshot(d.el);
    }
    e.preventDefault();
    const pr = d.view.div.getBoundingClientRect();
    const p0 = d.view.viewport.convertToPdfPoint(d.x - pr.left, d.y - pr.top);
    const p1 = d.view.viewport.convertToPdfPoint(e.clientX - pr.left, e.clientY - pr.top);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const s = d.start;
    const el = d.el;
    if (d.mode === 'move') {
      el.rect = [s[0] + dx, s[1] + dy, s[2] + dx, s[3] + dy];
    } else if (d.mode === 'resize') {
      const w0 = s[2] - s[0];
      const h0 = s[3] - s[1];
      const w = Math.max(12, w0 + dx);
      const k = w / w0;
      el.rect = [s[0], s[3] - h0 * k, s[0] + w, s[3]];
    } else {
      const w = Math.max(el.size * 2, s[2] - s[0] + dx);
      el.rect = [s[0], s[1], s[0] + w, s[3]];
    }
    const pos = this.pct(d.view, el.rect);
    d.box.style.left = pos.left;
    d.box.style.top = pos.top;
    d.box.style.width = pos.width;
    if (el.kind === 'image') d.box.style.height = pos.height;
    // na primeira mexida, mostra a "foto" do conteúdo e tampa o lugar antigo
    if (!d.box.dataset.live) {
      d.box.dataset.live = '1';
      this.renderPage(el.page);
      const fresh = this.layers.get(el.page)?.querySelector(`[data-id="${el.id}"]`) as HTMLElement | null;
      if (fresh) {
        d.box = fresh;
        fresh.dataset.live = '1';
        try {
          fresh.setPointerCapture(e.pointerId);
        } catch {
          /* ignora */
        }
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    const tap = this.tap;
    this.tap = null;
    if (d && e.pointerId === d.pointerId) {
      this.drag = null;
      if (d.moved) {
        this.push();
        this.renderPage(d.el.page);
        return;
      }
      // toque numa caixa
      if (this.editingId && this.editingId !== d.el.id) this.commitEditing();
      if (this.adding) {
        this.adding = false;
        this.container?.classList.remove('pc-adding');
      }
      if (!d.wasSelected) this.select(d.el.id);
      else if (d.el.kind === 'text' && this.editingId !== d.el.id) this.startEditing(d.el);
      return;
    }
    if (!tap || tap.id !== e.pointerId || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) return;
    // toque fora das caixas
    if (this.boxOf(e.target)) return;
    const page = this.pageOf(e.target);
    if (this.adding && page >= 0) {
      this.adding = false;
      this.container?.classList.remove('pc-adding');
      this.createTextAt(page, e.clientX, e.clientY);
      return;
    }
    this.commitEditing();
    this.select(null);
  };

  private onClick = () => {
    const txt = this.focusAfterClick;
    this.focusAfterClick = null;
    if (txt && txt.isConnected && this.doc.activeElement !== txt) this.focusEnd(txt);
  };

  private focusEnd(txt: HTMLElement): void {
    txt.focus();
    const sel = this.win.getSelection();
    if (sel) {
      const range = this.doc.createRange();
      range.selectNodeContents(txt);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  private onCancel = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.cancelDrag();
    this.tap = null;
  };

  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (d && d.moved) {
      d.el.rect = d.start;
      this.renderPage(d.el.page);
    }
  }

  private onInput = (e: Event) => {
    const el = this.editingId ? this.els.get(this.editingId) : null;
    if (!el) return;
    const t = e.target as HTMLElement;
    if (!t.classList?.contains('pc-txt')) return;
    this.readEditing(el);
    this.emit();
  };

  private readEditing(el: El): void {
    const txt = this.layers.get(el.page)?.querySelector(`[data-id="${el.id}"] .pc-txt`) as HTMLElement | null;
    if (txt) el.text = (txt.innerText || '').replace(/ /g, ' ').replace(/\n$/, '');
  }

  private select(id: string | null): void {
    const prev = this.selectedId ? this.els.get(this.selectedId) : null;
    this.selectedId = id;
    const el = id ? this.els.get(id) : null;
    if (el) this.sample(el);
    if (prev && prev.page !== el?.page) this.renderPage(prev.page);
    if (el) this.renderPage(el.page);
    this.emit();
  }

  private startEditing(el: El): void {
    this.sample(el);
    this.selectedId = el.id;
    this.editingId = el.id;
    this.editStartText = el.text;
    // recria a página com a caixa já editável
    const layer = this.layers.get(el.page);
    if (layer) layer.textContent = '';
    const view = this.view(el.page);
    if (view && layer) {
      const items = [...this.els.values()].filter((x) => x.page === el.page);
      items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'image' ? -1 : 1));
      for (const x of items) this.buildEl(view, layer, x);
    }
    const txt = layer?.querySelector(`[data-id="${el.id}"] .pc-txt`) as HTMLElement | null;
    if (txt) {
      this.focusEnd(txt);
      this.focusAfterClick = txt;
      this.win.setTimeout(() => {
        if (this.focusAfterClick === txt) this.focusAfterClick = null;
      }, 800);
      this.ensureVisible(txt);
    }
    this.emit();
  }

  private endEditingSilently(): void {
    if (!this.editingId) return;
    const el = this.els.get(this.editingId);
    this.editingId = null;
    if (el) this.readEditing(el);
  }

  private ensureVisible(node: HTMLElement): void {
    const c = this.container;
    if (!c) return;
    const go = () => {
      const br = node.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const target = cr.top + cr.height * 0.18;
      if (br.top < cr.top + 8 || br.top > cr.top + cr.height * 0.45) c.scrollTop += br.top - target;
    };
    go();
    // o teclado demora um pouco para aparecer
    this.win.setTimeout(go, 350);
  }

  private createTextAt(page: number, clientX: number, clientY: number): void {
    const view = this.view(page);
    if (!view) return;
    const pr = view.div.getBoundingClientRect();
    const p = view.viewport.convertToPdfPoint(clientX - pr.left, clientY - pr.top);
    const br = view.viewport.convertToPdfPoint(view.viewport.width, 0);
    const size = 14;
    const width = Math.max(size * 4, Math.min(220, br[0] - p[0] - 6));
    // a caixa nasce com o ponto tocado no meio da primeira linha
    const rect: Rect = [p[0] - 2, p[1] - size * 0.65, p[0] - 2 + width, p[1] + size * 0.65];
    const el = this.newEl('text', page, rect);
    this.els.set(el.id, el);
    this.selectedId = el.id;
    this.startEditing(el);
  }
}
