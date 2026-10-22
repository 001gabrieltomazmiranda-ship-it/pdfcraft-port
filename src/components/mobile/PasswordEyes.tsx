'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Olhinho para mostrar/esconder a senha em QUALQUER campo de senha do app
 * (Criptografar, Remover senha, Permissões...), sem mexer em cada ferramenta:
 * acha os campos na tela e desenha o botão por cima do canto direito de cada um.
 */

interface Spot {
  el: HTMLInputElement;
  top: number;
  left: number;
  size: number;
  shown: boolean;
}

const MARK = 'data-pc-pw';

function visible(el: HTMLInputElement): DOMRect | null {
  if (!el.isConnected || el.disabled) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 16) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  const cs = window.getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
  // escondido atrás de outra folha? (o ponto do canto direito tem que ser do próprio campo)
  const x = Math.min(window.innerWidth - 1, Math.max(0, r.right - 8));
  const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top) && !(top as HTMLElement).closest?.('.pc-eye')) return null;
  return r;
}

export default function PasswordEyes({ pt }: { pt: boolean }) {
  const [spots, setSpots] = useState<Spot[]>([]);

  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const ids = new WeakMap<HTMLInputElement, number>();
    let next = 0;
    const idOf = (el: HTMLInputElement) => {
      if (!ids.has(el)) ids.set(el, ++next);
      return ids.get(el);
    };
    const scan = (): number => {
      const found: Spot[] = [];
      const inputs = document.querySelectorAll<HTMLInputElement>(`input[type="password"], input[${MARK}]`);
      inputs.forEach((el) => {
        if (!el.hasAttribute(MARK)) {
          el.setAttribute(MARK, '1');
          // espaço para o olho não ficar em cima do texto
          const pad = parseFloat(window.getComputedStyle(el).paddingRight) || 0;
          if (pad < 40) el.style.paddingRight = '44px';
        }
        const r = visible(el);
        if (!r) return;
        const size = Math.min(40, Math.max(28, r.height - 8));
        found.push({ el, top: r.top + (r.height - size) / 2, left: r.right - size - 6, size, shown: el.type === 'text' });
      });
      const key = found.map((s) => `${idOf(s.el)}:${Math.round(s.top)},${Math.round(s.left)},${s.size},${s.shown}`).join('|');
      if (key !== last) {
        last = key;
        setSpots(found);
      }
      return inputs.length;
    };
    // com campo de senha na tela acompanha a cada quadro (rolagem, teclado); sem campo, olha de vez em quando
    const tick = () => {
      const n = scan();
      if (n > 0) raf = window.requestAnimationFrame(tick);
      else timer = setTimeout(tick, 400);
    };
    tick();
    return () => {
      window.cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (typeof document === 'undefined' || spots.length === 0) return null;
  return createPortal(
    <>
      {spots.map((s, i) => (
        <button
          key={i}
          type="button"
          className="pc-eye"
          style={{ top: s.top, left: s.left, width: s.size, height: s.size }}
          aria-label={s.shown ? (pt ? 'Esconder senha' : 'Hide password') : pt ? 'Mostrar senha' : 'Show password'}
          aria-pressed={s.shown}
          // não tira o foco do campo (o teclado continua aberto)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = s.el;
            const pos = el.selectionStart;
            el.type = el.type === 'password' ? 'text' : 'password';
            try {
              if (pos !== null) el.setSelectionRange(pos, pos);
            } catch {
              /* alguns campos não deixam */
            }
          }}
        >
          {s.shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      ))}
    </>,
    document.body
  );
}
