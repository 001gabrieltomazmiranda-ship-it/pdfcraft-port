'use client';

import { useState } from 'react';
import ToolCatalog, { type ExtraTool } from './ToolCatalog';
import { useBackClose } from './backStack';

export default function MoreToolsSheet({
  locale,
  titles,
  featured,
  extra,
  onPick,
  onClose,
}: {
  locale: string;
  titles: Record<string, string>;
  featured: string[];
  extra?: ExtraTool[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const pt = locale.startsWith('pt');
  const [full, setFull] = useState(false);
  useBackClose(onClose);
  return (
    <div className="ms-back" onClick={onClose}>
      <div
        className={'ms-sheet' + (full ? ' ms-full' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Mais ferramentas' : 'More tools'}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="ms-handle" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose} />
        <h2 className="ms-title">{pt ? 'Mais ferramentas' : 'More tools'}</h2>
        <ToolCatalog locale={locale} titles={titles} featured={featured} extra={extra} onPick={onPick} onSearchActive={setFull} />
      </div>
    </div>
  );
}
