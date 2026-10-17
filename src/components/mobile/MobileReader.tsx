'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Search, Download, Type, Highlighter, Pencil, PenLine, LayoutGrid, ChevronUp, ChevronDown } from 'lucide-react';
import { withBasePath } from '@/lib/utils/path';
import MoreToolsSheet from './MoreToolsSheet';
import { installPinchZoom } from './pinchZoom';
import { listRecent, loadBlob, saveBytes } from '@/lib/mobile-files';

interface ViewerApp {
  eventBus: { dispatch: (name: string, data: Record<string, unknown>) => void };
  pdfDocument?: { saveDocument: () => Promise<Uint8Array> };
}
type ViewerWin = Window & { PDFViewerApplication?: ViewerApp };

const HIDE_TOOLBAR_CSS =
  '#toolbarContainer,#sidebarContainer,#secondaryToolbar{display:none !important}' +
  '#viewerContainer{inset:0 !important;overscroll-behavior:contain}';

export default function MobileReader({ locale, titles }: { locale: string; titles: Record<string, string> }) {
  const router = useRouter();
  const pt = locale.startsWith('pt');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const urlRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      setError(pt ? 'Nenhum arquivo selecionado.' : 'No file selected.');
      return;
    }
    const doc = listRecent().find((d) => d.id === id);
    loadBlob(id)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setError(pt ? 'Arquivo não encontrado.' : 'File not found.');
          return;
        }
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setName(doc?.name || 'documento.pdf');
        setSrc(withBasePath('/pdfjs-viewer/viewer.html?file=' + encodeURIComponent(url)));
      })
      .catch(() => {
        if (!cancelled) setError(pt ? 'Erro ao abrir o arquivo.' : 'Could not open the file.');
      });
    return () => {
      cancelled = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [pt]);

  const getApp = (): ViewerApp | undefined => {
    const win = iframeRef.current?.contentWindow as ViewerWin | null | undefined;
    return win?.PDFViewerApplication;
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const onLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = HIDE_TOOLBAR_CSS;
    doc.head.appendChild(style);
    const win = iframeRef.current?.contentWindow;
    if (win) installPinchZoom(win, doc);
  };

  const setEditor = (m: number) => {
    const app = getApp();
    if (!app) return;
    const next = mode === m ? 0 : m;
    app.eventBus.dispatch('switchannotationeditormode', { source: app, mode: next });
    setMode(next);
  };

  const find = (query: string, again: boolean, back: boolean) => {
    const app = getApp();
    if (!app) return;
    app.eventBus.dispatch('find', {
      source: app,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: back,
      matchDiacritics: true,
    });
  };

  const save = async () => {
    const app = getApp();
    if (!app?.pdfDocument) return;
    setBusy(true);
    try {
      const bytes = await app.pdfDocument.saveDocument();
      const out = name.replace(/\.pdf$/i, '') + '_editado.pdf';
      const r = await saveBytes(out, bytes);
      if (r === 'saved') flash(pt ? 'Arquivo salvo.' : 'Saved.');
    } catch {
      flash(pt ? 'Não foi possível salvar.' : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const tools = [
    { m: 3, label: pt ? 'Texto' : 'Text', Icon: Type },
    { m: 9, label: pt ? 'Realce' : 'Highlight', Icon: Highlighter },
    { m: 15, label: pt ? 'Desenhar' : 'Draw', Icon: Pencil },
  ];

  return (
    <div className="r-root">
      <header className="r-top">
        <button className="r-btn" aria-label={pt ? 'Voltar' : 'Back'} onClick={() => router.push('/' + locale + '/')}>
          <ArrowLeft />
        </button>
        <div className="r-title">{name}</div>
        <button className="r-btn" aria-label={pt ? 'Buscar' : 'Search'} onClick={() => setSearchOpen(!searchOpen)}>
          <Search />
        </button>
        <button className="r-btn" aria-label={pt ? 'Salvar' : 'Save'} onClick={save} disabled={busy}>
          <Download />
        </button>
      </header>
      {searchOpen && (
        <div className="r-search">
          <input
            autoFocus
            placeholder={pt ? 'Buscar no documento' : 'Search in document'}
            aria-label={pt ? 'Buscar no documento' : 'Search in document'}
            onChange={(e) => find(e.target.value, false, false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find((e.target as HTMLInputElement).value, true, e.shiftKey);
            }}
          />
          <button
            className="r-btn"
            aria-label={pt ? 'Anterior' : 'Previous'}
            onClick={(e) => find((e.currentTarget.parentElement?.querySelector('input')?.value) || '', true, true)}
          >
            <ChevronUp />
          </button>
          <button
            className="r-btn"
            aria-label={pt ? 'Próximo' : 'Next'}
            onClick={(e) => find((e.currentTarget.parentElement?.querySelector('input')?.value) || '', true, false)}
          >
            <ChevronDown />
          </button>
        </div>
      )}
      <div className="r-view">
        {error && <p className="r-msg">{error}</p>}
        {!error && !src && <p className="r-msg">{pt ? 'Abrindo…' : 'Opening…'}</p>}
        {src && <iframe ref={iframeRef} src={src} onLoad={onLoad} className="r-frame" title={name} />}
      </div>
      <nav className="r-bottom" aria-label={pt ? 'Ferramentas de edição' : 'Editing tools'}>
        {tools.map(({ m, label, Icon }) => (
          <button key={m} className="r-tool" aria-pressed={mode === m} onClick={() => setEditor(m)}>
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
        <button className="r-tool" onClick={() => router.push('/' + locale + '/tools/sign-pdf/')}>
          <PenLine aria-hidden="true" />
          {pt ? 'Assinar' : 'Sign'}
        </button>
        <button className="r-tool" onClick={() => setMoreOpen(true)}>
          <LayoutGrid aria-hidden="true" />
          {pt ? 'Mais' : 'More'}
        </button>
      </nav>
      {toast && <div className="r-toast" role="status">{toast}</div>}
      {moreOpen && <MoreToolsSheet locale={locale} titles={titles} onClose={() => setMoreOpen(false)} />}
    </div>
  );
}
