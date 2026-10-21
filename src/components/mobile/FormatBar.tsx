'use client';

import { useEffect, useState } from 'react';
import { EDITOR, PARAM, type ViewerApp } from './viewer';

const INK_COLORS = ['#000000', '#e5484d', '#f5a524', '#30a46c', '#3e63dd', '#8e4ec6'];
const MARK_COLORS = ['#FFFF98', '#53FFBC', '#80EBFF', '#FFCBE6', '#FF4F5F'];

const TEXT_SIZES = [
  { v: 10, label: 'P', pt: 'Pequeno', en: 'Small' },
  { v: 14, label: 'M', pt: 'Médio', en: 'Medium' },
  { v: 22, label: 'G', pt: 'Grande', en: 'Large' },
];
const DRAW_SIZES = [
  { v: 1, label: '', pt: 'Fino', en: 'Thin' },
  { v: 3, label: '', pt: 'Médio', en: 'Medium' },
  { v: 8, label: '', pt: 'Grosso', en: 'Thick' },
];

/** Faixa de cores e tamanhos que aparece por cima da barra, como no Acrobat. */
export default function FormatBar({
  mode,
  pt,
  getApp,
}: {
  mode: number;
  pt: boolean;
  getApp: () => ViewerApp | undefined;
}) {
  const palette = mode === EDITOR.HIGHLIGHT ? MARK_COLORS : INK_COLORS;
  const sizes = mode === EDITOR.TEXT ? TEXT_SIZES : mode === EDITOR.DRAW ? DRAW_SIZES : null;
  const colorType =
    mode === EDITOR.TEXT ? PARAM.TEXT_COLOR : mode === EDITOR.DRAW ? PARAM.DRAW_COLOR : PARAM.HIGHLIGHT_COLOR;
  const sizeType = mode === EDITOR.TEXT ? PARAM.TEXT_SIZE : PARAM.DRAW_THICKNESS;

  const [color, setColor] = useState(palette[0]);
  const [size, setSize] = useState(sizes ? sizes[1].v : 0);

  const send = (type: number, value: number | string) => {
    const app = getApp();
    if (app) app.eventBus.dispatch('switchannotationeditorparams', { source: app, type, value });
  };

  // Ao entrar no modo, aplica a cor e o tamanho mostrados (o padrão do visualizador é pequeno demais no celular).
  useEffect(() => {
    const first = palette[0];
    const mid = sizes ? sizes[1].v : 0;
    setColor(first);
    setSize(mid);
    const t = window.setTimeout(() => {
      send(colorType, first);
      if (sizes) send(sizeType, mid);
    }, 80);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (mode !== EDITOR.TEXT && mode !== EDITOR.DRAW && mode !== EDITOR.HIGHLIGHT) return null;

  return (
    <div className="r-format" role="toolbar" aria-label={pt ? 'Formatação' : 'Formatting'}>
      <div className="r-swatches">
        {palette.map((c) => (
          <button
            key={c}
            type="button"
            className="r-sw"
            style={{ background: c }}
            aria-label={(pt ? 'Cor ' : 'Color ') + c}
            aria-pressed={color === c}
            onClick={() => {
              setColor(c);
              send(colorType, c);
            }}
          />
        ))}
      </div>
      {sizes && (
        <div className="r-sizes" role="group" aria-label={pt ? 'Tamanho' : 'Size'}>
          {sizes.map((s) => (
            <button
              key={s.v}
              type="button"
              className="r-size"
              aria-label={pt ? s.pt : s.en}
              aria-pressed={size === s.v}
              onClick={() => {
                setSize(s.v);
                send(sizeType, s.v);
              }}
            >
              {mode === EDITOR.TEXT ? (
                <span style={{ fontSize: 10 + TEXT_SIZES.indexOf(s) * 4 }}>A</span>
              ) : (
                <span className="r-line" style={{ height: Math.max(2, Math.min(8, s.v)) }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
