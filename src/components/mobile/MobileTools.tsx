'use client';

import ToolCatalog from './ToolCatalog';
import { useToolLauncher } from './ToolLauncher';

/** Aba "Ferramentas": todas as ferramentas, no mesmo formato da folha "Mais ferramentas". */
export default function MobileTools({
  locale,
  content,
}: {
  locale: string;
  content: Record<string, { title: string; description: string }>;
}) {
  const pt = locale.startsWith('pt');
  const titles = Object.fromEntries(Object.entries(content).map(([id, c]) => [id, c.title]));
  const { launch, elements } = useToolLauncher(locale, titles);
  return (
    <div className="m-home m-tools">
      <h1 className="m-logo">{pt ? 'Ferramentas' : 'Tools'}</h1>
      <ToolCatalog locale={locale} titles={titles} onPick={launch} />
      {elements}
    </div>
  );
}
