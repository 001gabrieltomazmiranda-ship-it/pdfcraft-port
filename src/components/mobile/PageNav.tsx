'use client';

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useBackClose } from './backStack';

/**
 * Navegação entre páginas do leitor, nos dois modos de exibição:
 *  - Contínua: as páginas rolam uma embaixo da outra; na borda direita aparece o
 *    marcador com o número da página (arraste para correr pelas páginas, toque para
 *    escolher a página).
 *  - Página por página: uma página de cada vez, do tamanho da tela; deslize para o
 *    lado para trocar; bolinhas embaixo mostram onde você está.
 */

export type ViewMode = 'continuous' | 'page';

const MODE_KEY = 'pdfcraft_view_mode';
const SCROLL_VERTICAL = 0;
const SCROLL_PAGE = 3;

export function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'page' ? 'page' : 'continuous';
  } catch {
    return 'continuous';
  }
}

export function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* sem armazenamento: vale só agora */
  }
}

type Handler = (e: { pageNumber?: number }) => void;

interface NavViewer {
  pagesCount: number;
  currentPageNumber: number;
  scrollMode: number;
  currentScaleValue: string;
  nextPage: () => boolean;
  previousPage: () => boolean;
}

export interface NavApp {
  eventBus: { _on: (n: string, f: Handler) => void; _off: (n: string, f: Handler) => void };
  pdfViewer?: NavViewer;
}

const SLIDE_CSS = `
#viewerContainer.pc-pagemode .pdfViewer{min-height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center}
#viewerContainer.pc-next .page{animation:pc-in-r .24s ease-out}
#viewerContainer.pc-prev .page{animation:pc-in-l .24s ease-out}
@keyframes pc-in-r{from{transform:translateX(16%);opacity:.35}to{transform:none;opacity:1}}
@keyframes pc-in-l{from{transform:translateX(-16%);opacity:.35}to{transform:none;opacity:1}}
`;

