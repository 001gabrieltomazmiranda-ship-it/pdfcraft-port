'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, LayoutGrid, Pencil, GitBranch, Search } from 'lucide-react';
import { getAllTools, getToolBySlug } from '@/config/tools';
import { getToolIcon } from '@/config/icons';
import { isTauri } from '@/lib/tauri-bridge';
import type { ToolCategory } from '@/types/tool';
import HomePageClient from '@/app/[locale]/HomePageClient';
import type { Locale } from '@/lib/i18n/config';
import './mobile.css';

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
    { href: `/${locale}/studio`, label: pt ? 'Estúdio' : 'Studio', Icon: Pencil },
    { href: `/${locale}/workflow`, label: pt ? 'Fluxos' : 'Flows', Icon: GitBranch },
  ];
  const norm = path.replace(/\/$/, '');
  return (
    <>
      {children}
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

function Tile({ slug, locale, content }: { slug: string; locale: string; content: Content }) {
  const tool = getToolBySlug(slug);
  if (!tool) return null;
  const Icon = getToolIcon(tool.icon);
  const name = content[tool.id]?.title || tool.id.replace(/-/g, ' ');
  return (
    <Link href={`/${locale}/tools/${tool.slug}`} className="m-tile">
      <Icon aria-hidden="true" />
      <span>{name}</span>
    </Link>
  );
}

function MobileHome({ locale, content }: { locale: string; content: Content }) {
  const pt = PT(locale);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
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
          {found.map((t) => <Tile key={t.id} slug={t.slug} locale={locale} content={content} />)}
        </div>
      ) : (
        <>
          <h2 className="m-h2">{pt ? 'Ações rápidas' : 'Quick actions'}</h2>
          <div className="m-grid">
            {quick.map((s) => <Tile key={s} slug={s} locale={locale} content={content} />)}
          </div>
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
                  {shown.map((t) => <Tile key={t.id} slug={t.slug} locale={locale} content={content} />)}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

export function HomeSwitch({ locale, localizedToolContent }: { locale: Locale; localizedToolContent: Content }) {
  const mobile = useIsMobile();
  if (mobile === null) return null;
  if (mobile) return <MobileHome locale={locale} content={localizedToolContent} />;
  return <HomePageClient locale={locale} localizedToolContent={localizedToolContent} />;
}
