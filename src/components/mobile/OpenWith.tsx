'use client';

/**
 * "Abrir com" no Android: quando outro app (Arquivos, WhatsApp, e-mail…) manda um PDF
 * para o PDFCraft, o arquivo entra nos recentes e abre direto no leitor.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { addRecent } from '@/lib/mobile-files';
import { withBasePath } from '@/lib/utils/path';

/** O arquivo começa como um PDF? (o "%PDF" pode vir depois de alguns bytes) */
function looksLikePdf(head: Uint8Array): boolean {
  const n = Math.min(head.length, 1024);
  for (let i = 0; i + 3 < n; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return true;
  }
  return false;
}

export default function OpenWith({ locale }: { locale: string }) {
  const router = useRouter();
  // o efeito abaixo roda uma vez só; o roteador e o idioma mais novos ficam aqui
  const routerRef = useRef(router);
  routerRef.current = router;
  const pt = locale.startsWith('pt');
  const ptRef = useRef(pt);
  ptRef.current = pt;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      const files = await import('@/lib/android-files');
      if (!(await files.androidFilesReady())) return;
      busy = true;
      try {
        const pt = ptRef.current;
        const file = await files.takeOpenedFile((name) => {
          if (alive) setOpening(name || (pt ? 'documento' : 'document'));
        });
        if (!file || !alive) return;
        const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
        if (!looksLikePdf(head)) {
          setError(pt ? 'Esse arquivo não é um PDF.' : 'This file is not a PDF.');
          return;
        }
        const doc = await addRecent(file);
        const url = '/' + localeRef.current + '/reader/?id=' + doc.id;
        if (/\/reader\/?$/.test(window.location.pathname)) {
          // já está no leitor: recarrega com o arquivo novo
          window.location.assign(withBasePath(url));
        } else {
          routerRef.current.push(url);
        }
      } catch (err) {
        console.error('[abrir com]', err);
        if (alive) setError(ptRef.current ? 'Não foi possível abrir o arquivo.' : 'Could not open the file.');
      } finally {
        busy = false;
        if (alive) setOpening(null);
      }
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <>
      {opening !== null && (
        <div className="sv-opening" role="status">
          <Loader2 aria-hidden="true" />
          <p>
            {pt ? 'Abrindo' : 'Opening'} {opening}…
          </p>
        </div>
      )}
      {error && (
        <div className="sv-toast" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
