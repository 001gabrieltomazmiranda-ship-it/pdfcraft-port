'use client';

import { useState, type ReactNode } from 'react';
import { useBackClose } from './backStack';

export interface PanelEnv {
  numPages: number;
  currentPage: number;
  fileName: string;
  getBytes: () => Promise<Uint8Array>;
  onResult: (blob: Blob, before: Uint8Array) => void;
}

interface Out {
  success: boolean;
  result?: Blob | Blob[];
  error?: { message?: string };
}

export const IN_APP_TOOLS = [
  'rotate-pdf',
  'delete-pages',
  'extract-pages',
  'compress-pdf',
  'encrypt-pdf',
  'page-numbers',
  'add-watermark',
  'merge-pdf',
];

function Seg<T extends string | number>({
  value,
  set,
  opts,
}: {
  value: T;
  set: (v: T) => void;
  opts: { v: T; label: string }[];
}) {
  return (
    <div className="tp-seg" role="group">
      {opts.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={value === o.v} onClick={() => set(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="tp-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export default function ToolPanel({
  toolId,
  title,
  locale,
  env,
  onClose,
}: {
  toolId: string;
  title: string;
  locale: string;
  env: PanelEnv;
  onClose: () => void;
}) {
  const pt = locale.startsWith('pt');
  useBackClose(onClose);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [angle, setAngle] = useState(90);
  const [scope, setScope] = useState<'all' | 'current'>('current');
  const [pages, setPages] = useState(String(env.currentPage));
  const [quality, setQuality] = useState<'medium' | 'high' | 'maximum'>('medium');
  const [pw, setPw] = useState('');
  const [wm, setWm] = useState('CONFIDENCIAL');
  const [pos, setPos] = useState<'bottom-center' | 'bottom-right' | 'top-center'>('bottom-center');
  const [extra, setExtra] = useState<File[]>([]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const bytes = await env.getBytes();
      const file = new File([bytes as unknown as BlobPart], env.fileName, { type: 'application/pdf' });
      let out: Out;
      if (toolId === 'rotate-pdf') {
        const { rotatePDF } = await import('@/lib/pdf/processors/rotate');
        out = (await rotatePDF(file, scope === 'all' ? { angle } : { angle, pages: [env.currentPage] })) as unknown as Out;
      } else if (toolId === 'delete-pages') {
        const { deletePages, parsePageSelection } = await import('@/lib/pdf/processors/delete');
        const list = parsePageSelection(pages, env.numPages);
        if (list.length === 0) throw new Error(pt ? 'Informe páginas válidas.' : 'Enter valid pages.');
        if (list.length >= env.numPages) throw new Error(pt ? 'Não dá para excluir todas as páginas.' : 'Cannot delete every page.');
        out = (await deletePages(file, list)) as unknown as Out;
      } else if (toolId === 'extract-pages') {
        const { extractPages, parsePageSelection } = await import('@/lib/pdf/processors/extract');
        const list = parsePageSelection(pages, env.numPages);
        if (list.length === 0) throw new Error(pt ? 'Informe páginas válidas.' : 'Enter valid pages.');
        out = (await extractPages(file, list)) as unknown as Out;
      } else if (toolId === 'compress-pdf') {
        const { compressPDF } = await import('@/lib/pdf/processors/compress');
        out = (await compressPDF(file, {
          algorithm: 'condense',
          quality,
          removeMetadata: false,
          optimizeImages: true,
          removeUnusedObjects: true,
        })) as unknown as Out;
      } else if (toolId === 'encrypt-pdf') {
        if (!pw) throw new Error(pt ? 'Digite uma senha.' : 'Enter a password.');
        const { encryptPDF } = await import('@/lib/pdf/processors/encrypt');
        out = (await encryptPDF(file, { userPassword: pw, ownerPassword: pw })) as unknown as Out;
      } else if (toolId === 'page-numbers') {
        const { addPageNumbers } = await import('@/lib/pdf/processors/page-numbers');
        out = (await addPageNumbers(file, { position: pos, format: 'number', fontSize: 12 })) as unknown as Out;
      } else if (toolId === 'add-watermark') {
        if (!wm.trim()) throw new Error(pt ? 'Digite o texto.' : 'Enter the text.');
        const { addWatermark } = await import('@/lib/pdf/processors/watermark');
        out = (await addWatermark(file, {
          type: 'text',
          text: wm,
          position: 'diagonal',
          opacity: 0.25,
          rotation: 45,
          fontSize: 48,
          pages: 'all',
        })) as unknown as Out;
      } else if (toolId === 'merge-pdf') {
        if (extra.length === 0) throw new Error(pt ? 'Escolha os PDFs para juntar.' : 'Choose PDFs to merge.');
        const { mergePDFs } = await import('@/lib/pdf/processors/merge');
        out = (await mergePDFs([file, ...extra])) as unknown as Out;
      } else {
        throw new Error('Tool not available');
      }
      const blob = Array.isArray(out.result) ? out.result[0] : out.result;
      if (!out.success || !blob) throw new Error(out.error?.message || (pt ? 'Não foi possível aplicar.' : 'Could not apply.'));
      env.onResult(blob, bytes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode = null;
  if (toolId === 'rotate-pdf') {
    body = (
      <>
        <Seg value={angle} set={setAngle} opts={[{ v: 90, label: '↻ 90°' }, { v: 270, label: '↺ 90°' }, { v: 180, label: '180°' }]} />
        <Seg
          value={scope}
          set={setScope}
          opts={[
            { v: 'current', label: pt ? 'Página ' + env.currentPage : 'Page ' + env.currentPage },
            { v: 'all', label: pt ? 'Todas' : 'All' },
          ]}
        />
      </>
    );
  } else if (toolId === 'delete-pages' || toolId === 'extract-pages') {
    body = (
      <Field label={(pt ? 'Páginas (1 a ' : 'Pages (1 to ') + env.numPages + (pt ? '). Ex.: 2, 4-6' : '). E.g. 2, 4-6')}>
        <input value={pages} onChange={(e) => setPages(e.target.value)} inputMode="numeric" />
      </Field>
    );
  } else if (toolId === 'compress-pdf') {
    body = (
      <Seg
        value={quality}
        set={setQuality}
        opts={[
          { v: 'medium', label: pt ? 'Equilibrada' : 'Balanced' },
          { v: 'high', label: pt ? 'Forte' : 'Strong' },
          { v: 'maximum', label: pt ? 'Máxima' : 'Maximum' },
        ]}
      />
    );
  } else if (toolId === 'encrypt-pdf') {
    body = (
      <Field label={pt ? 'Senha para abrir o PDF' : 'Password to open the PDF'}>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </Field>
    );
  } else if (toolId === 'page-numbers') {
    body = (
      <Seg
        value={pos}
        set={setPos}
        opts={[
          { v: 'bottom-center', label: pt ? 'Embaixo' : 'Bottom' },
          { v: 'bottom-right', label: pt ? 'Canto' : 'Corner' },
          { v: 'top-center', label: pt ? 'Em cima' : 'Top' },
        ]}
      />
    );
  } else if (toolId === 'add-watermark') {
    body = (
      <Field label={pt ? 'Texto da marca d’água' : 'Watermark text'}>
        <input value={wm} onChange={(e) => setWm(e.target.value)} />
      </Field>
    );
  } else if (toolId === 'merge-pdf') {
    body = (
      <Field label={pt ? 'PDFs para juntar ao final' : 'PDFs to append'}>
        <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => setExtra(Array.from(e.target.files || []))} />
        <small>{extra.length + (pt ? ' arquivo(s) escolhido(s)' : ' file(s) chosen')}</small>
      </Field>
    );
  }

  return (
    <div className="ms-back" onClick={onClose}>
      <div className="ms-sheet tp-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <button className="ms-handle" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose} />
        <h2 className="ms-title">{title}</h2>
        <div className="tp-body">{body}</div>
        {err && <p className="tp-err" role="alert">{err}</p>}
        <button className="tp-go" onClick={run} disabled={busy}>
          {busy ? (pt ? 'Aplicando…' : 'Applying…') : pt ? 'Aplicar' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
