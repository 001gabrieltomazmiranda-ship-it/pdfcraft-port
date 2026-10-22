'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, LayoutGrid, Search, Plus, FileText, Star } from 'lucide-react';
import { getAllTools, getToolById } from '@/config/tools';
import { getToolIcon } from '@/config/icons';
import { isTauri } from '@/lib/tauri-bridge';
import type { ToolCategory } from '@/types/tool';
import HomePageClient from '@/app/[locale]/HomePageClient';
import ToolsPageClient from '@/app/[locale]/tools/ToolsPageClient';
import MobileTools from './MobileTools';
import { useToolLauncher } from './ToolLauncher';
import type { Locale } from '@/lib/i18n/config';
import { listRecent, toggleFav, type RecentDoc } from '@/lib/mobile-files';
import './mobile.css';
import PasswordEyes from './PasswordEyes';

type Content = Record<string, { title: string; description: string }>;

function useIsMobile(): boolean | null {
  const [mobile, setMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(isTauri() || mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return mobile;
}

const PT = (l: string) => l.startsWith('pt');

export function MobileShell({ locale, children }: { locale: string; children: ReactNode }) {
  const mobile = useIsMobile();
  const path = usePathname() || '';
  useEffect(() => {
    const el = document.documentElement;
    if (mobile) {
      el.setAttribute('data-mobile', 'true');
      el.classList.add('dark');
    } else {
      el.removeAttribute('data-mobile');
    }
    return () => el.removeAttribute('data-mobile');
  }, [mobile]);

  const pt = PT(locale);
  const items = [
    { href: `/${locale}`, label: pt ? 'Início' : 'Home', Icon: Home, exact: true },
    { href: `/${locale}/tools`, label: pt ? 'Ferramentas' : 'Tools', Icon: LayoutGrid },
  ];
  const norm = path.replace(/\/$/, '');
  return (
    <>
      {children}
      {mobile && <PasswordEyes pt={pt} />}
      {mobile && (
        <nav className="m-nav" aria-label="Principal">
          {items.map(({ href, label, Icon, exact }) => {
            const active = exact ? norm === href : norm.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
                <Icon aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}

const CATS: { id: ToolCategory; pt: string; en: string }[] = [
  { id: 'organize-manage', pt: 'Organizar', en: 'Organize' },
  { id: 'edit-annotate', pt: 'Editar', en: 'Edit' },
  { id: 'convert-to-pdf', pt: 'Converter para PDF', en: 'Convert to PDF' },
  { id: 'convert-from-pdf', pt: 'Converter de PDF', en: 'Convert from PDF' },
  { id: 'optimize-repair', pt: 'Otimizar e reparar', en: 'Optimize & repair' },
  { id: 'secure-pdf', pt: 'Proteger', en: 'Secure' },
];

function Tile({ id, content, onPick }: { id: string; content: Content; onPick: (id: string) => void }) {
  const tool = getToolById(id);
  if (!tool) return null;
  const Icon = getToolIcon(tool.icon);
  const name = content[tool.id]?.title || tool.id.replace(/-/g, ' ');
  return (
    <button type="button" className="m-tile" onClick={() => onPick(tool.id)}>
      <Icon aria-hidden="true" />
      <span>{name}</span>
    </button>
  );
}


function fmtSize(n: number): string {
  return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}

function fmtTime(t: number, locale: string): string {
  const d = new Date(t);
  const same = d.toDateString() === new Date().toDateString();
  return same
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function MobileHome({ locale, content }: { locale: string; content: Content }) {
  const pt = PT(locale);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const router = useRouter();
  const titles = Object.fromEntries(Object.entries(content).map(([id, c]) => [id, c.title]));
  const { launch, openPicker, elements } = useToolLauncher(locale, titles);
  const [tab, setTab] = useState<'recent' | 'fav'>('recent');
  const [docs, setDocs] = useState<RecentDoc[]>([]);
  useEffect(() => {
    setDocs(listRecent());
  }, []);
  const openDoc = (id: string) => router.push('/' + locale + '/reader/?id=' + id);
  const shownDocs = tab === 'fav' ? docs.filter((d) => d.fav) : docs;
  const all = getAllTools();
  const found = q.trim()
    ? all.filter((t) => (content[t.id]?.title || t.id).toLowerCase().includes(q.trim().toLowerCase()))
    : [];
  const quick = ['merge-pdf', 'split-pdf', 'compress-pdf', 'sign-pdf'];
  return (
    <div className="m-home">
      <h1 className="m-logo">PDF<span>Craft</span></h1>
      <label className="m-search">
        <Search size={20} aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={pt ? 'Buscar entre as ferramentas' : 'Search tools'}
          aria-label={pt ? 'Buscar ferramentas' : 'Search tools'}
        />
      </label>
      {q.trim() ? (
        <div className="m-grid" style={{ marginTop: 16 }}>
          {found.map((t) => <Tile key={t.id} id={t.id} content={content} onPick={launch} />)}
        </div>
      ) : (
        <>
          <h2 className="m-h2">{pt ? 'Ações rápidas' : 'Quick actions'}</h2>
          <div className="m-grid">
            {quick.map((id) => <Tile key={id} id={id} content={content} onPick={launch} />)}
          </div>
          <div className="m-tabs" role="tablist">
            <button className="m-tab" role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>
              {pt ? 'Recente' : 'Recent'}
            </button>
            <button className="m-tab" role="tab" aria-selected={tab === 'fav'} onClick={() => setTab('fav')}>
              {pt ? 'Favoritos' : 'Favorites'}
            </button>
            <button className="m-tab" role="tab" aria-selected={false} onClick={openPicker}>
              {pt ? 'No dispositivo' : 'On device'}
            </button>
          </div>
          {shownDocs.length === 0 ? (
            <p className="m-empty">
              {pt ? 'Nenhum arquivo ainda. Toque no + para abrir um PDF.' : 'No files yet. Tap + to open a PDF.'}
            </p>
          ) : (
            <ul className="m-docs">
              {shownDocs.map((d) => (
                <li key={d.id} className="m-doc">
                  <button className="m-doc-main" onClick={() => openDoc(d.id)}>
                    <span className="m-doc-ic"><FileText size={22} aria-hidden="true" /></span>
                    <span>
                      <span className="m-doc-name" style={{ display: 'block' }}>{d.name}</span>
                      <span className="m-doc-meta">PDF · {fmtTime(d.time, locale)} · {fmtSize(d.size)}</span>
                    </span>
                  </button>
                  <button
                    className="m-doc-btn"
                    aria-label={pt ? 'Favoritar' : 'Favorite'}
                    aria-pressed={d.fav}
                    onClick={() => setDocs(toggleFav(d.id))}
                  >
                    <Star size={22} fill={d.fav ? 'currentColor' : 'none'} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2 className="m-h2">{pt ? 'Ferramentas' : 'Tools'}</h2>
          {CATS.map((c) => {
            const list = all.filter((t) => t.category === c.id);
            const shown = open[c.id] ? list : list.slice(0, 8);
            return (
              <section key={c.id}>
                <div className="m-h2 m-h2-row">
                  <span>{pt ? c.pt : c.en}</span>
                  {list.length > 8 && (
                    <button className="m-more" onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}>
                      {open[c.id] ? (pt ? 'Ver menos' : 'Less') : (pt ? `Ver todas (${list.length})` : `All (${list.length})`)}
                    </button>
                  )}
                </div>
                <div className="m-grid">
                  {shown.map((t) => <Tile key={t.id} id={t.id} content={content} onPick={launch} />)}
                </div>
              </section>
            );
          })}
        </>
      )}
      <button className="m-fab" aria-label={pt ? 'Abrir PDF' : 'Open PDF'} onClick={openPicker}>
        <Plus aria-hidden="true" />
      </button>
      {elements}
    </div>
  );
}

export function HomeSwitch({ locale, localizedToolContent }: { locale: Locale; localizedToolContent: Content }) {
  const mobile = useIsMobile();
  if (mobile === null) return null;
  if (mobile) return <MobileHome locale={locale} content={localizedToolContent} />;
  return <HomePageClient locale={locale} localizedToolContent={localizedToolContent} />;
}

export function ToolsSwitch({ locale, localizedToolContent }: { locale: Locale; localizedToolContent: Content }) {
  const mobile = useIsMobile();
  if (mobile === null) return null;
  if (mobile) return <MobileTools locale={locale} content={localizedToolContent} />;
  return <ToolsPageClient locale={locale} localizedToolContent={localizedToolContent} />;
}
