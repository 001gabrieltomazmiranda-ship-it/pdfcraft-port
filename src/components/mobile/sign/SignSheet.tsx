'use client';

/**
 * Assinar (no estilo do Acrobat):
 * - menu com as assinaturas e rubricas salvas (toca e coloca na página);
 * - tela cheia "Criar assinatura": Desenhar, Digitar (letras cursivas) ou Imagem/Foto.
 * Quem coloca a assinatura na página é o editor de assinatura do visualizador (PDF.js).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Camera, Check, ImageIcon, Pencil, Plus, Redo2, Trash2, Type, Undo2, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { withBasePath } from '@/lib/utils/path';
import {
  SIG_COLORS,
  addSignature,
  drawingToSvg,
  importOldSignatures,
  loadSignatures,
  removeSignature,
  type SavedSig,
  type SigDrawing,
  type SigKind,
} from './signatures';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FONTS = [
  { id: 'dancing', family: 'PdfcraftSigDancing', file: 'DancingScript.woff' },
  { id: 'vibes', family: 'PdfcraftSigVibes', file: 'GreatVibes.woff' },
  { id: 'sacramento', family: 'PdfcraftSigSacramento', file: 'Sacramento.woff' },
  { id: 'dafoe', family: 'PdfcraftSigDafoe', file: 'MrDafoe.woff' },
] as const;

const WIDTHS = [
  { id: 'thin', px: 2 },
  { id: 'mid', px: 3.5 },
  { id: 'thick', px: 5.5 },
] as const;

let fontsLoading: Promise<void> | null = null;
function loadFonts(): Promise<void> {
  if (!fontsLoading) {
    fontsLoading = Promise.all(
      FONTS.map(async (f) => {
        try {
          const face = new FontFace(f.family, `url(${withBasePath('/fonts/signature/' + f.file)})`);
          document.fonts.add(face);
          await face.load();
        } catch (err) {
          console.warn('[assinatura] fonte', f.file, err);
        }
      })
    ).then(() => undefined);
  }
  return fontsLoading;
}

function SigPreview({ d, className }: { d: SigDrawing; className?: string }) {
  const { viewBox, path } = useMemo(() => drawingToSvg(d), [d]);
  return (
    <svg className={className} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {d.areContours ? (
        <path d={path} fill={d.color} fillRule="evenodd" />
      ) : (
        <path d={path} fill="none" stroke={d.color} strokeWidth={d.thickness} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

// ------------------------------------------------------------------ menu

export interface SignMenuProps {
  pt: boolean;
  /** pdfjsLib do visualizador (para importar assinaturas antigas e ler fotos/texto) */
  getLib: () => any;
  onPick: (d: SigDrawing, kind: SigKind) => void;
  onCertificate: () => void;
  onClose: () => void;
}

