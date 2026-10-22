'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Mail,
  PenTool,
  Play,
  Presentation,
  Printer,
  Search,
  Sliders,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useBackClose } from '../backStack';
import {
  CATEGORIES,
  FORMATS,
  MAX_PT,
  MIN_PT,
  SUGGESTED,
  UNITS,
  fmtNum,
  fmtSize,
  fromPt,
  parseNum,
  parseSizeQuery,
  searchFormats,
  toPt,
  unitLabel,
  type CategoryId,
  type Format,
  type Unit,
} from './formats';
import type { FitMode } from './resizePdf';

export interface ResizeRequest {
  width: number;
  height: number;
  mode: FitMode;
  pages: 'all' | 'current';
  label: string;
}

interface Sel {
  id: string;
  name: string;
  w: number;
  h: number;
  unit: Unit;
}

interface Saved {
  w: number;
  h: number;
  unit: Unit;
}

const SAVED_KEY = 'pdfcraft_resize_saved';
const PREFS_KEY = 'pdfcraft_resize_prefs';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

const CAT_ICON: Record<CategoryId, typeof Users> = {
  social: Users,
  print: Printer,
  slides: Presentation,
  video: Play,
  site: Globe,
  whiteboard: PenTool,
  docs: FileText,
  cards: Mail,
  photos: ImageIcon,
  books: BookOpen,
  posters: Layers,
};

/** Botão Voltar do Android dentro do painel: volta uma tela (em vez de fechar tudo). */
function StepBack({ onBack }: { onBack: () => void }) {
  useBackClose(onBack);
  return null;
}

