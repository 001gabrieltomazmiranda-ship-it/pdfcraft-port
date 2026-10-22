'use client';

import type { MouseEvent } from 'react';
import { Image as ImageIcon, Trash2, Type } from 'lucide-react';
import type { EditStatus } from './PageEditor';

const COLORS = ['#000000', '#5f6368', '#c62828', '#1565c0', '#2e7d32', '#7c3aed'];

/** Não deixa o botão roubar o foco (senão o teclado da digitação fecha). */
const keepFocus = (e: MouseEvent) => e.preventDefault();

export interface EditActions {
  addText: () => void;
  addImage: () => void;
  remove: () => void;
  size: (delta: number) => void;
  bold: () => void;
  color: (hex: string) => void;
}

/** Faixa abaixo do topo: formatação do texto selecionado, ou a dica do que fazer. */
export function EditPdfFormat(props: { status: EditStatus; pt: boolean; act: EditActions }) {
  // altura fixa: a página não "pula" quando a faixa troca de conteúdo
  return <div className="pe-slot">{formatContent(props)}</div>;
}

function formatContent({ status, pt, act }: { status: EditStatus; pt: boolean; act: EditActions }) {
  const sel = status.sel;
  if (status.adding) {
    return <div className="pe-hint">{pt ? 'Toque na página onde o texto vai ficar.' : 'Tap the page where the text should go.'}</div>;
  }
  if (!sel) {
    return (
      <div className="pe-hint">
        {pt
          ? 'Toque num texto ou imagem para selecionar. Toque de novo para digitar; arraste para mover.'
          : 'Tap a text or image to select it. Tap again to type; drag to move.'}
      </div>
    );
  }
  if (sel.kind === 'image') {
    return (
      <div className="pe-bar" role="toolbar" aria-label={pt ? 'Imagem' : 'Image'}>
        <span className="pe-label">{pt ? 'Arraste para mover · bolinha para o tamanho' : 'Drag to move · dot to resize'}</span>
        <button type="button" className="pe-btn pe-del" onMouseDown={keepFocus} onClick={act.remove} aria-label={pt ? 'Apagar imagem' : 'Delete image'}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="pe-bar" role="toolbar" aria-label={pt ? 'Formatação do texto' : 'Text format'}>
      <div className="pe-size" role="group" aria-label={pt ? 'Tamanho da letra' : 'Font size'}>
        <button type="button" className="pe-btn" onMouseDown={keepFocus} onClick={() => act.size(-1)} aria-label={pt ? 'Diminuir letra' : 'Smaller'}>
          A−
        </button>
        <span className="pe-num">{Math.round(sel.size * 10) / 10}</span>
        <button type="button" className="pe-btn" onMouseDown={keepFocus} onClick={() => act.size(1)} aria-label={pt ? 'Aumentar letra' : 'Larger'}>
          A+
        </button>
      </div>
      <button
        type="button"
        className="pe-btn"
        aria-pressed={sel.bold}
        onMouseDown={keepFocus}
        onClick={act.bold}
        aria-label={pt ? 'Negrito' : 'Bold'}
      >
        <span className="pe-b" aria-hidden="true">B</span>
      </button>
      <div className="pe-colors">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="r-sw pe-sw"
            style={{ background: c }}
            aria-label={(pt ? 'Cor ' : 'Color ') + c}
            aria-pressed={sel.color.toLowerCase() === c}
            onMouseDown={keepFocus}
            onClick={() => act.color(c)}
          />
        ))}
      </div>
      <button type="button" className="pe-btn pe-del" onMouseDown={keepFocus} onClick={act.remove} aria-label={pt ? 'Apagar texto' : 'Delete text'}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

/** Barra de baixo no modo Editar PDF (como no Acrobat: Texto, Imagem, Apagar). */
export function EditPdfBottom({ status, pt, act }: { status: EditStatus; pt: boolean; act: EditActions }) {
  return (
    <nav className="r-bottom" aria-label={pt ? 'Editar PDF' : 'Edit PDF'}>
      <button className="r-tool" aria-pressed={status.adding} onMouseDown={keepFocus} onClick={act.addText}>
        <Type aria-hidden="true" />
        {pt ? 'Adicionar texto' : 'Add text'}
      </button>
      <button className="r-tool" onMouseDown={keepFocus} onClick={act.addImage}>
        <ImageIcon aria-hidden="true" />
        {pt ? 'Adicionar imagem' : 'Add image'}
      </button>
      <button className="r-tool" onMouseDown={keepFocus} onClick={act.remove} disabled={!status.sel}>
        <Trash2 aria-hidden="true" />
        {pt ? 'Apagar' : 'Delete'}
      </button>
    </nav>
  );
}
