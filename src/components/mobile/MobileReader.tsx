'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Search,
  Download,
  Type,
  Highlighter,
  Pencil,
  PenLine,
  LayoutGrid,
  ChevronUp,
  ChevronDown,
  Undo2,
  Redo2,
  Check,
} from 'lucide-react';
import { withBasePath } from '@/lib/utils/path';
import MoreToolsSheet from './MoreToolsSheet';
import ToolPanel, { IN_APP_TOOLS } from './ToolPanel';
import ToolHost from './ToolHost';
import FormatBar from './FormatBar';
import { installPinchZoom } from './pinchZoom';
import { addRecent, listRecent, loadBlob, saveBytes } from '@/lib/mobile-files';
import { EDITOR, PARAM, editorManager, ensureViewerPrefs, readView, restoreView, whenPagesReady, type ViewerApp, type ViewerWin, type ViewState } from './viewer';

const HIDE_TOOLBAR_CSS =
  '#toolbarContainer,#sidebarContainer,#secondaryToolbar{display:none !important}' +
  '#viewerContainer{inset:0 !important;overscroll-behavior:contain}';

const MAX_UNDO = 10;

/** Ferramentas que o próprio leitor faz direto na página, sem folha. */
const NATIVE_TOOLS = ['sign-pdf', 'add-stamps', 'edit-pdf', 'pdf-reader'];

