'use client';

/**
 * "Salvar arquivo" do app Android:
 * - a pessoa escreve só o nome; a extensão (.pdf) fica fixa e é colocada sozinha;
 * - o arquivo vai para a pasta escolhida (o app lembra dela);
 * - se já existir um arquivo com o mesmo nome, pergunta se deve substituir.
 */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, ChevronRight, FolderOpen, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { isPortuguese } from '@/lib/pdf/ui-lang';
import {
  checkFolder,
  forgetFolder,
  pickFolder,
  savedFolder,
  saveInFolder,
  uploadForSave,
  type SaveFolder,
} from '@/lib/android-files';

export interface SaveOutcome {
  status: 'saved' | 'cancelled';
  /** frase pronta para mostrar ("Salvo em Notas: arquivo.pdf") */
  message?: string;
}

/** Separa "relatorio_editado.pdf" em "relatorio_editado" e ".pdf". */
export function splitName(fileName: string): { base: string; ext: string } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})$/.exec(fileName.trim());
  if (m && m[1].trim()) return { base: m[1], ext: m[2].toLowerCase() };
  return { base: fileName.trim(), ext: '' };
}

// sinais que o Android não aceita em nome de arquivo (e caracteres de controle)
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const HAS_BAD = /[\\/:*?"<>|\x00-\x1f]/;

/** Nome que pode ser usado: sem caracteres proibidos e sem repetir a extensão no fim. */
export function cleanBase(base: string, ext: string): string {
  let b = base.replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim();
  if (ext) {
    const lower = ext.toLowerCase();
    while (b.toLowerCase().endsWith(lower)) b = b.slice(0, b.length - ext.length).trim();
  }
  b = b.replace(/^\.+/, '').replace(/[. ]+$/, '');
  return b.slice(0, 150);
}

interface Props {
  suggestedName: string;
  bytes: Uint8Array;
  onDone: (r: SaveOutcome) => void;
}

type Phase = 'edit' | 'busy' | 'exists';

function SaveSheet({ suggestedName, bytes, onDone }: Props) {
  const pt = isPortuguese();
  const { base: initialBase, ext } = splitName(suggestedName);
  const [base, setBase] = useState(initialBase);
  const [folder, setFolder] = useState<SaveFolder | null>(() => savedFolder());
  const [phase, setPhase] = useState<Phase>('edit');
  const [existing, setExisting] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [badChar, setBadChar] = useState(false);
  const uploaded = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  const finish = (r: SaveOutcome) => {
    if (closed.current) return;
    closed.current = true;
    onDone(r);
  };
  useBackClose(() => finish({ status: 'cancelled' }));

  useEffect(() => {
    let alive = true;
    checkFolder(savedFolder()).then((f) => {
      if (alive) setFolder(f);
    });
    return () => {
      alive = false;
    };
  }, []);

  const name = cleanBase(base, ext);
  const fileName = name + ext;

  const choose = async (): Promise<SaveFolder | null> => {
    setError(null);
    try {
      const f = await pickFolder(folder);
      if (f) setFolder(f);
      return f;
    } catch (err) {
      setError((pt ? 'Não consegui abrir as pastas. ' : 'Could not open the folders. ') + String((err as Error)?.message || err));
      return null;
    }
  };

  const write = async (overwrite: boolean) => {
    if (!name) return;
    setError(null);
    let f = folder;
    if (!f) {
      f = await choose();
      if (!f) return;
    }
    setPhase('busy');
    try {
      if (!uploaded.current) {
        await uploadForSave(bytes);
        uploaded.current = true;
      }
      const r = await saveInFolder(f, fileName, overwrite);
      if (r.status === 'exists') {
        setExisting(r.name);
        setPhase('exists');
        return;
      }
      const where = r.folder || f.name;
      finish({
        status: 'saved',
        message: pt
          ? `Salvo${where ? ` em “${where}”` : ''}: ${r.name}`
          : `Saved${where ? ` in “${where}”` : ''}: ${r.name}`,
      });
    } catch (err) {
      const msg = String((err as Error)?.message || err || '');
      setPhase('edit');
      if (/no-access/.test(msg)) {
        forgetFolder();
        setFolder(null);
        setError(pt ? 'O app perdeu o acesso a essa pasta. Escolha a pasta de novo.' : 'The app lost access to that folder. Choose it again.');
      } else {
        setError((pt ? 'Não foi possível salvar. ' : 'Could not save. ') + (msg ? `(${msg.slice(0, 80)})` : ''));
      }
    }
  };

  const badTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = (v: string) => {
    if (HAS_BAD.test(v)) {
      // o aviso fica um tempinho na tela (o sinal já foi tirado do nome)
      setBadChar(true);
      if (badTimer.current) clearTimeout(badTimer.current);
      badTimer.current = setTimeout(() => setBadChar(false), 4000);
    }
    setBase(v.replace(BAD_CHARS, ''));
  };

  // ao voltar de "Mudar o nome", o cursor já fica no nome
  const [focusName, setFocusName] = useState(false);
  useEffect(() => {
    if (focusName && phase === 'edit') {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
      setFocusName(false);
    }
  }, [focusName, phase]);

  const busy = phase === 'busy';

  return (
    <div className="rs-back sv-back" onClick={() => !busy && finish({ status: 'cancelled' })}>
      <div
        className="rs-sheet rs-menu sv-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Salvar arquivo' : 'Save file'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rs-grip" />
        <div className="rs-head">
          <span className="rs-icon-space" />
          <h2 className="rs-title">{pt ? 'Salvar arquivo' : 'Save file'}</h2>
          <button type="button" className="rs-icon-btn" onClick={() => finish({ status: 'cancelled' })} disabled={busy} aria-label={pt ? 'Fechar' : 'Close'}>
            <X aria-hidden="true" />
          </button>
        </div>

        {phase === 'exists' ? (
          <div className="rs-body sv-body">
            <div className="sv-warn">
              <AlertTriangle aria-hidden="true" />
              <div>
                <p className="sv-warn-title">{pt ? 'Já existe um arquivo com esse nome' : 'A file with this name already exists'}</p>
                <p className="sv-warn-text">
                  {pt ? (
                    <>
                      “{existing}” já está na pasta {folder?.name ? `“${folder.name}”` : 'escolhida'}. Quer substituir o arquivo antigo por este?
                    </>
                  ) : (
                    <>
                      “{existing}” is already in {folder?.name ? `“${folder.name}”` : 'the folder'}. Replace the old file with this one?
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="rs-actions sv-actions">
              <button
                type="button"
                className="rs-btn2"
                onClick={() => {
                  setPhase('edit');
                  setFocusName(true);
                }}
              >
                {pt ? 'Mudar o nome' : 'Change name'}
              </button>
              <button type="button" className="rs-btn sv-replace" onClick={() => write(true)}>
                {pt ? 'Substituir' : 'Replace'}
              </button>
            </div>
          </div>
        ) : (
          <div className="rs-body sv-body">
            <label className="sv-label" htmlFor="sv-name">
              {pt ? 'Nome do arquivo' : 'File name'}
            </label>
            <div className="sv-name-row">
              <input
                id="sv-name"
                ref={inputRef}
                className="sv-name"
                value={base}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') write(false);
                }}
                onBlur={() => {
                  // quem digitou ".pdf" no fim: tira, porque ele já vai sozinho
                  if (ext && base.trim().toLowerCase().endsWith(ext)) setBase(base.trim().slice(0, -ext.length));
                }}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                aria-describedby="sv-name-hint"
              />
              {base && !busy && (
                <button type="button" className="sv-clear" onClick={() => onChange('')} aria-label={pt ? 'Apagar o nome' : 'Clear name'}>
                  <X aria-hidden="true" />
                </button>
              )}
              {ext && <span className="sv-ext">{ext}</span>}
            </div>
            <p id="sv-name-hint" className={`sv-hint ${badChar ? 'err' : ''}`}>
              {badChar
                ? pt
                  ? 'Não use estes sinais no nome:  \\  /  :  *  ?  "  <  >  |'
                  : 'Do not use these characters:  \\  /  :  *  ?  "  <  >  |'
                : ext
                  ? pt
                    ? `O ${ext} é colocado sozinho no final.`
                    : `${ext} is added automatically.`
                  : ''}
            </p>

            <p className="sv-label">{pt ? 'Salvar em' : 'Save in'}</p>
            <button type="button" className="sv-folder" onClick={() => choose()} disabled={busy}>
              <FolderOpen aria-hidden="true" />
              <span className="sv-folder-name">{folder?.name || (pt ? 'Escolher pasta' : 'Choose folder')}</span>
              <span className="sv-folder-act">
                {folder ? (pt ? 'Trocar' : 'Change') : ''}
                <ChevronRight aria-hidden="true" />
              </span>
            </button>
            {!folder && (
              <p className="sv-hint">
                {pt
                  ? 'Na primeira vez, escolha a pasta onde os arquivos vão ficar (por exemplo, Documentos) e toque em “Usar esta pasta”. O app lembra dela.'
                  : 'The first time, choose the folder for your files (for example, Documents) and tap “Use this folder”. The app remembers it.'}
              </p>
            )}

            {error && <p className="sv-hint err" role="alert">{error}</p>}

            <div className="rs-actions sv-actions">
              <button type="button" className="rs-btn2" onClick={() => finish({ status: 'cancelled' })} disabled={busy}>
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button type="button" className="rs-btn" onClick={() => write(false)} disabled={busy || !name}>
                {busy ? (pt ? 'Salvando…' : 'Saving…') : pt ? 'Salvar' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ abrir a folha de qualquer lugar

let openNow: Promise<SaveOutcome> | null = null;

/** Mostra a folha "Salvar arquivo" por cima do app e espera a pessoa terminar. */
export function openSaveSheet(suggestedName: string, input: Uint8Array): Promise<SaveOutcome> {
  if (openNow) return Promise.resolve({ status: 'cancelled' });
  const bytes = new Uint8Array(input.length);
  bytes.set(input);
  const host = document.createElement('div');
  host.className = 'sv-host';
  document.body.appendChild(host);
  const root = createRoot(host);
  openNow = new Promise<SaveOutcome>((resolve) => {
    const done = (r: SaveOutcome) => {
      // deixa o "Voltar" do Android se arrumar antes de desmontar
      setTimeout(() => {
        root.unmount();
        host.remove();
        openNow = null;
        resolve(r);
      }, 0);
    };
    root.render(<SaveSheet suggestedName={suggestedName} bytes={bytes} onDone={done} />);
  });
  return openNow;
}

/** Aviso rápido na parte de baixo da tela. */
export function showSavedToast(message: string): void {
  const el = document.createElement('div');
  el.className = 'sv-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
