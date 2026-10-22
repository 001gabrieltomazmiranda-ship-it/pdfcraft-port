/** Idioma da tela, para as mensagens que saem do processamento dos PDFs. */
export function isPortuguese(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const first = window.location.pathname.split('/').filter(Boolean)[0] || '';
    if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(first)) return first.toLowerCase().startsWith('pt');
    const marked = document.querySelector('[lang]:not(html)')?.getAttribute('lang');
    return /^pt/i.test(marked || navigator.language || '');
  } catch {
    return false;
  }
}

/** Escolhe o texto em português ou inglês. */
export function tr(pt: string, en: string): string {
  return isPortuguese() ? pt : en;
}