export function SignMenu({ pt, getLib, onPick, onCertificate, onClose }: SignMenuProps) {
  const [list, setList] = useState<SavedSig[]>(() => (typeof window === 'undefined' ? [] : loadSignatures()));
  const [creating, setCreating] = useState<SigKind | null>(null);
  useBackClose(onClose);

  useEffect(() => {
    let alive = true;
    importOldSignatures(getLib()).then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, [getLib]);

  const section = (kind: SigKind) => {
    const items = list.filter((s) => s.kind === kind);
    const title = kind === 'signature' ? (pt ? 'Assinatura' : 'Signature') : pt ? 'Rubrica' : 'Initials';
    const createLabel =
      kind === 'signature' ? (pt ? 'Criar assinatura' : 'Create signature') : pt ? 'Criar rubrica' : 'Create initials';
    return (
      <section className="sg-sec" key={kind}>
        <h3 className="rs-h3">{title}</h3>
        <div className="sg-cards">
          {items.map((s) => (
            <div className="sg-card-wrap" key={s.id}>
              <button
                type="button"
                className="sg-card"
                onClick={() => onPick(s, kind)}
                aria-label={pt ? `Colocar ${title.toLowerCase()} salva` : `Place saved ${title.toLowerCase()}`}
              >
                <SigPreview d={s} className="sg-card-svg" />
              </button>
              <button
                type="button"
                className="sg-card-del"
                aria-label={pt ? 'Apagar' : 'Delete'}
                onClick={() => setList(removeSignature(s.id))}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ))}
          <button type="button" className="sg-card sg-card-new" onClick={() => setCreating(kind)}>
            <Plus aria-hidden="true" />
            <span>{createLabel}</span>
          </button>
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="rs-back" onClick={onClose}>
        <div className="rs-sheet rs-menu sg-menu" role="dialog" aria-modal="true" aria-label={pt ? 'Assinar' : 'Sign'} onClick={(e) => e.stopPropagation()}>
          <div className="rs-grip" />
          <div className="rs-head">
            <span className="rs-icon-space" />
            <h2 className="rs-title">{pt ? 'Assinar' : 'Sign'}</h2>
            <button type="button" className="rs-icon-btn" onClick={onClose} aria-label={pt ? 'Fechar' : 'Close'}>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="rs-body">
            {section('signature')}
            {section('initials')}
            <p className="sg-tip">
              {pt
                ? 'Toque numa assinatura para colocar no documento. Depois é só arrastar e puxar o canto para mudar o tamanho.'
                : 'Tap a signature to place it. Then drag it and pull a corner to resize.'}
            </p>
            <button type="button" className="rs-row sg-cert" onClick={onCertificate}>
              <span className="rs-cat-ic">
                <BadgeCheck aria-hidden="true" />
              </span>
              <span className="rs-row-text">
                <span className="rs-row-name">{pt ? 'Assinatura digital com certificado' : 'Digital signature with certificate'}</span>
                <span className="rs-row-dim">{pt ? 'Com arquivo .pfx / .p12 (ICP-Brasil, e-CPF…)' : 'With a .pfx / .p12 file'}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
      {creating && (
        <SignCreator
          pt={pt}
          kind={creating}
          getLib={getLib}
          onClose={() => setCreating(null)}
          onDone={(d, save) => {
            if (save) setList(addSignature(creating, d));
            const kind = creating;
            setCreating(null);
            onPick(d, kind);
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ criar

type Tab = 'draw' | 'type' | 'image';

interface CreatorProps {
  pt: boolean;
  kind: SigKind;
  getLib: () => any;
  onDone: (d: SigDrawing, save: boolean) => void;
  onClose: () => void;
}

/** traços: lista de pontos [x0,y0,x1,y1,...] em px da área de desenho */
type Stroke = number[];

function cropStrokes(strokes: Stroke[], thickness: number): { curves: number[][]; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      minX = Math.min(minX, s[i]);
      maxX = Math.max(maxX, s[i]);
      minY = Math.min(minY, s[i + 1]);
      maxY = Math.max(maxY, s[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const m = thickness * 2;
  const curves = strokes.filter((s) => s.length >= 2).map((s) => s.map((v, i) => (i % 2 === 0 ? v - minX + m : v - minY + m)));
  return { curves, width: Math.max(1, maxX - minX + m * 2), height: Math.max(1, maxY - minY + m * 2) };
}

/** imagem com tinta escura em fundo branco -> contornos do PDF.js */
async function extractFromCanvas(lib: any, canvas: HTMLCanvasElement): Promise<{ curves: number[][]; width: number; height: number } | null> {
  if (!lib?.SignatureExtractor) throw new Error('viewer not ready');
  const bitmap = await createImageBitmap(canvas);
  try {
    const r = lib.SignatureExtractor.process(bitmap, 612, 792, 0, 0, { isClean: true, threshold: 191, maxDim: 2048 });
    if (!r || !r.newCurves?.length) return null;
    return { curves: r.newCurves.map((p: ArrayLike<number>) => Array.from(p)), width: r.width, height: r.height };
  } finally {
    bitmap.close?.();
  }
}

export function SignCreator({ pt, kind, getLib, onDone, onClose }: CreatorProps) {
  useBackClose(onClose);
  const [tab, setTab] = useState<Tab>('draw');
  const [color, setColor] = useState<string>(SIG_COLORS[0].hex);
  const [width, setWidth] = useState<number>(WIDTHS[1].px);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // desenhar
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const paperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<Stroke | null>(null);

  // digitar
  const [name, setName] = useState('');
  const [font, setFont] = useState<string>(FONTS[0].id);
  const [fontsReady, setFontsReady] = useState(false);

  // imagem
  const [image, setImage] = useState<{ curves: number[][]; width: number; height: number } | null>(null);

  useEffect(() => {
    loadFonts().then(() => setFontsReady(true));
  }, []);

  const title =
    kind === 'signature' ? (pt ? 'Criar assinatura' : 'Create signature') : pt ? 'Criar rubrica' : 'Create initials';

  // ---- desenho na tela
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const paper = paperRef.current;
    if (!canvas || !paper) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = paper.clientWidth;
    const h = paper.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const all = liveRef.current ? [...strokes, liveRef.current] : strokes;
    for (const s of all) {
      if (s.length === 2) {
        ctx.beginPath();
        ctx.arc(s[0], s[1], width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      for (let i = 2; i + 3 < s.length; i += 2) {
        const mx = (s[i] + s[i + 2]) / 2;
        const my = (s[i + 1] + s[i + 3]) / 2;
        ctx.quadraticCurveTo(s[i], s[i + 1], mx, my);
      }
      ctx.lineTo(s[s.length - 2], s[s.length - 1]);
      ctx.stroke();
    }
  }, [strokes, color, width]);

  useEffect(() => {
    if (tab !== 'draw') return;
    redraw();
    const paper = paperRef.current;
    if (!paper || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(paper);
    return () => ro.disconnect();
  }, [redraw, tab]);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = paperRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ok */
    }
    const [x, y] = point(e);
    liveRef.current = [x, y];
    setError(null);
    redraw();
  };
  const onMove = (e: React.PointerEvent) => {
    const live = liveRef.current;
    if (!live) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const r = paperRef.current!.getBoundingClientRect();
    const list = events.length ? events.map((ev) => [ev.clientX - r.left, ev.clientY - r.top]) : [point(e)];
    for (const [x, y] of list) {
      const lx = live[live.length - 2];
      const ly = live[live.length - 1];
      if (Math.hypot(x - lx, y - ly) >= 1.2) live.push(x, y);
    }
    redraw();
  };
  const onUp = () => {
    const live = liveRef.current;
    liveRef.current = null;
    if (live) {
      setStrokes((s) => [...s, live]);
      setRedoStack([]);
    }
  };

  // ---- imagem / foto
  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setImage(null);
    try {
      const scanner: any = await import(/* webpackIgnore: true */ withBasePath('/pdfjs-viewer/pdfcraft_signature_scanner.js'));
      const photo = await createImageBitmap(file);
      const draw = (sx: number, sy: number, sw: number, sh: number, maxDim: number) => {
        const ratio = Math.min(1, maxDim / Math.max(sw, sh));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(sw * ratio));
        c.height = Math.max(1, Math.round(sh * ratio));
        const cx = c.getContext('2d', { willReadFrequently: true })!;
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, c.width, c.height);
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(photo, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return { c, cx };
      };
      // 1) acha onde está a assinatura na foto
      const small = draw(0, 0, photo.width, photo.height, 1024);
      const region = scanner.detectSignatureRegion(small.cx.getImageData(0, 0, small.c.width, small.c.height).data, small.c.width, small.c.height);
      const k = photo.width / small.c.width;
      const crop = region
        ? { x: region.x * k, y: region.y * k, w: region.width * k, h: region.height * k }
        : { x: 0, y: 0, w: photo.width, h: photo.height };
      // 2) separa a tinta do papel
      const area = draw(crop.x, crop.y, crop.w, crop.h, 2400);
      const scale = area.c.width / crop.w;
      const { alpha, bounds } = scanner.extractInk(area.cx.getImageData(0, 0, area.c.width, area.c.height).data, area.c.width, area.c.height, {
        backgroundRadius: Math.max(photo.width, photo.height) * 0.012 * scale,
      });
      photo.close?.();
      if (!bounds) throw new Error('no ink');
      const ink = scanner.renderInkOnPaper(alpha, area.c.width, area.c.height, bounds);
      const out = document.createElement('canvas');
      out.width = ink.width;
      out.height = ink.height;
      out.getContext('2d')!.putImageData(new ImageData(ink.data, ink.width, ink.height), 0, 0);
      // 3) vira contorno de assinatura
      const r = await extractFromCanvas(getLib(), out);
      if (!r) throw new Error('no data');
      setImage(r);
    } catch (err) {
      console.warn('[assinatura] foto', err);
      setError(
        pt
          ? 'Não encontrei a assinatura na imagem. Assine num papel branco com caneta escura e tire a foto de perto, com boa luz.'
          : 'No signature found in the image. Sign on white paper with a dark pen and take the photo close, with good light.'
      );
    } finally {
      setBusy(false);
    }
  };

  // ---- concluir
  const canFinish =
    !busy && ((tab === 'draw' && strokes.length > 0) || (tab === 'type' && name.trim().length > 0 && fontsReady) || (tab === 'image' && !!image));

  const finish = async () => {
    if (!canFinish) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === 'draw') {
        const c = cropStrokes(strokes, width);
        if (!c) return;
        onDone({ ...c, thickness: width, areContours: false, color }, save);
        return;
      }
      if (tab === 'type') {
        const f = FONTS.find((x) => x.id === font) || FONTS[0];
        const size = 160;
        const probe = document.createElement('canvas').getContext('2d')!;
        probe.font = `${size}px "${f.family}"`;
        const m = probe.measureText(name.trim());
        const asc = m.actualBoundingBoxAscent || size * 0.8;
        const desc = m.actualBoundingBoxDescent || size * 0.3;
        const left = m.actualBoundingBoxLeft || 0;
        const right = m.actualBoundingBoxRight || m.width;
        const pad = 30;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(left + right + pad * 2);
        canvas.height = Math.ceil(asc + desc + pad * 2);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.font = probe.font;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(name.trim(), pad + left, pad + asc);
        const r = await extractFromCanvas(getLib(), canvas);
        if (!r) throw new Error('no data');
        onDone({ ...r, thickness: 0, areContours: true, color }, save);
        return;
      }
      if (tab === 'image' && image) {
        onDone({ ...image, thickness: 0, areContours: true, color }, save);
      }
    } catch (err) {
      console.warn('[assinatura] concluir', err);
      setError(pt ? 'Não foi possível criar a assinatura. Tente de novo.' : 'Could not create the signature. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const colors = (
    <div className="sg-colors" role="radiogroup" aria-label={pt ? 'Cor' : 'Color'}>
      {SIG_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={color === c.hex}
          aria-label={pt ? c.pt : c.en}
          className="sg-color"
          style={{ background: c.hex }}
          onClick={() => setColor(c.hex)}
        >
          {color === c.hex && <Check aria-hidden="true" />}
        </button>
      ))}
    </div>
  );

  const placeholderName = kind === 'signature' ? (pt ? 'Seu nome' : 'Your name') : pt ? 'Suas iniciais' : 'Your initials';

  return (
    <div className="sg-full" role="dialog" aria-modal="true" aria-label={title}>
      <header className="sg-top">
        <button type="button" className="rs-icon-btn" onClick={onClose} aria-label={pt ? 'Fechar' : 'Close'}>
          <X aria-hidden="true" />
        </button>
        <h2 className="sg-title">{title}</h2>
        <button type="button" className="sg-done" onClick={finish} disabled={!canFinish}>
          {pt ? 'Concluído' : 'Done'}
        </button>
      </header>

      <div className="sg-tabs" role="tablist">
        {(
          [
            ['draw', Pencil, pt ? 'Desenhar' : 'Draw'],
            ['type', Type, pt ? 'Digitar' : 'Type'],
            ['image', ImageIcon, pt ? 'Imagem' : 'Image'],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="sg-tab"
            onClick={() => {
              setTab(id);
              setError(null);
            }}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div className="sg-body">
        {tab === 'draw' && (
          <>
            <div
              ref={paperRef}
              className={`sg-paper ${kind === 'initials' ? 'sg-paper-small' : ''}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              data-testid="sign-pad"
            >
              <canvas ref={canvasRef} className="sg-canvas" />
              <div className="sg-line" aria-hidden="true">
                <span className="sg-x">✕</span>
              </div>
              {strokes.length === 0 && <div className="sg-hint">{kind === 'signature' ? (pt ? 'Assine aqui' : 'Sign here') : pt ? 'Rubrique aqui' : 'Initial here'}</div>}
            </div>
            <div className="sg-tools">
              {colors}
              <div className="sg-widths" role="radiogroup" aria-label={pt ? 'Espessura' : 'Thickness'}>
                {WIDTHS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="radio"
                    aria-checked={width === w.px}
                    className="sg-width"
                    aria-label={w.id === 'thin' ? (pt ? 'Fina' : 'Thin') : w.id === 'mid' ? (pt ? 'Média' : 'Medium') : pt ? 'Grossa' : 'Thick'}
                    onClick={() => setWidth(w.px)}
                  >
                    <span style={{ height: w.px + 1, background: color }} />
                  </button>
                ))}
              </div>
              <div className="sg-acts">
                <button
                  type="button"
                  className="sg-act"
                  aria-label={pt ? 'Desfazer' : 'Undo'}
                  disabled={!strokes.length}
                  onClick={() => {
                    setRedoStack((r) => [...r, strokes[strokes.length - 1]]);
                    setStrokes((s) => s.slice(0, -1));
                  }}
                >
                  <Undo2 aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sg-act"
                  aria-label={pt ? 'Refazer' : 'Redo'}
                  disabled={!redoStack.length}
                  onClick={() => {
                    setStrokes((s) => [...s, redoStack[redoStack.length - 1]]);
                    setRedoStack((r) => r.slice(0, -1));
                  }}
                >
                  <Redo2 aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sg-act sg-clear"
                  disabled={!strokes.length}
                  onClick={() => {
                    setStrokes([]);
                    setRedoStack([]);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {pt ? 'Limpar' : 'Clear'}
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'type' && (
          <div className="sg-type">
            <input
              className="sg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholderName}
              autoComplete="name"
              maxLength={kind === 'initials' ? 6 : 60}
            />
            <div className="sg-styles" role="radiogroup" aria-label={pt ? 'Estilo da letra' : 'Font style'}>
              {FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={font === f.id}
                  className="sg-style"
                  onClick={() => setFont(f.id)}
                >
                  <span style={{ fontFamily: `"${f.family}", cursive`, color }}>{name.trim() || placeholderName}</span>
                </button>
              ))}
            </div>
            {colors}
          </div>
        )}

        {tab === 'image' && (
          <div className="sg-image">
            <div className="sg-paper sg-paper-preview">
              {image ? (
                <SigPreview d={{ ...image, thickness: 0, areContours: true, color }} className="sg-img-svg" />
              ) : (
                <div className="sg-img-empty">
                  {busy
                    ? pt
                      ? 'Lendo a assinatura…'
                      : 'Reading the signature…'
                    : pt
                      ? 'Assine num papel branco com caneta escura e tire uma foto. O app tira o fundo sozinho.'
                      : 'Sign on white paper with a dark pen and take a photo. The app removes the background.'}
                </div>
              )}
            </div>
            <div className="sg-img-btns">
              <label className="sg-pick">
                <Camera aria-hidden="true" />
                {pt ? 'Tirar foto' : 'Take photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    onPhoto(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="sg-pick">
                <ImageIcon aria-hidden="true" />
                {pt ? 'Escolher imagem' : 'Choose image'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    onPhoto(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {image && colors}
          </div>
        )}

        {error && <p className="sg-error">{error}</p>}
      </div>

      <label className="sg-save">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        <span>{pt ? 'Salvar para usar de novo' : 'Save for next time'}</span>
      </label>
    </div>
  );
}
