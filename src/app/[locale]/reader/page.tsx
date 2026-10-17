import { setRequestLocale } from 'next-intl/server';
import { locales } from '@/lib/i18n/config';
import MobileReader from '@/components/mobile/MobileReader';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function ReaderPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <MobileReader locale={locale} />;
}