export default function MobileReader({ locale, titles }: { locale: string; titles: Record<string, string> }) {
  const router = useRouter();
  const pt = locale.startsWith('pt');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const restoreRef = useRef<ViewState | null>(null);
  const startRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [history, setHistory] = useState<Blob[]>([]);
  const [panel, setPanel] = useState<{ id: string; numPages: number; currentPage: number } | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const tool = params.get('tool');
    if (tool) {
      // O endereço não deve reabrir a ferramenta ao recarregar.
      params.delete('tool');
      const rest = params.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? '?' + rest : ''));
    }
    if (!id) {
      setError(pt ? 'Nenhum arquivo selecionado.' : 'No file selected.');
      return;
    }
    const doc = listRecent().find((d) => d.id === id);
    loadBlob(id)
      .then((b) => {
        if (cancelled) return;
        if (!b) {
          setError(pt ? 'Arquivo não encontrado.' : 'File not found.');
          return;
        }
        setName(doc?.name || 'documento.pdf');
        setBlob(b);
        if (tool && NATIVE_TOOLS.includes(tool)) startRef.current = tool;
        else if (tool) setHost(tool);
      })
      .catch(() => {
        if (!cancelled) setError(pt ? 'Erro ao abrir o arquivo.' : 'Could not open the file.');
      });
    return () => {
      cancelled = true;
    };
  }, [pt]);

  useEffect(() => {
    if (!blob) return;
    ensureViewerPrefs();
    const url = URL.createObjectURL(blob);
    setSrc(withBasePath('/pdfjs-viewer/viewer.html?file=' + encodeURIComponent(url)));
    setMode(0);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const getApp = (): ViewerApp | undefined => {
    const win = iframeRef.current?.contentWindow as ViewerWin | null | undefined;
    return win?.PDFViewerApplication;
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  /** O documento como está agora, com o que foi escrito/desenhado na tela. */
  const getBytes = async (): Promise<Uint8Array> => {
    const app = getApp();
    if (app?.pdfDocument) {
      editorManager(app)?.commitOrRemove();
      return app.pdfDocument.saveDocument();
    }
    return new Uint8Array(await (blob as Blob).arrayBuffer());
  };

  const getFile = async (): Promise<File | null> => {
    if (!blob) return null;
    const bytes = await getBytes();
    return new File([bytes as unknown as BlobPart], name || 'documento.pdf', { type: 'application/pdf' });
  };

  const openPanel = (id: string) => {
    const app = getApp();
    setMoreOpen(false);
    setPanel({ id, numPages: app?.pdfDocument?.numPages ?? 1, currentPage: app?.pdfViewer?.currentPageNumber ?? 1 });
  };

  /** Troca o documento pelo resultado e guarda a versão anterior para o Desfazer. */
  const onResult = (next: Blob, before: Uint8Array) => {
    restoreRef.current = readView(getApp());
    setHistory((h) => [...h.slice(-(MAX_UNDO - 1)), new Blob([before as unknown as BlobPart], { type: 'application/pdf' })]);
    setBlob(next);
    setPanel(null);
    setHost(null);
    flash(pt ? 'Alteração aplicada.' : 'Change applied.');
  };

  const applyFromTool = async (next: Blob) => {
    try {
      onResult(next, await getBytes());
    } catch {
      flash(pt ? 'Não foi possível aplicar.' : 'Could not apply.');
    }
  };

  const openCopy = async (next: Blob, fileName: string) => {
    try {
      const file = new File([next], fileName, { type: 'application/pdf' });
      const doc = await addRecent(file);
      setHost(null);
      setPanel(null);
      setHistory([]);
      setName(doc.name);
      setBlob(file);
      flash(pt ? 'Aberto no leitor.' : 'Opened in the reader.');
    } catch {
      flash(pt ? 'Não foi possível abrir.' : 'Could not open.');
    }
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    restoreRef.current = readView(getApp());
    setHistory((h) => h.slice(0, -1));
    setBlob(prev);
  };

  const onLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = HIDE_TOOLBAR_CSS;
    doc.head.appendChild(style);
    const win = iframeRef.current?.contentWindow;
    if (win) installPinchZoom(win, doc);
    const view = restoreRef.current;
    restoreRef.current = null;
    const app = getApp();
    if (view && app) {
      const go = () => restoreView(app, view);
      if (app.initializedPromise) app.initializedPromise.then(go, go);
      else go();
    }
    const first = startRef.current;
    if (first && app) {
      startRef.current = null;
      const go = () => whenPagesReady(app, () => openTool(first));
      if (app.initializedPromise) app.initializedPromise.then(go, go);
      else go();
    }
  };

  const selectMode = (m: number) => {
    const app = getApp();
    if (!app) return;
    app.eventBus.dispatch('switchannotationeditormode', { source: app, mode: m });
    setMode(m);
  };

  /** Entra no modo e já abre a janela de criação (assinatura, imagem). */
  const startCreating = (m: number) => {
    const app = getApp();
    if (!app) return;
    if (mode !== m) selectMode(m);
    window.setTimeout(
      () => app.eventBus.dispatch('switchannotationeditorparams', { source: app, type: PARAM.CREATE, value: '' }),
      150
    );
  };

  const toggleMode = (m: number) => selectMode(mode === m ? EDITOR.NONE : m);

  /** Abre uma ferramenta: as do próprio leitor agem direto no documento, o resto abre numa folha. */
  const openTool = (id: string) => {
    setMoreOpen(false);
    if (id === 'sign-pdf') return startCreating(EDITOR.SIGN);
    if (id === 'add-stamps') return startCreating(EDITOR.STAMP);
    if (id === 'edit-pdf') return selectMode(EDITOR.TEXT);
    if (id === 'pdf-reader') return;
    if (IN_APP_TOOLS.includes(id)) return openPanel(id);
    setHost(id);
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
      const bytes = await getBytes();
      const out = name.replace(/\.pdf$/i, '') + '_editado.pdf';
      const r = await saveBytes(out, bytes);
      if (r === 'saved') flash(pt ? 'Arquivo salvo.' : 'Saved.');
    } catch {
      flash(pt ? 'Não foi possível salvar.' : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const editing = mode !== EDITOR.NONE;
  const editorUI = () => editorManager(getApp());

  const tools = [
    { m: EDITOR.TEXT, label: pt ? 'Texto' : 'Text', Icon: Type },
    { m: EDITOR.HIGHLIGHT, label: pt ? 'Realce' : 'Highlight', Icon: Highlighter },
    { m: EDITOR.DRAW, label: pt ? 'Desenhar' : 'Draw', Icon: Pencil },
  ];

  return (
    <div className="r-root">
      {editing ? (
        <header className="r-top r-top-edit">
          <button className="r-done" onClick={() => selectMode(EDITOR.NONE)}>
            <Check aria-hidden="true" />
            {pt ? 'Concluído' : 'Done'}
          </button>
          <span className="r-grow" />
          <button className="r-btn" aria-label={pt ? 'Desfazer' : 'Undo'} onClick={() => editorUI()?.undo()}>
            <Undo2 />
          </button>
          <button className="r-btn" aria-label={pt ? 'Refazer' : 'Redo'} onClick={() => editorUI()?.redo()}>
            <Redo2 />
          </button>
        </header>
      ) : (
        <header className="r-top">
          <button className="r-btn" aria-label={pt ? 'Voltar' : 'Back'} onClick={() => router.push('/' + locale + '/')}>
            <ArrowLeft />
          </button>
          <div className="r-title">{name}</div>
          {history.length > 0 && (
            <button className="r-btn" aria-label={pt ? 'Desfazer alteração' : 'Undo change'} onClick={undo}>
              <Undo2 />
            </button>
          )}
          <button className="r-btn" aria-label={pt ? 'Buscar' : 'Search'} onClick={() => setSearchOpen(!searchOpen)}>
            <Search />
          </button>
          <button className="r-btn" aria-label={pt ? 'Salvar' : 'Save'} onClick={save} disabled={busy}>
            <Download />
          </button>
        </header>
      )}
      {searchOpen && !editing && (
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
        {!error && !src && !host && <p className="r-msg">{pt ? 'Abrindo…' : 'Opening…'}</p>}
        {src && <iframe ref={iframeRef} src={src} onLoad={onLoad} className="r-frame" title={name} />}
      </div>
      {editing && <FormatBar mode={mode} pt={pt} getApp={getApp} />}
      <nav className="r-bottom" aria-label={pt ? 'Ferramentas de edição' : 'Editing tools'}>
        {tools.map(({ m, label, Icon }) => (
          <button key={m} className="r-tool" aria-pressed={mode === m} onClick={() => toggleMode(m)} disabled={!src}>
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
        <button className="r-tool" aria-pressed={mode === EDITOR.SIGN} onClick={() => startCreating(EDITOR.SIGN)} disabled={!src}>
          <PenLine aria-hidden="true" />
          {pt ? 'Assinar' : 'Sign'}
        </button>
        <button className="r-tool" onClick={() => setMoreOpen(true)}>
          <LayoutGrid aria-hidden="true" />
          {pt ? 'Mais' : 'More'}
        </button>
      </nav>
      {toast && <div className="r-toast" role="status">{toast}</div>}
      {moreOpen && (
        <MoreToolsSheet locale={locale} titles={titles} featured={IN_APP_TOOLS} onPick={openTool} onClose={() => setMoreOpen(false)} />
      )}
      {panel && (
        <ToolPanel
          key={panel.id}
          toolId={panel.id}
          title={titles[panel.id] || panel.id}
          locale={locale}
          env={{ numPages: panel.numPages, currentPage: panel.currentPage, fileName: name || 'documento.pdf', getBytes, onResult }}
          onClose={() => setPanel(null)}
        />
      )}
      {host && (
        <ToolHost
          key={host}
          toolId={host}
          title={titles[host] || host}
          locale={locale}
          env={{ getFile, onApply: applyFromTool, onOpenCopy: openCopy }}
          onClose={() => setHost(null)}
        />
      )}
    </div>
  );
}
