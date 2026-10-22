'use client';

import { useState } from 'react';
import { ArrowLeft, Check, ChevronRight, FileText, Layers, Scaling, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import type { ViewMode } from '../PageNav';

function StepBack({ onBack }: { onBack: () => void }) {
  useBackClose(onBack);
  return null;
}

/** Ícone desenhado: páginas uma embaixo da outra / uma página só. */
function ModeIcon({ mode }: { mode: ViewMode }) {
  return mode === 'continuous' ? (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="1.5" width="12" height="9" rx="1.5" />
      <rect x="6" y="13.5" width="12" height="9" rx="1.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <rect x="6" y="3" width="12" height="16" rx="1.5" />
      <path d="M2.5 11h1.5M20 11h1.5" />
    </svg>
  );
}

/** Menu de três pontos do leitor (como o "..." do editor do Canva / do Acrobat). */
export default function ReaderMenu({
  pt,
  viewMode,
  onViewMode,
  onResize,
  onWord,
  onClose,
}: {
  pt: boolean;
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
  onResize: () => void;
  onWord: () => void;
  onClose: () => void;
}) {
  useBackClose(onClose);
  const [sub, setSub] = useState(false);
  const modes: { id: ViewMode; title: string; desc: string }[] = [
    {
      id: 'continuous',
      title: pt ? 'Contínua' : 'Continuous',
      desc: pt ? 'As páginas rolam uma embaixo da outra. O número da página aparece na borda.' : 'Pages scroll one below the other. The page number shows on the edge.',
    },
    {
      id: 'page',
      title: pt ? 'Página por página' : 'Single page',
      desc: pt ? 'Uma página de cada vez. Deslize para o lado para trocar.' : 'One page at a time. Swipe sideways to change.',
    },
  ];
  const items = [
    {
      id: 'mode',
      Icon: Layers,
      title: pt ? 'Modo de exibição' : 'View mode',
      desc: modes.find((m) => m.id === viewMode)!.title,
      go: () => setSub(true),
    },
    {
      id: 'resize',
      Icon: Scaling,
      title: pt ? 'Redimensionar' : 'Resize',
      desc: pt ? 'Mude o tamanho das páginas: A4, Story, Carta ou personalizado.' : 'Change the page size: A4, Story, Letter or custom.',
      go: onResize,
    },
    {
      id: 'word',
      Icon: FileText,
      title: pt ? 'Transformar em Word' : 'Turn into Word',
      desc: pt ? 'Converta o PDF em documento editável (.docx).' : 'Convert the PDF into an editable document (.docx).',
      go: onWord,
    },
  ];
  const title = sub ? (pt ? 'Modo de exibição' : 'View mode') : pt ? 'Mais opções' : 'More options';
  return (
    <div className="rs-back" onClick={onClose}>
      {sub && <StepBack onBack={() => setSub(false)} />}
      <div className="rs-sheet rs-menu" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rs-grip" aria-hidden="true" />
        <header className="rs-head">
          {sub ? (
            <button type="button" className="rs-icon-btn" aria-label={pt ? 'Voltar' : 'Back'} onClick={() => setSub(false)}>
              <ArrowLeft />
            </button>
          ) : (
            <span className="rs-icon-space" />
          )}
          <h2 className="rs-title">{title}</h2>
          <button type="button" className="rs-icon-btn" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="rs-body">
          {sub
            ? modes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="rs-row rs-cat rs-menu-item"
                  aria-pressed={viewMode === m.id}
                  onClick={() => onViewMode(m.id)}
                >
                  <span className="rs-cat-ic">
                    <ModeIcon mode={m.id} />
                  </span>
                  <span className="rs-row-text">
                    <span className="rs-row-name">{m.title}</span>
                    <span className="rs-row-dim">{m.desc}</span>
                  </span>
                  {viewMode === m.id && <Check className="rs-chev pn-check" aria-hidden="true" />}
                </button>
              ))
            : items.map(({ id, Icon, title: t, desc, go }) => (
                <button key={id} type="button" className="rs-row rs-cat rs-menu-item" onClick={go}>
                  <span className="rs-cat-ic">
                    <Icon aria-hidden="true" />
                  </span>
                  <span className="rs-row-text">
                    <span className="rs-row-name">{t}</span>
                    <span className="rs-row-dim">{desc}</span>
                  </span>
                  <ChevronRight className="rs-chev" aria-hidden="true" />
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}
