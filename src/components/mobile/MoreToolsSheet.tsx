'use client';

import ToolCatalog from './ToolCatalog';
import { useBackClose } from './backStack';

export default function MoreToolsSheet({
  locale,
  titles,
  featured,
  onPick,
  onClose,
}: {
  locale: string;
  titles: Record<string, string>;
  featured: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const pt = locale.startsWith('pt');
  useBackClose(onClose);
  return (
    <div className="ms-back" onClick={onClose}>
      <div
        className="ms-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Mais ferramentas' : 'More tools'}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="ms-handle" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose} />
        <h2 className="ms-title">{pt ? 'Mais ferramentas' : 'More tools'}</h2>
        <ToolCatalog locale={locale} titles={titles} featured={featured} onPick={onPick} />
      </div>
    </div>
  );
}
