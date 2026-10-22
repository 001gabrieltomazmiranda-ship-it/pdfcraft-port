'use client';

import { ChevronRight, FileText, Scaling, X } from 'lucide-react';
import { useBackClose } from '../backStack';

/** Menu de três pontos do leitor (como o "..." do editor do Canva). */
export default function ReaderMenu({
  pt,
  onResize,
  onWord,
  onClose,
}: {
  pt: boolean;
  onResize: () => void;
  onWord: () => void;
  onClose: () => void;
}) {
  useBackClose(onClose);
  const items = [
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
  return (
    <div className="rs-back" onClick={onClose}>
      <div className="rs-sheet rs-menu" role="dialog" aria-modal="true" aria-label={pt ? 'Mais opções' : 'More options'} onClick={(e) => e.stopPropagation()}>
        <div className="rs-grip" aria-hidden="true" />
        <header className="rs-head">
          <span className="rs-icon-space" />
          <h2 className="rs-title">{pt ? 'Mais opções' : 'More options'}</h2>
          <button type="button" className="rs-icon-btn" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="rs-body">
          {items.map(({ id, Icon, title, desc, go }) => (
            <button key={id} type="button" className="rs-row rs-cat rs-menu-item" onClick={go}>
              <span className="rs-cat-ic">
                <Icon aria-hidden="true" />
              </span>
              <span className="rs-row-text">
                <span className="rs-row-name">{title}</span>
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
