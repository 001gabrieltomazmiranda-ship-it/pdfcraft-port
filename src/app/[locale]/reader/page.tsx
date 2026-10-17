import { setRequestLocale } from 'next-intl/server';
import { locales, type Locale } from '@/lib/i18n/config';
import MobileReader from '@/components/mobile/MobileReader';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function ReaderPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { tools } = await import('@/config/tools');
  const { getToolContent } = await import('@/config/tool-content');
  const titles = tools.reduce((acc, tool) => {
    const c = getToolContent(locale as Locale, tool.id);
    if (c) acc[tool.id] = c.title;
    return acc;
  }, {} as Record<string, string>);
  return <MobileReader locale={locale} titles={titles} />;
}
