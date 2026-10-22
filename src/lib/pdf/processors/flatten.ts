/**
 * Achatar PDF: transforma formulários, anotações (comentários, realces, desenhos, carimbos)
 * e camadas em conteúdo fixo da página. Fica igual na tela, mas ninguém mais edita.
 */

import type { ProcessInput, ProcessOutput, ProgressCallback } from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';
import { flattenAnnotations } from '../flatten-annotations';
import { tr } from '../ui-lang';

export interface FlattenPDFOptions {
  /** Flatten form fields */
  flattenForms: boolean;
  /** Flatten annotations (comments, highlights, drawings, stamps) */
  flattenAnnotations?: boolean;
  /** Flatten layers (optional content) */
  flattenLayers?: boolean;
}

const DEFAULT_FLATTEN_OPTIONS: FlattenPDFOptions = {
  flattenForms: true,
  flattenAnnotations: true,
  flattenLayers: true,
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Camadas: se todas estão visíveis, junta tudo (some o painel de camadas); se alguma está
 * escondida, trava as camadas como estão (ninguém liga/desliga mais). */
function flattenLayers(lib: any, doc: any): string | null {
  const N = lib.PDFName;
  const ctx = doc.context;
  const oc = ctx.lookup(doc.catalog.get(N.of('OCProperties')));
  if (!(oc instanceof lib.PDFDict)) return null;
  const ocgs = ctx.lookup(oc.get(N.of('OCGs')));
  const d = ctx.lookup(oc.get(N.of('D')));
  let anyOff = false;
  if (d instanceof lib.PDFDict) {
    const base = d.get(N.of('BaseState'));
    const off = ctx.lookup(d.get(N.of('OFF')));
    if (base instanceof lib.PDFName && base.decodeText() === 'OFF') anyOff = true;
    if (off instanceof lib.PDFArray && off.size() > 0) anyOff = true;
  }
  if (!anyOff) {
    doc.catalog.delete(N.of('OCProperties'));
    return tr('camadas juntadas', 'layers merged');
  }
  if (d instanceof lib.PDFDict && ocgs instanceof lib.PDFArray) {
    d.set(N.of('Locked'), ocgs);
    d.delete(N.of('Order'));
    d.delete(N.of('AS'));
  }
  return tr('camadas travadas como estão', 'layers locked as shown');
}

export class FlattenPDFProcessor extends BasePDFProcessor {
  async process(input: ProcessInput, onProgress?: ProgressCallback): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const opts: FlattenPDFOptions = { ...DEFAULT_FLATTEN_OPTIONS, ...(options as Partial<FlattenPDFOptions>) };

    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        tr('Envie exatamente 1 PDF.', 'Please provide exactly one PDF file to flatten.'),
        `Received ${files.length} file(s).`
      );
    }
    const file = files[0];

    try {
      this.updateProgress(5, tr('Carregando…', 'Loading PDF library...'));
      const pdfLib: any = await loadPdfLib();
      this.updateProgress(15, tr('Lendo o PDF…', 'Reading PDF file...'));
      const arrayBuffer = await file.arrayBuffer();
      const originalSize = arrayBuffer.byteLength;

      let pdfDoc: any;
      try {
        pdfDoc = await pdfLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true, updateMetadata: false });
      } catch (error) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_MALFORMED,
          tr('Não foi possível ler este PDF.', 'Could not read this PDF.'),
          error instanceof Error ? error.message : String(error)
        );
      }
      if (pdfDoc.isEncrypted) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_ENCRYPTED,
          tr('Este PDF tem senha. Use "Remover senha" primeiro.', 'The PDF file is encrypted.'),
          tr('Remova a senha e tente de novo.', 'Please decrypt the file before flattening.')
        );
      }
      if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing was cancelled.');

      const pageCount = pdfDoc.getPageCount();
      if (pageCount === 0) {
        return this.createErrorOutput(PDFErrorCode.PDF_MALFORMED, tr('O PDF não tem páginas.', 'The PDF file contains no pages.'));
      }

      const flattenedItems: string[] = [];
      let hasFormFields = false;

      // 1) formulário: primeiro do jeito do pdf-lib (gera a aparência com o valor preenchido)
      let widgetsLeft = false;
      if (opts.flattenForms) {
        this.updateProgress(35, tr('Achatando o formulário…', 'Flattening form fields...'));
        try {
          const form = pdfDoc.getForm();
          const fields = form.getFields();
          if (fields.length > 0) {
            hasFormFields = true;
            try {
              form.flatten();
              // formulário vazio não precisa ficar no arquivo
              if (form.getFields().length === 0) pdfDoc.catalog.delete(pdfLib.PDFName.of('AcroForm'));
              flattenedItems.push(tr(`${fields.length} campo(s) de formulário`, `${fields.length} form field(s)`));
            } catch (e) {
              console.warn('[achatar] formulário pelo pdf-lib falhou, usando as aparências do arquivo', e);
              widgetsLeft = true;
            }
          }
        } catch (e) {
          console.warn('[achatar] formulário ilegível', e);
          widgetsLeft = true;
        }
      }

      // 2) anotações (e campos que sobraram)
      if (opts.flattenAnnotations || widgetsLeft) {
        this.updateProgress(60, tr('Achatando as anotações…', 'Flattening annotations...'));
        const r = await flattenAnnotations(pdfLib, pdfDoc, {
          annotations: !!opts.flattenAnnotations,
          widgets: widgetsLeft,
        });
        if (r.widgets) {
          hasFormFields = true;
          flattenedItems.push(tr(`${r.widgets} campo(s) de formulário`, `${r.widgets} form field(s)`));
        }
        if (r.flattened) flattenedItems.push(tr(`${r.flattened} anotação(ões)`, `${r.flattened} annotation(s)`));
      }

      // 3) camadas
      if (opts.flattenLayers) {
        this.updateProgress(75, tr('Juntando as camadas…', 'Flattening layers...'));
        const msg = flattenLayers(pdfLib, pdfDoc);
        if (msg) flattenedItems.push(msg);
      }

      if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing was cancelled.');

      this.updateProgress(85, tr('Salvando…', 'Saving flattened PDF...'));
      const flattenedPdfBytes = await pdfDoc.save({ useObjectStreams: true });
      const blob = new Blob([new Uint8Array(flattenedPdfBytes)], { type: 'application/pdf' });

      this.updateProgress(100, tr('Pronto!', 'Complete!'));
      if (flattenedItems.length === 0) flattenedItems.push(tr('nada para achatar neste arquivo', 'nothing to flatten in this file'));

      return this.createSuccessOutput(blob, generateFlattenedFilename(file.name), {
        pageCount,
        originalSize,
        newSize: flattenedPdfBytes.length,
        flattenedItems,
        hasFormFields,
        flattened: true,
      });
    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        tr('Não foi possível achatar o PDF.', 'Failed to flatten PDF file.'),
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

function generateFlattenedFilename(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot === -1 ? originalName : originalName.slice(0, lastDot);
  return `${baseName}_flattened.pdf`;
}

export function createFlattenProcessor(): FlattenPDFProcessor {
  return new FlattenPDFProcessor();
}

export async function flattenPDF(file: File, options?: Partial<FlattenPDFOptions>, onProgress?: ProgressCallback): Promise<ProcessOutput> {
  const processor = createFlattenProcessor();
  return processor.process({ files: [file], options: options || {} }, onProgress);
}
