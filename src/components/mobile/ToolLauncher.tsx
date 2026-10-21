'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { getToolById } from '@/config/tools';
import { addRecent } from '@/lib/mobile-files';
import ToolHost from './ToolHost';

/** A ferramenta parte de um PDF (o resto parte de imagens, Word, texto...). */
export function needsPdf(id: string): boolean {
  const tool = getToolById(id);
  if (!tool) return true;
  return tool.acceptedFormats.some((f) => f === 'application/pdf' || f === '.pdf');
}

/**
 * Abre ferramentas a partir do Início e da aba Ferramentas, como o Acrobat:
 * ferramentas de PDF pedem o arquivo e abrem no leitor; as que partem de outros
 * formatos abrem numa folha aqui mesmo.
 */
export function useToolLauncher(
  locale: string,
  titles: Record<string, string>
): { launch: (id: string) => void; openPicker: () => void; elements: ReactNode } {
  const router = useRouter();
  const pt = locale.startsWith('pt');
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<string | null>(null);
  const [standalone, setStandalone] = useState<string | null>(null);

  const openInReader = (docId: string, tool: string | null) => {
    router.push('/' + locale + '/reader/?id=' + docId + (tool ? '&tool=' + tool : ''));
  };

  const openResult = async (blob: Blob, name: string) => {
    try {
      const doc = await addRecent(new File([blob], name, { type: 'application/pdf' }));
      setStandalone(null);
      openInReader(doc.id, null);
    } catch {
      window.alert(pt ? 'Não foi possível abrir o arquivo.' : 'Could not open the file.');
    }
  };

  const launch = (id: string) => {
    if (needsPdf(id)) {
      pending.current = id;
      inputRef.current?.click();
    } else {
      setStandalone(id);
    }
  };

  const openPicker = () => {
    pending.current = null;
    inputRef.current?.click();
  };

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const tool = pending.current;
    pending.current = null;
    try {
      const doc = await addRecent(file);
      openInReader(doc.id, tool);
    } catch {
      window.alert(pt ? 'Não foi possível abrir o arquivo.' : 'Could not open the file.');
    }
  };

  const elements = (
    <>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={onChange} />
      {standalone && (
        <ToolHost
          key={standalone}
          toolId={standalone}
          title={titles[standalone] || standalone}
          locale={locale}
          env={{
            getFile: async () => null,
            onApply: (blob, name) => void openResult(blob, name || 'documento.pdf'),
            onOpenCopy: (blob, name) => void openResult(blob, name),
          }}
          onClose={() => setStandalone(null)}
        />
      )}
    </>
  );

  return { launch, openPicker, elements };
}
