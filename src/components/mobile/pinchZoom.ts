interface PdfViewerLike {
  currentScale: number;
}
type WinLike = Window & { PDFViewerApplication?: { pdfViewer?: PdfViewerLike } };

const MIN_SCALE = 0.3;
const MAX_SCALE = 6;

function dist(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function installPinchZoom(win: Window, doc: Document): void {
  const container = doc.getElementById('viewerContainer');
  const viewer = doc.getElementById('viewer');
  if (!container || !viewer) return;
  container.style.touchAction = 'pan-x pan-y';

  let active = false;
  let d0 = 1;
  let s0 = 1;
  let ratio = 1;
  let fx = 0;
  let fy = 0;
  let px = 0;
  let py = 0;

  const getViewer = (): PdfViewerLike | undefined =>
    (win as WinLike).PDFViewerApplication?.pdfViewer;

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    const pv = getViewer();
    if (!pv) return;
    const rect = container.getBoundingClientRect();
    const a = e.touches[0];
    const b = e.touches[1];
    active = true;
    d0 = Math.max(dist(a, b), 1);
    s0 = pv.currentScale;
    ratio = 1;
    fx = (a.clientX + b.clientX) / 2 - rect.left;
    fy = (a.clientY + b.clientY) / 2 - rect.top;
    px = container.scrollLeft + fx - viewer.offsetLeft;
    py = container.scrollTop + fy - viewer.offsetTop;
    viewer.style.transformOrigin = px + 'px ' + py + 'px';
    viewer.style.willChange = 'transform';
  };

  const onMove = (e: TouchEvent) => {
    if (!active || e.touches.length !== 2) return;
    e.preventDefault();
    const r = dist(e.touches[0], e.touches[1]) / d0;
    ratio = Math.min(Math.max(r, MIN_SCALE / s0), MAX_SCALE / s0);
    viewer.style.transform = 'scale(' + ratio + ')';
  };

  const finish = () => {
    if (!active) return;
    active = false;
    viewer.style.transform = '';
    viewer.style.transformOrigin = '';
    viewer.style.willChange = '';
    const pv = getViewer();
    if (!pv || Math.abs(ratio - 1) < 0.01) return;
    const next = Math.min(Math.max(s0 * ratio, MIN_SCALE), MAX_SCALE);
    pv.currentScale = next;
    const k = next / s0;
    container.scrollLeft = px * k + viewer.offsetLeft - fx;
    container.scrollTop = py * k + viewer.offsetTop - fy;
  };

  const onEnd = (e: TouchEvent) => {
    if (active && e.touches.length < 2) finish();
  };

  container.addEventListener('touchstart', onStart, { passive: true });
  container.addEventListener('touchmove', onMove, { passive: false });
  container.addEventListener('touchend', onEnd, { passive: true });
  container.addEventListener('touchcancel', onEnd, { passive: true });
}
