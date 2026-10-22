/**
 * Smart Data Redactor Processor
 * 
 * Implements automatic scanning and physical redaction of sensitive patterns (e.g., Email, Phone, SSN/ID Card).
 * Detects patterns, overlays opaque blocking blocks, and sanitizes underlying content streams.
 */

import type {
  ProcessInput,
  ProcessOutput,
  ProgressCallback,
} from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib, loadPdfjs } from '../loader';
import { redactPDF, type RedactionArea } from './redact';
import { buildPageIndex, boxesForRange, escapeRegExp } from '../text-search';

export interface SmartRedactOptions {
  patterns: ('email' | 'phone' | 'idcard' | 'custom')[];
  customKeywords?: string[];
  redactColor?: { r: number; g: number; b: number };
}

const DEFAULT_OPTIONS: SmartRedactOptions = {
  patterns: ['email', 'phone'],
  customKeywords: [],
  redactColor: { r: 0, g: 0, b: 0 }, // Black
};

// Padrões (Brasil e internacionais)
const REGEX_PATTERNS: Record<'email' | 'phone' | 'idcard', RegExp[]> = {
  email: [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  phone: [
    // Brasil: (11) 98765-4321, 11 98765 4321, +55 21 3456-7890, (11) 987654321
    /(?<![\d])(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\d{2})[\s.-]?(?:9[\s.]?)?\d{4}[\s.-]\d{4}(?!\d)/g,
    /(?<![\d])(?:\+?55[\s.-]?)?\(\d{2}\)[\s]?9?\d{8}(?!\d)/g,
    // internacional / EUA: +1 (555) 123-4567, 555-123-4567
    /(?<![\d])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
  ],
  idcard: [
    /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, // CPF
    /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, // CNPJ
    /CPF[:\s]*\d{11}(?!\d)/gi, // CPF sem pontos
    /(?<!\d)\d{1,2}\.\d{3}\.\d{3}-[\dXx](?![\dA-Za-z])/g, // RG
    /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, // SSN
    /(?<!\d)\d{17}[\dXx](?![\dA-Za-z])/g, // documento de 18 dígitos
  ],
};

interface MatchBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class SmartDataRedactorProcessor extends BasePDFProcessor {
  async process(
    input: ProcessInput,
    onProgress?: ProgressCallback
  ): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const redactOptions: SmartRedactOptions = {
      ...DEFAULT_OPTIONS,
      ...(options as Partial<SmartRedactOptions>),
    };

    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        'Please upload exactly one PDF file.'
      );
    }

    const file = files[0];

    try {
      this.updateProgress(10, 'Loading PDF documents...');
      const pdfjs = await loadPdfjs();
      const pdfLib = await loadPdfLib();

      const fileBytes = await file.arrayBuffer();
      
      // Load both PDFJS and PDF-Lib docs
      const pdfjsDoc = await pdfjs.getDocument({ data: fileBytes.slice(0) }).promise;
      const pdfLibDoc = await pdfLib.PDFDocument.load(fileBytes, { ignoreEncryption: true, updateMetadata: false });
      if (pdfLibDoc.isEncrypted) {
        return this.createErrorOutput(PDFErrorCode.PDF_ENCRYPTED, 'The PDF file is encrypted.', 'Please decrypt the file first.');
      }
      const totalPages = pdfjsDoc.numPages;

      const progressInterval = 70 / totalPages;
      const redactionAreas: RedactionArea[] = [];
      const hexColor = redactOptions.redactColor
        ? '#' + [redactOptions.redactColor.r, redactOptions.redactColor.g, redactOptions.redactColor.b]
            .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
            .join('')
        : '#000000';

      // termos personalizados: texto literal, sem diferenciar maiúsculas
      const customRegexes = (redactOptions.patterns.includes('custom') ? redactOptions.customKeywords || [] : [])
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => new RegExp(k.split(/\s+/).map(escapeRegExp).join('\\s+'), 'giu'));
      const regexes: RegExp[] = [
        ...redactOptions.patterns.flatMap((p) => (p === 'custom' ? [] : REGEX_PATTERNS[p] || [])),
        ...customRegexes,
      ];

      for (let i = 1; i <= totalPages; i++) {
        this.updateProgress(15 + (i - 1) * progressInterval, `Scanning & analyzing page ${i}...`);
        const pdfjsPage = await pdfjsDoc.getPage(i);
        const index = await buildPageIndex(pdfjsPage);
        if (!index.text) continue;

        // trechos encontrados (sem repetir o mesmo trecho por dois padrões)
        const ranges: [number, number][] = [];
        for (const re of regexes) {
          const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
          let m: RegExpExecArray | null;
          while ((m = rx.exec(index.text)) !== null) {
            if (!m[0].length) {
              rx.lastIndex++;
              continue;
            }
            ranges.push([m.index, m.index + m[0].length]);
          }
        }
        ranges.sort((x, y) => x[0] - y[0]);
        const merged: [number, number][] = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
          else merged.push([r[0], r[1]]);
        }

        for (const [start, end] of merged) {
          for (const box of boxesForRange(index, start, end, 2)) {
            redactionAreas.push({
              id: `smart-${i}-${redactionAreas.length}`,
              type: 'rect',
              page: i,
              x: Math.max(0, box.x),
              y: Math.max(0, index.height - box.y - box.height),
              width: box.width,
              height: box.height,
              pageWidth: index.width,
              pageHeight: index.height,
              style: redactOptions.redactColor ? 'custom-color' : 'blackout',
              color: hexColor,
            });
          }
        }
      }

      let outputBlob: Blob;

      if (redactionAreas.length > 0) {
        this.updateProgress(85, 'Executing irreversible physical rasterization...');
        const finalPdfBytes = await redactPDF(
          fileBytes,
          redactionAreas,
          {
            renderScale: 2.0,
            outputQuality: 0.95,
            stripMetadata: true,
            purgeAnnotations: true,
          },
          (progressPercent, msg) => {
            this.updateProgress(85 + Math.round((progressPercent / 100) * 12), msg);
          }
        );
        outputBlob = new Blob([finalPdfBytes as unknown as BlobPart], { type: 'application/pdf' });
      } else {
        // nada encontrado: devolve o arquivo como estava
        this.updateProgress(95, 'No sensitive data found');
        outputBlob = new Blob([new Uint8Array(fileBytes)], { type: 'application/pdf' });
      }

      this.updateProgress(100, 'Complete!');

      return this.createSuccessOutput(outputBlob, `${file.name.replace(/\.pdf$/i, '')}_redacted.pdf`, {
        pageCount: totalPages,
        redactionsApplied: redactionAreas.length,
      });

    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        'Failed to redact PDF privacy data.',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

export function createSmartDataRedactorProcessor(): SmartDataRedactorProcessor {
  return new SmartDataRedactorProcessor();
}

export async function redactSmartData(
  files: File[],
  options?: Partial<SmartRedactOptions>,
  onProgress?: ProgressCallback
): Promise<ProcessOutput> {
  const processor = createSmartDataRedactorProcessor();
  return processor.process({ files, options: options || {} }, onProgress);
}
