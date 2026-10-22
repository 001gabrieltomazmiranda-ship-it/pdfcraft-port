'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileUploader } from '../FileUploader';
import { ProcessingProgress, ProcessingStatus } from '../ProcessingProgress';
import { DownloadButton } from '../DownloadButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { encryptAndSignCert } from '@/lib/pdf/processors/cert-cryptor';
import { loadPdfjs } from '@/lib/pdf/loader';
import { LockKeyhole, Award, Sparkles, Key, Stamp, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';

/** largura máxima da miniatura da página (px) */
const PREVIEW_W = 280;
const PREVIEW_MAX_H = 400;
/** tamanho do selo no PDF (pt) */
const SEAL_PT = 72;

interface PageThumb {
  url: string;
  /** tamanho da página na tela, em pontos (já girada) */
  w: number;
  h: number;
}

export function CertCryptorTool() {
  const t = useTranslations('common');
  const tTools = useTranslations('tools.certCryptor');

  const [file, setFile] = useState<File | null>(null);
  const [waxColor, setWaxColor] = useState<'gold' | 'red' | 'bronze'>('gold');
  const [pfxPassword, setPfxPassword] = useState('');
  const [encryptWithCert, setEncryptWithCert] = useState(false);

  // página e posição do selo (frações da página, a partir de cima à esquerda)
  const [pageCount, setPageCount] = useState(0);
  const [pageIdx, setPageIdx] = useState(0);
  const [thumb, setThumb] = useState<PageThumb | null>(null);
  const [thumbLoading, setThumbLoading] = useState(false);
  const [seal, setSeal] = useState({ fx: 0.75, fy: 0.82 });
  const previewRef = useRef<HTMLDivElement>(null);

  // animação do carimbo
  const [stampState, setStampState] = useState<'idle' | 'descending' | 'pressing' | 'stamped'>('idle');

  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Blob | null>(null);
  const [resultInfo, setResultInfo] = useState<{ password?: string; signer?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // miniatura da página escolhida
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setThumbLoading(true);
    (async () => {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      try {
        if (cancelled) return;
        setPageCount(doc.numPages);
        const page = await doc.getPage(Math.min(doc.numPages, pageIdx + 1));
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(3, (PREVIEW_W * 2) / vp1.width);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        if (!cancelled) setThumb({ url: canvas.toDataURL('image/jpeg', 0.82), w: vp1.width, h: vp1.height });
      } finally {
        doc.destroy?.();
      }
    })()
      .catch((err) => {
        console.warn('[selo] miniatura', err);
        if (!cancelled) setThumb(null);
      })
      .finally(() => {
        if (!cancelled) setThumbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, pageIdx]);

  // tamanho da caixa de prévia (mesma proporção da página)
  let boxW = PREVIEW_W;
  let boxH = Math.round(PREVIEW_W * (4 / 3));
  if (thumb) {
    boxH = Math.round((PREVIEW_W * thumb.h) / thumb.w);
    if (boxH > PREVIEW_MAX_H) {
      boxH = PREVIEW_MAX_H;
      boxW = Math.round((PREVIEW_MAX_H * thumb.w) / thumb.h);
    }
  }
  const sealPx = Math.max(24, Math.round((boxW * SEAL_PT) / (thumb?.w || 595)));
  const sealX = seal.fx * boxW;
  const sealY = seal.fy * boxH;

  const handleUpload = (uploadedFiles: File[]) => {
    if (uploadedFiles.length > 0) {
      setFile(uploadedFiles[0]);
      setPageIdx(0);
      setThumb(null);
      setResult(null);
      setResultInfo(null);
      setError(null);
      setStatus('idle');
      setStampState('idle');
    }
  };

  const handlePreviewClick = (e: React.MouseEvent) => {
    if (!previewRef.current || stampState === 'descending' || stampState === 'pressing') return;
    const rect = previewRef.current.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    setSeal({ fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) });
    if (stampState === 'stamped') setStampState('idle');
    if (status !== 'processing') {
      setStatus('idle');
      setResult(null);
    }
  };

  const handleProcess = async () => {
    if (!file) return;
    setError(null);
    setResult(null);
    setResultInfo(null);
    setStampState('descending');
    setStatus('processing');
    setProgress(10);

    // o processamento começa já; a animação só acompanha
    const work = encryptAndSignCert(
      file,
      {
        waxColor,
        sealPage: pageIdx,
        sealFx: seal.fx,
        sealFy: seal.fy,
        pfxPassword,
        encryptWithCert,
      },
      (p) => setProgress(Math.max(10, p))
    );
    window.setTimeout(() => setStampState((s) => (s === 'descending' ? 'pressing' : s)), 900);

    try {
      const output = await work;
      if (output.success && output.result) {
        setResult(output.result as Blob);
        setResultInfo({
          password: output.metadata?.openPassword as string | undefined,
          signer: output.metadata?.signer as string | undefined,
        });
        setStatus('complete');
        setStampState('stamped');
      } else {
        const details = output.error?.details ? ` (${output.error.details})` : '';
        setError((output.error?.message || 'Failed to apply wax seal.') + details);
        setStatus('error');
        setStampState('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      setStampState('idle');
    }
  };

  const handleReset = () => {
    setFile(null);
    setResult(null);
    setResultInfo(null);
    setError(null);
    setStatus('idle');
    setStampState('idle');
    setThumb(null);
    setPageCount(0);
    setPageIdx(0);
    setSeal({ fx: 0.75, fy: 0.82 });
  };

  const goPage = (delta: number) => {
    const next = Math.min(Math.max(0, pageIdx + delta), Math.max(0, pageCount - 1));
    if (next === pageIdx) return;
    setPageIdx(next);
    setStampState('idle');
    if (status !== 'processing') {
      setStatus('idle');
      setResult(null);
    }
  };

  const busy = status === 'processing';

  return (
    <Card className="p-6 max-w-4xl mx-auto shadow-2xl bg-neutral-950 border-neutral-850 text-white">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 rounded-lg bg-yellow-600/20 text-yellow-400">
          <LockKeyhole className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-xl font-bold bg-gradient-to-r from-yellow-400 to-amber-400 bg-clip-text text-transparent">
            {tTools('optionsTitle')}
          </h2>
          <p className="text-xs text-neutral-400">{tTools('uploadDescription')}</p>
        </div>
      </div>

      {!file ? (
        <FileUploader accept={['.pdf']} onFilesSelected={handleUpload} label={tTools('uploadLabel')} description={tTools('uploadDescription')} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between p-3 rounded-lg bg-neutral-900 border border-neutral-850">
            <div className="flex items-center gap-3 min-w-0">
              <BookOpen className="w-5 h-5 text-neutral-400 shrink-0" />
              <span className="text-sm font-medium truncate">{file.name}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={busy}
              className="text-xs border-neutral-800 text-neutral-300 hover:bg-neutral-800"
            >
              {t('buttons.reset')}
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Opções */}
            <div className="space-y-6">
              <div className="space-y-3">
                <label className="text-sm font-semibold text-neutral-300 flex items-center gap-1.5">
                  <Stamp className="w-4 h-4 text-yellow-400" />
                  {tTools('waxColor')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'gold', label: t('certCryptor.goldWax'), bg: 'bg-yellow-600 border-yellow-500 text-yellow-100' },
                    { id: 'red', label: t('certCryptor.redWax'), bg: 'bg-red-700 border-red-600 text-red-100' },
                    { id: 'bronze', label: t('certCryptor.bronzeWax'), bg: 'bg-amber-800 border-amber-700 text-amber-100' },
                  ].map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setWaxColor(color.id as 'gold' | 'red' | 'bronze')}
                      disabled={busy}
                      className={`p-2 text-xs rounded-lg border text-center transition-all ${
                        waxColor === color.id
                          ? `${color.bg} scale-105 shadow-lg border-opacity-100`
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400 border-opacity-40'
                      }`}
                    >
                      {color.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Senha para abrir */}
              <div className="space-y-4 p-4 rounded-xl bg-neutral-900 border border-neutral-800">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5">
                    <Key className="w-4 h-4 text-yellow-400 shrink-0" />
                    {t('certCryptor.protectWithPassword')}
                  </span>
                  <input
                    type="checkbox"
                    checked={encryptWithCert}
                    onChange={(e) => setEncryptWithCert(e.target.checked)}
                    disabled={busy}
                    className="w-5 h-5 shrink-0 rounded text-yellow-500 bg-neutral-800 border-neutral-700 focus:ring-yellow-500 accent-yellow-500"
                  />
                </label>

                {encryptWithCert && (
                  <div className="space-y-2 pt-2 border-t border-neutral-800">
                    <label className="text-[11px] text-neutral-400" htmlFor="seal-open-password">
                      {t('certCryptor.openPasswordLabel')}
                    </label>
                    <input
                      id="seal-open-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={t('certCryptor.openPasswordPlaceholder')}
                      value={pfxPassword}
                      onChange={(e) => setPfxPassword(e.target.value)}
                      disabled={busy}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm text-white focus:outline-none focus:border-yellow-500"
                    />
                  </div>
                )}
              </div>

              {status !== 'processing' && status !== 'complete' && (
                <Button onClick={handleProcess} className="w-full bg-yellow-600 hover:bg-yellow-700 font-bold flex items-center justify-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  {tTools('processButton')}
                </Button>
              )}

              {status === 'processing' && <ProcessingProgress progress={progress} status={status} />}

              {status === 'complete' && result && (
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm text-center space-y-1">
                    <p>{tTools('successMessage')}</p>
                    {resultInfo?.signer && <p className="text-xs text-green-300/80">{t('certCryptor.signedBy', { name: resultInfo.signer })}</p>}
                    {resultInfo?.password && (
                      <p className="text-xs text-amber-300">{t('certCryptor.passwordReminder', { password: resultInfo.password })}</p>
                    )}
                  </div>
                  <DownloadButton
                    file={result}
                    filename={file.name.replace(/\.pdf$/i, '_signed.pdf')}
                    className="w-full bg-green-600 hover:bg-green-700 font-bold"
                  />
                </div>
              )}

              {status === 'error' && error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm break-words">{error}</div>
              )}
            </div>

            {/* Página: toque para escolher onde fica o selo */}
            <div className="space-y-3">
              <div className="text-xs text-neutral-400 flex items-center justify-between gap-2">
                <span>{t('certCryptor.tapToPlace')}</span>
                {pageCount > 1 && (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      className="p-1 rounded bg-neutral-900 border border-neutral-800 disabled:opacity-40"
                      onClick={() => goPage(-1)}
                      disabled={busy || pageIdx === 0}
                      aria-label={t('certCryptor.previousPage')}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="tabular-nums">
                      {pageIdx + 1}/{pageCount}
                    </span>
                    <button
                      type="button"
                      className="p-1 rounded bg-neutral-900 border border-neutral-800 disabled:opacity-40"
                      onClick={() => goPage(1)}
                      disabled={busy || pageIdx >= pageCount - 1}
                      aria-label={t('certCryptor.nextPage')}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </span>
                )}
              </div>

              <div
                ref={previewRef}
                onClick={handlePreviewClick}
                data-testid="seal-preview"
                className="relative bg-white rounded-lg mx-auto overflow-hidden shadow-2xl border border-neutral-700 select-none cursor-crosshair"
                style={{ width: boxW, height: boxH }}
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb.url} alt="" draggable={false} className="absolute inset-0 w-full h-full pointer-events-none" />
                ) : (
                  <div className="absolute inset-0 p-6 space-y-2 pointer-events-none">
                    <div className="h-4 w-2/3 bg-neutral-200 rounded" />
                    <div className="h-3 w-5/6 bg-neutral-100 rounded" />
                    <div className="h-3 w-full bg-neutral-100 rounded" />
                    <div className="h-3 w-4/5 bg-neutral-100 rounded" />
                    {thumbLoading && <p className="pt-6 text-center text-[11px] text-neutral-400">{t('certCryptor.previewLoading')}</p>}
                  </div>
                )}

                {(stampState === 'idle' || stampState === 'stamped') && (
                  <div
                    className="absolute pointer-events-none rounded-full flex items-center justify-center transition-all duration-300"
                    style={{ left: sealX - sealPx / 2, top: sealY - sealPx / 2, width: sealPx, height: sealPx }}
                  >
                    <div
                      className={`w-full h-full rounded-full flex items-center justify-center shadow-lg ${
                        waxColor === 'gold'
                          ? 'bg-yellow-600 border-yellow-400 text-yellow-100'
                          : waxColor === 'red'
                            ? 'bg-red-700 border-red-500 text-red-100'
                            : 'bg-amber-800 border-amber-600 text-amber-100'
                      }`}
                      style={{
                        transform: stampState === 'stamped' ? 'scale(1)' : 'scale(0.9) rotate(-12deg)',
                        boxShadow: 'inset -3px -3px 8px rgba(0,0,0,0.3), inset 3px 3px 8px rgba(255,255,255,0.4)',
                        borderWidth: 3,
                        borderStyle: 'solid',
                        opacity: stampState === 'stamped' ? 1 : 0.92,
                      }}
                    >
                      <Award className="w-1/2 h-1/2" />
                    </div>
                  </div>
                )}

                {(stampState === 'descending' || stampState === 'pressing') && (
                  <div
                    className="absolute pointer-events-none z-20 flex items-center justify-center"
                    style={{
                      left: sealX - 35,
                      top: stampState === 'descending' ? -100 : sealY - 35,
                      width: 70,
                      height: 70,
                      perspective: '800px',
                      transition: 'top 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <div
                      className="w-full h-full flex flex-col items-center justify-end"
                      style={{
                        transformStyle: 'preserve-3d',
                        transform: 'rotateX(20deg) rotateY(-10deg) rotateZ(35deg)',
                        animation: stampState === 'pressing' ? 'stamp-press 0.4s ease-out forwards' : 'none',
                      }}
                    >
                      <div className="h-10 w-4 bg-amber-700 rounded-t-xl shadow-inner border border-amber-800" />
                      <div className="h-4 w-10 bg-yellow-500 border border-yellow-400 rounded-lg shadow-lg flex items-center justify-center font-bold text-[8px] text-yellow-900">
                        SIG
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default CertCryptorTool;
