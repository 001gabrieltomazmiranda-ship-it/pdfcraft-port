'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { getAllTools } from '@/config/tools';
import { getToolIcon } from '@/config/icons';
import type { ToolCategory } from '@/types/tool';

type ToolItem = ReturnType<typeof getAllTools>[number];

const GROUPS: { id: ToolCategory; pt: string; en: string }[] = [
  { id: 'organize-manage', pt: 'Organizar', en: 'Organize' },
  { id: 'edit-annotate', pt: 'Editar', en: 'Edit' },
  { id: 'convert-to-pdf', pt: 'Converter para PDF', en: 'Convert to PDF' },
  { id: 'convert-from-pdf', pt: 'Converter de PDF', en: 'Convert from PDF' },
  { id: 'optimize-repair', pt: 'Otimizar e reparar', en: 'Optimize & repair' },
  { id: 'secure-pdf', pt: 'Proteger', en: 'Secure' },
];

/** Busca + todas as ferramentas por grupo, como na folha "Mais ferramentas" do Acrobat. */
export default function ToolCatalog({
  locale,
  titles,
  featured = [],
  onPick,
  onSearchActive,
}: {
  locale: string;
  titles: Record<string, string>;
  /** Ferramentas mostradas primeiro, na seção "Mais usadas". */
  featured?: string[];
  onPick: (id: string) => void;
  /** Avisa quando a pessoa está buscando (a folha vai para a tela toda). */
  onSearchActive?: (active: boolean) => void;
}) {
  const pt = locale.startsWith('pt');
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = focused || q.length > 0;

  useEffect(() => {
    onSearchActive?.(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // a cada letra, os resultados voltam para o topo (logo abaixo do campo)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0 });
  }, [q]);
  const all = getAllTools();
  const title = (id: string) => titles[id] || id.replace(/-/g, ' ');
  const term = q.trim().toLowerCase();
  const found = term ? all.filter((t) => title(t.id).toLowerCase().includes(term)) : null;

  const tile = (t: ToolItem) => {
    const Icon = getToolIcon(t.icon);
    return (
      <button key={t.id} className="ms-tile" onClick={() => onPick(t.id)}>
        <span className="ms-ic" data-c={t.category}>
          <Icon aria-hidden="true" />
        </span>
        <span className="ms-lb">{title(t.id)}</span>
      </button>
    );
  };

  const top = all.filter((t) => featured.includes(t.id));

  return (
    <>
      <div className="ms-searchrow">
        <label className="ms-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            enterKeyHint="search"
            placeholder={pt ? 'Buscar ferramenta' : 'Search tools'}
            aria-label={pt ? 'Buscar ferramenta' : 'Search tools'}
          />
        </label>
        {active && onSearchActive && (
          <button
            type="button"
            className="ms-cancel"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQ('');
              setFocused(false);
              inputRef.current?.blur();
            }}
          >
            {pt ? 'Cancelar' : 'Cancel'}
          </button>
        )}
      </div>
      <div ref={scrollRef} className={'ms-scroll' + (active ? ' ms-typing' : '')}>
        {found ? (
          found.length === 0 ? (
            <p className="m-empty">{pt ? 'Nenhuma ferramenta encontrada.' : 'No tools found.'}</p>
          ) : (
            <div className="ms-grid">{found.map(tile)}</div>
          )
        ) : (
          <>
            {top.length > 0 && (
              <section>
                <h3 className="ms-h3">{pt ? 'Mais usadas' : 'Most used'}</h3>
                <div className="ms-grid">{top.map(tile)}</div>
              </section>
            )}
            {GROUPS.map((g) => {
              const items = all.filter((t) => t.category === g.id && !featured.includes(t.id));
              if (items.length === 0) return null;
              return (
                <section key={g.id}>
                  <h3 className="ms-h3">{pt ? g.pt : g.en}</h3>
                  <div className="ms-grid">{items.map(tile)}</div>
                </section>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
