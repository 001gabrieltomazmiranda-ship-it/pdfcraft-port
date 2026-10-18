interface ViewerOptions {
  set: (name: string, value: number) => void;
}
type WinLike = Window & { PDFViewerApplicationOptions?: ViewerOptions };

// O visualizador já tem zoom por pinça. Aqui só bloqueamos o zoom nativo do
// Android (que brigava com o do visualizador) e deixamos o redesenho mais rápido.
export function installPinchZoom(win: Window, doc: Document): void {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  meta.setAttribute(
    'content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
  );
  const container = doc.getElementById('viewerContainer');
  if (container) container.style.touchAction = 'pan-x pan-y';
  (win as WinLike).PDFViewerApplicationOptions?.set('defaultZoomDelay', 150);
}
