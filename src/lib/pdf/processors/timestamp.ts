/**
 * Carimbo de tempo confiável (RFC 3161) em PDF.
 *
 * Envia só o resumo SHA-256 do documento para uma autoridade de carimbo de tempo (TSA)
 * de verdade, recebe o carimbo assinado por ela e grava no PDF como "DocTimeStamp"
 * (SubFilter ETSI.RFC3161), o formato que o Adobe Acrobat e os validadores reconhecem.
 * Antes de entregar, o próprio app confere o carimbo (hora, série e se é deste documento).
 */

import type { ProcessInput, ProcessOutput, ProgressCallback } from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';
import { loadZga, zgaSign } from '../zga';
import { findPdfSignatures, inspectPdfSignature } from '../signature-inspect';
import { tr } from '../ui-lang';

export interface TimestampOptions {
  /** Autoridade escolhida (id da lista TIMESTAMP_AUTHORITIES) */
  tsaServer?: string;
}

export interface TimestampAuthority {
  id: string;
  name: string;
  url: string;
}

/** Autoridades públicas e gratuitas (atendem em http://, como manda o RFC 3161). */
export const TIMESTAMP_AUTHORITIES: TimestampAuthority[] = [
  { id: 'DigiCert', name: 'DigiCert', url: 'http://timestamp.digicert.com' },
  { id: 'Sectigo', name: 'Sectigo', url: 'http://timestamp.sectigo.com' },
  { id: 'SSL.com', name: 'SSL.com', url: 'http://ts.ssl.com' },
  { id: 'Apple', name: 'Apple', url: 'http://timestamp.apple.com/ts01' },
  { id: 'Entrust', name: 'Entrust', url: 'http://timestamp.entrust.net/TSS/RFC3161sha2TS' },
  { id: 'FreeTSA', name: 'FreeTSA.org', url: 'http://freetsa.org/tsr' },
];

/** Para testes: troca a lista de autoridades (ex.: uma TSA local). */
let authorityOverride: TimestampAuthority[] | null = null;
export function setTimestampAuthoritiesForTesting(list: TimestampAuthority[] | null): void {
  authorityOverride = list;
}

function authorities(): TimestampAuthority[] {
  const g = globalThis as { __pcTsaList?: TimestampAuthority[] };
  return authorityOverride || g.__pcTsaList || TIMESTAMP_AUTHORITIES;
}

function orderFor(selected?: string): TimestampAuthority[] {
  const list = authorities();
  const first = list.find((a) => a.id === selected || a.name === selected);
  return first ? [first, ...list.filter((a) => a !== first)] : list.slice();
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
}

export class TimestampPDFProcessor extends BasePDFProcessor {
  async process(input: ProcessInput, onProgress?: ProgressCallback): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const opts: TimestampOptions = { ...(options as TimestampOptions) };

    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        tr('Envie exatamente 1 PDF.', 'Exactly 1 PDF file is required.')
      );
    }

    const file = files[0];
    try {
      this.updateProgress(5, tr('Lendo o PDF…', 'Reading PDF…'));
      const bytes = new Uint8Array(await file.arrayBuffer());

      const pdfLib = await loadPdfLib();
      let encrypted = false;
      try {
        const probe = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        encrypted = probe.isEncrypted;
      } catch (err) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_MALFORMED,
          tr('Não foi possível ler este PDF.', 'Could not read this PDF.'),
          shortError(err)
        );
      }
      if (encrypted) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_ENCRYPTED,
          tr(
            'Este PDF tem senha. Use "Remover senha" primeiro e depois aplique o carimbo.',
            'This PDF is password-protected. Remove the password first, then apply the timestamp.'
          )
        );
      }

      this.updateProgress(15, tr('Preparando o carimbo…', 'Preparing timestamp…'));
      const z = await loadZga();
      if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing cancelled');

      const tried: string[] = [];
      const order = orderFor(opts.tsaServer);
      for (let i = 0; i < order.length; i++) {
        const tsa = order[i];
        if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing cancelled');
        this.updateProgress(
          20 + Math.round((i / order.length) * 60),
          tr(`Pedindo o carimbo de tempo à ${tsa.name}…`, `Requesting timestamp from ${tsa.name}…`)
        );
        let out: Uint8Array;
        try {
          out = await zgaSign(z, { signdate: { url: tsa.url, len: 16000 } }, bytes);
        } catch (err) {
          console.warn('[carimbo]', tsa.name, err);
          tried.push(`${tsa.name}: ${shortError(err)}`);
          continue;
        }

        // confere o resultado antes de entregar
        this.updateProgress(85, tr('Conferindo o carimbo…', 'Checking timestamp…'));
        const stamps = findPdfSignatures(out).filter((s) => s.kind === 'timestamp');
        const last = stamps[stamps.length - 1];
        const report = last ? await inspectPdfSignature(out, last) : null;
        if (!report || !report.valid || !report.timestampTime) {
          tried.push(`${tsa.name}: ${report?.error || 'invalid timestamp'}`);
          continue;
        }

        this.updateProgress(100, tr('Carimbo aplicado!', 'Timestamp applied!'));
        const base = file.name.replace(/\.pdf$/i, '');
        const blob = new Blob([new Uint8Array(out)], { type: 'application/pdf' });
        const issuer = report.tsaName ? `${tsa.name} — ${report.tsaName}` : tsa.name;
        return this.createSuccessOutput(blob, `${base}_timestamped.pdf`, {
          tsaAuthority: issuer,
          tsaUrl: tsa.url,
          hash: (report.documentHash || '').toUpperCase(),
          timestamp: report.timestampTime.toISOString(),
          serial: report.timestampSerial || '',
          verified: !report.unverifiable,
        });
      }

      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        tr(
          'Não foi possível falar com nenhuma autoridade de carimbo de tempo. Confira se a internet está ligada e tente de novo.',
          'Could not reach any timestamp authority. Check your internet connection and try again.'
        ),
        tried.join(' | ')
      );
    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        tr('Não foi possível aplicar o carimbo de tempo.', 'Failed to apply RFC 3161 timestamp.'),
        shortError(error)
      );
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

export function createTimestampProcessor(): TimestampPDFProcessor {
  return new TimestampPDFProcessor();
}

export async function timestampPDF(
  files: File[],
  options: TimestampOptions,
  onProgress?: ProgressCallback
): Promise<ProcessOutput> {
  const processor = createTimestampProcessor();
  return processor.process({ files, options: options as Record<string, unknown> }, onProgress);
}