function GotoSheet({
  pt,
  page,
  count,
  onGo,
  onClose,
}: {
  pt: boolean;
  page: number;
  count: number;
  onGo: (n: number) => void;
  onClose: () => void;
}) {
  useBackClose(onClose);
  const [text, setText] = useState(String(page));
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= 1 && n <= count;
  return (
    <div className="rs-back" onClick={onClose}>
      <form
        className="rs-sheet rs-menu pn-goto"
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Ir para a página' : 'Go to page'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onGo(n);
        }}
      >
        <div className="rs-grip" aria-hidden="true" />
        <h2 className="rs-title">{pt ? 'Ir para a página' : 'Go to page'}</h2>
        <div className="pn-goto-row">
          <input
            autoFocus
            inputMode="numeric"
            value={text}
            onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
            onFocus={(e) => e.target.select()}
            aria-label={pt ? 'Número da página' : 'Page number'}
          />
          <span>
            {pt ? 'de' : 'of'} {count}
          </span>
          <button type="submit" className="rs-btn" disabled={!ok}>
            {pt ? 'Ir' : 'Go'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function PageNav({
  src,
  mode,
  pt,
  swipeOff,
  getApp,
  getDoc,
}: {
  /** Muda quando outro arquivo/versão é carregado. */
  src: string | null;
  mode: ViewMode;
  pt: boolean;
  /** Desliga o deslizar (desenhando, editando...). */
  swipeOff: boolean;
  getApp: () => NavApp | undefined;
  getDoc: () => Document | null | undefined;
}) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [frac, setFrac] = useState(0);
  const [show, setShow] = useState(false);
  const [drag, setDrag] = useState(false);
  const [goto, setGoto] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeOffRef = useRef(swipeOff);
  swipeOffRef.current = swipeOff;
  const dragRef = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const lastModeRef = useRef<ViewMode | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cleanup: (() => void) | null = null;

    const attach = () => {
      if (cancelled) return;
      const app = getApp();
      const doc = getDoc();
      const viewer = app?.pdfViewer;
      const container = doc?.getElementById('viewerContainer') || null;
      if (!app || !viewer || !container || !(viewer.pagesCount > 0)) {
        retry = setTimeout(attach, 300);
        return;
      }
      containerRef.current = container;
      if (!doc!.getElementById('pc-slide-css')) {
        const st = doc!.createElement('style');
        st.id = 'pc-slide-css';
        st.textContent = SLIDE_CSS;
        doc!.head.appendChild(st);
      }

      const applyMode = (fresh: boolean) => {
        try {
          container.classList.toggle('pc-pagemode', mode === 'page');
          if (mode === 'page') {
            if (viewer.scrollMode !== SCROLL_PAGE) viewer.scrollMode = SCROLL_PAGE;
            if (fresh || lastModeRef.current !== 'page') viewer.currentScaleValue = 'page-fit';
          } else {
            if (viewer.scrollMode !== SCROLL_VERTICAL) viewer.scrollMode = SCROLL_VERTICAL;
            if (lastModeRef.current === 'page') viewer.currentScaleValue = 'auto';
          }
        } catch {
          /* visualizador ainda montando */
        }
        lastModeRef.current = mode;
      };
      applyMode(false);
      setCount(viewer.pagesCount);
      setPage(viewer.currentPageNumber || 1);

      const onPage: Handler = (e) => setPage(e.pageNumber || viewer.currentPageNumber);
      // o visualizador pode restaurar o jeito salvo dele depois de abrir: reaplica o nosso
      const onLoaded: Handler = () => applyMode(true);
      app.eventBus._on('pagechanging', onPage);
      app.eventBus._on('pagesloaded', onLoaded);

      const onScroll = () => {
        if (mode !== 'continuous') return;
        const max = container.scrollHeight - container.clientHeight;
        setFrac(max > 0 ? Math.min(1, Math.max(0, container.scrollTop / max)) : 0);
        setShow(true);
        if (hideRef.current) clearTimeout(hideRef.current);
        hideRef.current = setTimeout(() => {
          if (!dragRef.current) setShow(false);
        }, 1600);
      };
      container.addEventListener('scroll', onScroll, { passive: true });

      // deslizar para o lado (modo página por página)
      let sx = 0;
      let sy = 0;
      let st = 0;
      let multi = false;
      const onStart = (e: TouchEvent) => {
        multi = e.touches.length > 1;
        if (e.touches.length === 1) {
          sx = e.touches[0].clientX;
          sy = e.touches[0].clientY;
          st = Date.now();
        }
      };
      const onEnd = (e: TouchEvent) => {
        if (mode !== 'page' || swipeOffRef.current || multi || e.touches.length > 0) {
          if (e.touches.length === 0) multi = false;
          return;
        }
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (Math.abs(dx) < 50 || Math.abs(dx) < 1.4 * Math.abs(dy) || Date.now() - st > 800) return;
        // com zoom, primeiro rola a página até a borda
        const maxX = container.scrollWidth - container.clientWidth;
        if (maxX > 4) {
          if (dx < 0 && container.scrollLeft < maxX - 4) return;
          if (dx > 0 && container.scrollLeft > 4) return;
        }
        const next = dx < 0;
        const moved = next ? viewer.nextPage() : viewer.previousPage();
        if (moved) {
          container.classList.remove('pc-next', 'pc-prev');
          void container.offsetWidth;
          container.classList.add(next ? 'pc-next' : 'pc-prev');
          setTimeout(() => container.classList.remove('pc-next', 'pc-prev'), 300);
        }
      };
      container.addEventListener('touchstart', onStart, { passive: true });
      container.addEventListener('touchend', onEnd, { passive: true });

      cleanup = () => {
        app.eventBus._off('pagechanging', onPage);
        app.eventBus._off('pagesloaded', onLoaded);
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('touchstart', onStart);
        container.removeEventListener('touchend', onEnd);
      };
    };
    attach();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, mode]);

  const goTo = (n: number) => {
    const viewer = getApp()?.pdfViewer;
    if (viewer) viewer.currentPageNumber = Math.max(1, Math.min(n, viewer.pagesCount));
  };

  // ---------- marcador lateral (contínua) ----------
  const scrollTo = (clientY: number, box: DOMRect) => {
    const c = containerRef.current;
    if (!c) return;
    const pill = 44;
    const f = Math.min(1, Math.max(0, (clientY - box.top - pill / 2) / Math.max(1, box.height - pill)));
    c.scrollTop = f * (c.scrollHeight - c.clientHeight);
    setFrac(f);
  };

  const onPillDown = (e: RPointerEvent<HTMLButtonElement>) => {
    dragRef.current = { id: e.pointerId, y: e.clientY, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignora */
    }
    setShow(true);
  };
  const onPillMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 6) return;
    d.moved = true;
    setDrag(true);
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (box) scrollTo(e.clientY, box);
  };
  const onPillUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(false);
    if (d && !d.moved) setGoto(true);
    if (hideRef.current) clearTimeout(hideRef.current);
    hideRef.current = setTimeout(() => setShow(false), 1600);
    void e;
  };

  if (count < 2) return null;

  return (
    <>
      {mode === 'continuous' && (
        <div className="pn-track" aria-hidden={!show && !drag}>
          <button
            type="button"
            className={'pn-pill' + (show || drag ? ' show' : '') + (drag ? ' drag' : '')}
            style={{ top: `calc(${frac} * (100% - 44px))` }}
            aria-label={(pt ? `Página ${page} de ${count}. Arraste para navegar ou toque para escolher.` : `Page ${page} of ${count}. Drag to move or tap to choose.`)}
            onPointerDown={onPillDown}
            onPointerMove={onPillMove}
            onPointerUp={onPillUp}
            onPointerCancel={onPillUp}
          >
            {drag ? `${page} / ${count}` : page}
          </button>
        </div>
      )}
      {mode === 'page' && (
        <div className="pn-dots" role="group" aria-label={pt ? 'Páginas' : 'Pages'}>
          {count <= 12 ? (
            Array.from({ length: count }, (_, i) => (
              <button
                key={i}
                type="button"
                className={'pn-dot' + (i + 1 === page ? ' on' : '')}
                aria-label={(pt ? 'Página ' : 'Page ') + (i + 1)}
                aria-current={i + 1 === page ? 'page' : undefined}
                onClick={() => goTo(i + 1)}
              />
            ))
          ) : (
            <button type="button" className="pn-count" onClick={() => setGoto(true)}>
              {page} / {count}
            </button>
          )}
        </div>
      )}
      {goto && (
        <GotoSheet
          pt={pt}
          page={page}
          count={count}
          onGo={(n) => {
            setGoto(false);
            goTo(n);
          }}
          onClose={() => setGoto(false)}
        />
      )}
    </>
  );
}
