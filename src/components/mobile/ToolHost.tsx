'use client';

import { Component, useEffect, useMemo, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ToolProvider } from '@/lib/contexts/ToolContext';
import { ToolBridgeProvider, type ToolBridge } from '@/lib/contexts/ToolBridgeContext';
import { getToolById } from '@/config/tools';
import { TOOL_LOADERS } from './tool-registry';
import { useBackClose } from './backStack';

/** O que o leitor oferece às ferramentas que rodam por cima do documento. */
export interface ToolHostEnv {
  /** Documento aberto, já com as edições feitas na tela. `null` quando não há documento. */
  getFile: () => Promise<File | null>;
  /** Troca o documento pelo resultado. */
  onApply: (blob: Blob, name?: string) => void;
  /** Abre o resultado como outro documento. */
  onOpenCopy: (blob: Blob, name: string) => void;
}

class Guard extends Component<{ message: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Tool crashed:', error, info.componentStack);
  }
  render() {
    if (this.state.failed) return <p className="tp-err" role="alert">{this.props.message}</p>;
    return this.props.children;
  }
}

interface Ready {
  Tool: ComponentType;
  file: File | null;
}

/**
 * Abre qualquer ferramenta do app numa folha por cima do leitor, como o
 * Acrobat faz: o PDF aberto já entra na ferramenta e o resultado volta para
 * o documento com um toque.
 */
export default function ToolHost({
  toolId,
  title,
  locale,
  env,
  onClose,
}: {
  toolId: string;
  title: string;
  locale: string;
  env: ToolHostEnv;
  onClose: () => void;
}) {
  const pt = locale.startsWith('pt');
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taken = useRef(false);
  const envRef = useRef(env);
  envRef.current = env;
  useBackClose(onClose);

  useEffect(() => {
    let off = false;
    const load = TOOL_LOADERS[toolId];
    if (!load) {
      setError(pt ? 'Ferramenta indisponível.' : 'Tool unavailable.');
      return;
    }
    Promise.all([load(), envRef.current.getFile()])
      .then(([Tool, file]) => {
        if (!off) setReady({ Tool, file });
      })
      .catch((e: unknown) => {
        console.error('Could not open tool:', e);
        if (!off) setError(pt ? 'Não foi possível abrir esta ferramenta.' : 'Could not open this tool.');
      });
    return () => {
      off = true;
    };
  }, [toolId, pt]);

  const bridge = useMemo<ToolBridge | null>(() => {
    if (!ready) return null;
    return {
      file: ready.file,
      takeFile: () => {
        if (taken.current || !ready.file) return null;
        taken.current = true;
        return ready.file;
      },
      hasTaken: () => taken.current,
      apply: (blob, name) => envRef.current.onApply(blob, name),
      openCopy: (blob, name) => envRef.current.onOpenCopy(blob, name),
    };
  }, [ready]);

  const slug = getToolById(toolId)?.slug ?? toolId;
  const failMessage = pt ? 'Esta ferramenta não pôde ser exibida.' : 'This tool could not be displayed.';

  return (
    <div className="th-back">
      <section className="th-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="th-head">
          <button className="th-close" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
          <h2 className="th-title">{title}</h2>
        </header>
        <div className="th-body tool-host" data-tool={toolId}>
          {error && <p className="tp-err" role="alert">{error}</p>}
          {!error && !ready && <p className="th-wait">{pt ? 'Preparando…' : 'Preparing…'}</p>}
          {ready && bridge && (
            <Guard message={failMessage}>
              <ToolProvider toolSlug={slug} toolName={title}>
                <ToolBridgeProvider value={bridge}>
                  <ready.Tool />
                </ToolBridgeProvider>
              </ToolProvider>
            </Guard>
          )}
        </div>
      </section>
    </div>
  );
}