/** Retângulo com a proporção do formato. */
function Shape({ w, h, size = 40 }: { w: number; h: number; size?: number }) {
  const k = size / Math.max(w, h);
  return (
    <span className="rs-shape-box" style={{ width: size, height: size }}>
      <span className="rs-shape" style={{ width: Math.max(6, w * k), height: Math.max(6, h * k) }} />
    </span>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {locked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.8-1.2" />}
    </svg>
  );
}

export default function ResizeSheet({
  pt,
  current,
  pageNum,
  numPages,
  onApply,
  onClose,
}: {
  pt: boolean;
  /** Tamanho da página atual (pontos, como aparece na tela). */
  current: { w: number; h: number };
  pageNum: number;
  numPages: number;
  onApply: (req: ResizeRequest, copy: boolean) => void;
  onClose: () => void;
}) {
  useBackClose(onClose);
  const T = (p: string, e: string) => (pt ? p : e);
  const prefs = useMemo(
    () => readJson<{ unit?: Unit; mode?: FitMode; lock?: boolean }>(PREFS_KEY, {}),
    []
  );
  const [stack, setStack] = useState<string[]>(['home']);
  const view = stack[stack.length - 1];
  const push = (v: string) => setStack((s) => [...s, v]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<Sel | null>(null);
  const [unit, setUnit] = useState<Unit>(prefs.unit || 'mm');
  const [wText, setWText] = useState(() => fmtNum(fromPt(current.w, prefs.unit || 'mm'), prefs.unit || 'mm', pt));
  const [hText, setHText] = useState(() => fmtNum(fromPt(current.h, prefs.unit || 'mm'), prefs.unit || 'mm', pt));
  const [lock, setLock] = useState(!!prefs.lock);
  const ratioRef = useRef(current.w / current.h);
  const [unitOpen, setUnitOpen] = useState(false);
  const [mode, setMode] = useState<FitMode>(prefs.mode || 'fit');
  const [pages, setPages] = useState<'all' | 'current'>('all');
  const [saved, setSaved] = useState<Saved[]>(() => readJson<Saved[]>(SAVED_KEY, []));

  useEffect(() => {
    writeJson(PREFS_KEY, { unit, mode, lock });
  }, [unit, mode, lock]);

  const fname = (fm: Format) => (pt ? fm.name.pt : fm.name.en);
  const wNum = parseNum(wText);
  const hNum = parseNum(hText);
  const wPt = toPt(wNum, unit);
  const hPt = toPt(hNum, unit);
  const fieldsValid = wNum > 0 && hNum > 0 && wPt >= MIN_PT && hPt >= MIN_PT && wPt <= MAX_PT && hPt <= MAX_PT;
  const fieldError =
    !(wNum > 0) || !(hNum > 0)
      ? T('Digite a largura e a altura.', 'Enter width and height.')
      : !fieldsValid
        ? T(
            `Use valores entre ${fmtNum(fromPt(MIN_PT, unit), unit, pt)} e ${fmtNum(fromPt(MAX_PT, unit), unit, pt)} ${unitLabel(unit, pt)}.`,
            `Use values between ${fmtNum(fromPt(MIN_PT, unit), unit, pt)} and ${fmtNum(fromPt(MAX_PT, unit), unit, pt)} ${unitLabel(unit, pt)}.`
          )
        : '';

  /** Deixa os campos e a seleção com um tamanho (formato, salvo ou digitado). */
  const choose = (id: string, name: string, w: number, h: number, u: Unit) => {
    setSel({ id, name, w, h, unit: u });
    setUnit(u);
    setWText(fmtNum(w, u, pt));
    setHText(fmtNum(h, u, pt));
    ratioRef.current = w / h;
  };

  const pickFormat = (fm: Format) => {
    if (sel?.id === fm.id) {
      setSel(null);
      return;
    }
    choose(fm.id, fname(fm), fm.w, fm.h, fm.unit);
  };

  /** A pessoa digitou nos campos: vira "Personalizado". */
  const setCustom = (wt: string, ht: string, u: Unit) => {
    setWText(wt);
    setHText(ht);
    const w = parseNum(wt);
    const h = parseNum(ht);
    const ok = w > 0 && h > 0 && toPt(w, u) >= MIN_PT && toPt(h, u) >= MIN_PT && toPt(w, u) <= MAX_PT && toPt(h, u) <= MAX_PT;
    setSel(ok ? { id: 'custom', name: T('Personalizado', 'Custom'), w, h, unit: u } : null);
  };

  const onWidth = (t: string) => {
    const w = parseNum(t);
    if (lock && w > 0 && ratioRef.current > 0) setCustom(t, fmtNum(w / ratioRef.current, unit, pt), unit);
    else setCustom(t, hText, unit);
  };

  const onHeight = (t: string) => {
    const h = parseNum(t);
    if (lock && h > 0 && ratioRef.current > 0) setCustom(fmtNum(h * ratioRef.current, unit, pt), t, unit);
    else setCustom(wText, t, unit);
  };

  const changeUnit = (u: Unit) => {
    setUnitOpen(false);
    if (u === unit) return;
    // muda só a unidade: o tamanho real continua o mesmo
    const w = wNum > 0 ? fmtNum(fromPt(toPt(wNum, unit), u), u, pt) : wText;
    const h = hNum > 0 ? fmtNum(fromPt(toPt(hNum, unit), u), u, pt) : hText;
    setUnit(u);
    if (sel && sel.id !== 'custom') {
      setWText(w);
      setHText(h);
      setSel({ ...sel, w: parseNum(w), h: parseNum(h), unit: u });
    } else setCustom(w, h, u);
  };

  const toggleLock = () => {
    if (!lock && wNum > 0 && hNum > 0) ratioRef.current = wNum / hNum;
    setLock(!lock);
  };

  const orient = wNum > 0 && hNum > 0 ? (Math.abs(wNum - hNum) < 1e-9 ? 'square' : wNum > hNum ? 'landscape' : 'portrait') : null;
  const setOrient = (o: 'portrait' | 'square' | 'landscape') => {
    if (!(wNum > 0 && hNum > 0)) return;
    let w = wNum;
    let h = hNum;
    if (o === 'portrait' && w > h) [w, h] = [h, w];
    if (o === 'landscape' && h > w) [w, h] = [h, w];
    if (o === 'square') h = w;
    ratioRef.current = w / h;
    setCustom(fmtNum(w, unit, pt), fmtNum(h, unit, pt), unit);
  };

  const saveSize = () => {
    if (!fieldsValid) return;
    const item = { w: wNum, h: hNum, unit };
    const next = [item, ...saved.filter((s) => !(s.unit === unit && s.w === wNum && s.h === hNum))].slice(0, 12);
    setSaved(next);
    writeJson(SAVED_KEY, next);
  };

  const removeSaved = (i: number) => {
    const next = saved.filter((_, k) => k !== i);
    setSaved(next);
    writeJson(SAVED_KEY, next);
  };

  const apply = (copy: boolean) => {
    if (!sel) return;
    onApply(
      {
        width: toPt(sel.w, sel.unit),
        height: toPt(sel.h, sel.unit),
        mode,
        pages,
        label: `${sel.name} · ${fmtSize(sel.w, sel.h, sel.unit, pt)}`,
      },
      copy
    );
  };

  // ---------- pedaços da tela ----------

  const check = (on: boolean) => (
    <span className={'rs-check' + (on ? ' on' : '')} aria-hidden="true">
      {on && <Check />}
    </span>
  );

  const formatRow = (fm: Format) => {
    const on = sel?.id === fm.id;
    return (
      <button key={fm.id} type="button" className="rs-row" aria-pressed={on} onClick={() => pickFormat(fm)}>
        {check(on)}
        <Shape w={fm.w} h={fm.h} size={30} />
        <span className="rs-row-text">
          <span className="rs-row-name">{fname(fm)}</span>
          <span className="rs-row-dim">{fmtSize(fm.w, fm.h, fm.unit, pt)}</span>
        </span>
      </button>
    );
  };

  const savedList = (
    <section>
      <h3 className="rs-h3">{T('Salvo', 'Saved')}</h3>
      {saved.length === 0 ? (
        <p className="rs-note">
          {T('Os tamanhos que você salvar em Tamanho personalizado aparecem aqui.', 'Sizes you save in Custom size show up here.')}
        </p>
      ) : (
        saved.map((s, i) => {
          const id = `saved-${i}`;
          const on = sel?.id === id;
          return (
            <div key={id} className="rs-saved">
              <button
                type="button"
                className="rs-row"
                aria-pressed={on}
                onClick={() => (on ? setSel(null) : choose(id, T('Salvo', 'Saved'), s.w, s.h, s.unit))}
              >
                {check(on)}
                <Shape w={s.w} h={s.h} size={30} />
                <span className="rs-row-text">
                  <span className="rs-row-name">{fmtSize(s.w, s.h, s.unit, pt)}</span>
                </span>
              </button>
              <button type="button" className="rs-icon-btn" aria-label={T('Apagar tamanho salvo', 'Delete saved size')} onClick={() => removeSaved(i)}>
                <Trash2 />
              </button>
            </div>
          );
        })
      )}
    </section>
  );

  const catRow = (id: CategoryId | 'custom' | 'more', label: string, Icon: typeof Users, onClick: () => void, extra?: ReactNode) => (
    <button key={id} type="button" className="rs-row rs-cat" onClick={onClick}>
      <span className="rs-cat-ic">
        <Icon aria-hidden="true" />
      </span>
      <span className="rs-row-text">
        <span className="rs-row-name">{label}</span>
        {extra}
      </span>
      <ChevronRight className="rs-chev" aria-hidden="true" />
    </button>
  );

  const singleRow = (id: CategoryId) => {
    const fm = FORMATS.find((x) => x.cat === id)!;
    const on = sel?.id === fm.id;
    const Icon = CAT_ICON[id];
    return (
      <button key={id} type="button" className="rs-row rs-cat" aria-pressed={on} onClick={() => pickFormat(fm)}>
        {check(on)}
        <span className="rs-cat-ic">
          <Icon aria-hidden="true" />
        </span>
        <span className="rs-row-text">
          <span className="rs-row-name">{fname(fm)}</span>
          <span className="rs-row-dim">{fmtSize(fm.w, fm.h, fm.unit, pt)}</span>
        </span>
      </button>
    );
  };

  let title = T('Redimensionar', 'Resize');
  let body: ReactNode = null;

  if (view === 'home') {
    const found = query.trim() ? searchFormats(query) : null;
    const typed = query.trim() ? parseSizeQuery(query) : null;
    const curUnit = prefs.unit || 'mm';
    body = (
      <>
        <label className="rs-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={T('Busque opções de redimensionamento', 'Search resize options')}
            aria-label={T('Busque opções de redimensionamento', 'Search resize options')}
            enterKeyHint="search"
          />
          {query && (
            <button type="button" className="rs-clear" aria-label={T('Limpar busca', 'Clear search')} onClick={() => setQuery('')}>
              <X />
            </button>
          )}
        </label>
        {found ? (
          <section>
            {typed && (
              <button
                type="button"
                className="rs-row"
                aria-pressed={sel?.id === 'custom'}
                onClick={() => choose('custom', T('Personalizado', 'Custom'), typed.w, typed.h, typed.unit)}
              >
                {check(sel?.id === 'custom')}
                <Shape w={typed.w} h={typed.h} size={30} />
                <span className="rs-row-text">
                  <span className="rs-row-name">{T('Usar este tamanho', 'Use this size')}</span>
                  <span className="rs-row-dim">{fmtSize(typed.w, typed.h, typed.unit, pt)}</span>
                </span>
              </button>
            )}
            {found.map(formatRow)}
            {found.length === 0 && !typed && (
              <div className="rs-empty">
                <p>{T('Nenhum formato encontrado.', 'No format found.')}</p>
                <button type="button" className="rs-link" onClick={() => push('custom')}>
                  {T('Definir um tamanho personalizado', 'Set a custom size')}
                </button>
              </div>
            )}
          </section>
        ) : (
          <>
            <div className="rs-h3row">
              <h3 className="rs-h3">{T('Sugestões', 'Suggestions')}</h3>
              <button type="button" className="rs-link" onClick={() => push('all')}>
                {T('Ver tudo', 'See all')}
              </button>
            </div>
            <div className="rs-cards">
              <button type="button" className="rs-card" onClick={() => push('custom')}>
                <Shape w={current.w} h={current.h} size={56} />
                <span className="rs-card-name">{T('Personalizado', 'Custom')}</span>
                <span className="rs-card-dim">{fmtSize(fromPt(current.w, curUnit), fromPt(current.h, curUnit), curUnit, pt)}</span>
              </button>
              {SUGGESTED.map((id) => {
                const fm = FORMATS.find((x) => x.id === id)!;
                const on = sel?.id === fm.id;
                return (
                  <button key={id} type="button" className="rs-card" aria-pressed={on} onClick={() => pickFormat(fm)}>
                    <span className="rs-card-check">{check(on)}</span>
                    <Shape w={fm.w} h={fm.h} size={56} />
                    <span className="rs-card-name">{fname(fm)}</span>
                    <span className="rs-card-dim">{fmtSize(fm.w, fm.h, fm.unit, pt)}</span>
                  </button>
                );
              })}
            </div>
            <h3 className="rs-h3">{T('Pesquisar por categoria', 'Browse by category')}</h3>
            {catRow('custom', T('Tamanho personalizado', 'Custom size'), Sliders, () => push('custom'))}
            {CATEGORIES.filter((c) => !c.more).map((c) =>
              c.single ? singleRow(c.id) : catRow(c.id, pt ? c.name.pt : c.name.en, CAT_ICON[c.id], () => push('cat:' + c.id))
            )}
            {catRow('more', T('Mais', 'More'), LayoutGrid, () => push('more'))}
            {savedList}
          </>
        )}
      </>
    );
  } else if (view.startsWith('cat:')) {
    const id = view.slice(4) as CategoryId;
    const cat = CATEGORIES.find((c) => c.id === id);
    title = cat ? (pt ? cat.name.pt : cat.name.en) : title;
    body = <section>{FORMATS.filter((fm) => fm.cat === id).map(formatRow)}</section>;
  } else if (view === 'more') {
    title = T('Mais', 'More');
    body = (
      <section>
        {CATEGORIES.filter((c) => c.more).map((c) => catRow(c.id, pt ? c.name.pt : c.name.en, CAT_ICON[c.id], () => push('cat:' + c.id)))}
      </section>
    );
  } else if (view === 'all') {
    title = T('Todos os formatos', 'All formats');
    body = (
      <>
        {CATEGORIES.map((c) => (
          <section key={c.id}>
            <h3 className="rs-h3">{pt ? c.name.pt : c.name.en}</h3>
            {FORMATS.filter((fm) => fm.cat === c.id).map(formatRow)}
          </section>
        ))}
      </>
    );
  } else if (view === 'custom') {
    title = T('Tamanho personalizado', 'Custom size');
    body = (
      <>
        <div className="rs-fields">
          <label className="rs-field">
            <span>{T('Largura', 'Width')}</span>
            <input inputMode="decimal" value={wText} onChange={(e) => onWidth(e.target.value)} aria-invalid={!(wNum > 0)} />
          </label>
          <label className="rs-field">
            <span>{T('Altura', 'Height')}</span>
            <input inputMode="decimal" value={hText} onChange={(e) => onHeight(e.target.value)} aria-invalid={!(hNum > 0)} />
          </label>
          <button
            type="button"
            className={'rs-lock' + (lock ? ' on' : '')}
            aria-pressed={lock}
            aria-label={lock ? T('Proporção travada', 'Aspect ratio locked') : T('Proporção livre', 'Aspect ratio unlocked')}
            title={lock ? T('Proporção travada', 'Aspect ratio locked') : T('Proporção livre', 'Aspect ratio unlocked')}
            onClick={toggleLock}
          >
            <LockIcon locked={lock} />
          </button>
          <div className="rs-unit">
            <button type="button" className="rs-unit-btn" aria-haspopup="listbox" aria-expanded={unitOpen} onClick={() => setUnitOpen(!unitOpen)}>
              {unitLabel(unit, pt)}
              <ChevronDown aria-hidden="true" />
            </button>
            {unitOpen && (
              <div className="rs-unit-menu" role="listbox" aria-label={T('Unidade', 'Unit')}>
                {UNITS.map((u) => (
                  <button key={u.id} type="button" role="option" aria-selected={u.id === unit} className="rs-unit-opt" onClick={() => changeUnit(u.id)}>
                    <span>{pt ? u.pt : u.en}</span>
                    <span className="rs-unit-full">{pt ? u.full.pt : u.full.en}</span>
                    {u.id === unit && <Check aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className={'rs-hint' + (fieldError ? ' err' : '')} role={fieldError ? 'alert' : undefined}>
          {fieldError ||
            (lock
              ? T('Proporção travada: mudar um lado ajusta o outro.', 'Ratio locked: changing one side adjusts the other.')
              : T('Toque no cadeado para manter a proporção.', 'Tap the lock to keep the ratio.'))}
        </p>
        <div className="rs-orient" role="group" aria-label={T('Orientação', 'Orientation')}>
          {(
            [
              ['portrait', T('Retrato', 'Portrait'), 22, 30],
              ['square', T('Quadrado', 'Square'), 26, 26],
              ['landscape', T('Paisagem', 'Landscape'), 30, 22],
            ] as const
          ).map(([id, label, w, h]) => (
            <button key={id} type="button" className="rs-orient-btn" aria-pressed={orient === id} onClick={() => setOrient(id)}>
              <span className="rs-orient-shape" style={{ width: w, height: h }} />
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="rs-save" onClick={saveSize} disabled={!fieldsValid}>
          {T('Salvar este tamanho', 'Save this size')}
        </button>
        {savedList}
      </>
    );
  }

  return (
    <div className="rs-back" onClick={onClose}>
      {stack.slice(1).map((v, i) => (
        <StepBack key={i + v} onBack={pop} />
      ))}
      <div className="rs-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rs-grip" aria-hidden="true" />
        <header className="rs-head">
          {stack.length > 1 ? (
            <button type="button" className="rs-icon-btn" aria-label={T('Voltar', 'Back')} onClick={pop}>
              <ArrowLeft />
            </button>
          ) : (
            <span className="rs-icon-space" />
          )}
          <h2 className="rs-title">{title}</h2>
          <button type="button" className="rs-icon-btn" aria-label={T('Fechar', 'Close')} onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="rs-body" key={view}>
          {body}
        </div>
        <footer className="rs-foot">
          <p className="rs-sum">
            {sel ? (
              <>
                <strong>{sel.name}</strong> · {fmtSize(sel.w, sel.h, sel.unit, pt)}
              </>
            ) : (
              T('Escolha um tamanho', 'Choose a size')
            )}
          </p>
          <div className="rs-opts">
            <div className="rs-seg" role="group" aria-label={T('Conteúdo da página', 'Page content')}>
              {(
                [
                  ['fit', T('Ajustar', 'Fit')],
                  ['fill', T('Preencher', 'Fill')],
                  ['stretch', T('Esticar', 'Stretch')],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>
                  {label}
                </button>
              ))}
            </div>
            {numPages > 1 && (
              <div className="rs-seg" role="group" aria-label={T('Páginas', 'Pages')}>
                <button type="button" aria-pressed={pages === 'all'} onClick={() => setPages('all')}>
                  {T('Todas', 'All')}
                </button>
                <button type="button" aria-pressed={pages === 'current'} onClick={() => setPages('current')}>
                  {T(`Pág. ${pageNum}`, `Page ${pageNum}`)}
                </button>
              </div>
            )}
          </div>
          <p className="rs-mode-hint">
            {mode === 'fit'
              ? T('Ajustar: o conteúdo cabe inteiro, sem distorcer.', 'Fit: content fits entirely, no distortion.')
              : mode === 'fill'
                ? T('Preencher: cobre a página toda; as bordas podem ser cortadas.', 'Fill: covers the page; edges may be cut.')
                : T('Esticar: ocupa a página exata; pode distorcer.', 'Stretch: exact page size; may distort.')}
          </p>
          <div className="rs-actions">
            <button type="button" className="rs-btn2" disabled={!sel} onClick={() => apply(true)}>
              {T('Copiar e redimensionar', 'Copy & resize')}
            </button>
            <button type="button" className="rs-btn" disabled={!sel} onClick={() => apply(false)}>
              {T('Redimensionar', 'Resize')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
