/**
 * Ligação com o visualizador de PDF (PDF.js) que fica dentro do iframe do leitor.
 * Os dois ficam na mesma origem, então o leitor conversa direto com ele.
 */

export const EDITOR = { NONE: 0, TEXT: 3, HIGHLIGHT: 9, STAMP: 13, DRAW: 15, SIGN: 101 } as const;

/** Parâmetros dos editores (mesmos números do PDF.js). */
export const PARAM = {
  CREATE: 2,
  TEXT_SIZE: 11,
  TEXT_COLOR: 12,
  DRAW_COLOR: 21,
  DRAW_THICKNESS: 22,
  HIGHLIGHT_COLOR: 31,
  HIGHLIGHT_THICKNESS: 32,
} as const;

export interface EditorManager {
  commitOrRemove: () => void;
  undo: () => void;
  redo: () => void;
}

export interface ViewerApp {
  eventBus: {
    dispatch: (name: string, data: Record<string, unknown>) => void;
    _on: (name: string, listener: () => void, options?: { once?: boolean }) => void;
  };
  initializedPromise?: Promise<void>;
  pdfDocument?: { saveDocument: () => Promise<Uint8Array>; numPages: number };
  pdfViewer?: {
    currentPageNumber: number;
    currentScaleValue: string;
    pagesCount: number;
    /** Nesta versão do visualizador o gerenciador de edição só é acessível por aqui. */
    _layerProperties?: { annotationEditorUIManager?: EditorManager | null };
  };
}

/** Gerenciador das edições feitas na tela (desfazer, refazer, confirmar o que está sendo digitado). */
export function editorManager(app: ViewerApp | undefined): EditorManager | undefined {
  return app?.pdfViewer?._layerProperties?.annotationEditorUIManager ?? undefined;
}

export type ViewerWin = Window & { PDFViewerApplication?: ViewerApp };

export interface ViewState {
  page: number;
  scale: string;
}

/** Deixa a assinatura ligada no visualizador (ele só lê isso ao abrir). */
export function ensureViewerPrefs(): void {
  try {
    const raw = window.localStorage.getItem('pdfjs.preferences');
    const prefs: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    delete prefs.annotationEditorMode;
    window.localStorage.setItem(
      'pdfjs.preferences',
      JSON.stringify({ ...prefs, enableSignatureEditor: true, enablePermissions: false })
    );
  } catch {
    /* sem armazenamento: o visualizador usa o padrão */
  }
}

/** Roda `cb` quando as páginas do documento estiverem prontas. */
export function whenPagesReady(app: ViewerApp, cb: () => void): void {
  if ((app.pdfViewer?.pagesCount ?? 0) > 0) {
    cb();
    return;
  }
  app.eventBus._on('pagesinit', cb, { once: true });
}

export function readView(app: ViewerApp | undefined): ViewState {
  return {
    page: app?.pdfViewer?.currentPageNumber ?? 1,
    scale: app?.pdfViewer?.currentScaleValue ?? 'auto',
  };
}

export function restoreView(app: ViewerApp, view: ViewState): void {
  whenPagesReady(app, () => {
    const v = app.pdfViewer;
    if (!v) return;
    v.currentScaleValue = view.scale;
    v.currentPageNumber = Math.max(1, Math.min(view.page, v.pagesCount || 1));
  });
}
