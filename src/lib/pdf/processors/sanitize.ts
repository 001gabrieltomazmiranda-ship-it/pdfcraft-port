/**
 * Limpar PDF (sanitizar): tira o que pode ser perigoso ou revelar informação escondida.
 *
 * - JavaScript em qualquer lugar (ao abrir, em links, em campos, em páginas, no XFA),
 *   e também ações de abrir programas/arquivos e de enviar dados (Launch, SubmitForm, ImportData)
 * - anexos (lista de arquivos embutidos e anotações de anexo)
 * - links
 * - formulários (viram texto fixo)
 * - metadados (informações do documento e XMP)
 * - anotações (opcional)
 */

import type { ProcessInput, ProcessOutput, ProgressCallback } from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';
import { flattenAnnotations } from '../flatten-annotations';
import { tr } from '../ui-lang';

export interface SanitizePDFOptions {
  /** Remove JavaScript */
  removeJavaScript: boolean;
  /** Remove embedded files/attachments */
  removeAttachments: boolean;
  /** Remove external links */
  removeLinks: boolean;
  /** Flatten form fields */
  flattenForms: boolean;
  /** Remove metadata */
  removeMetadata: boolean;
  /** Remove annotations */
  removeAnnotations: boolean;
}

const DEFAULT_SANITIZE_OPTIONS: SanitizePDFOptions = {
  removeJavaScript: true,
  removeAttachments: true,
  removeLinks: true,
  flattenForms: true,
  removeMetadata: true,
  removeAnnotations: false,
};

const DANGEROUS_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'RichMediaExecute', 'GoToE']);

/* eslint-disable @typescript-eslint/no-explicit-any */

function nameText(lib: any, v: any): string | undefined {
  return v instanceof lib.PDFName ? v.decodeText() : undefined;
}

/** Tira JavaScript e ações perigosas de todo o arquivo. Devolve quantas coisas mudou. */
function stripActiveContent(lib: any, doc: any): number {
  const N = lib.PDFName;
  const ctx = doc.context;
  let changed = 0;

  const isDangerousAction = (v: any): boolean => {
    const a = ctx.lookup(v);
    if (!(a instanceof lib.PDFDict)) return false;
    const s = nameText(lib, ctx.lookup(a.get(N.of('S'))));
    return !!s && DANGEROUS_ACTIONS.has(s);
  };

  const cleanDict = (d: any) => {
    if (d.has(N.of('AA'))) {
      d.delete(N.of('AA'));
      changed++;
    }
    const a = d.get(N.of('A'));
    if (a && isDangerousAction(a)) {
      d.delete(N.of('A'));
      changed++;
    }
    // ação com JavaScript: esvazia (vale mesmo se for usada em outro lugar)
    const s = nameText(lib, ctx.lookup(d.get(N.of('S'))));
    if (s && DANGEROUS_ACTIONS.has(s)) {
      for (const k of ['JS', 'F', 'Win', 'Mac', 'Unix', 'Fields', 'Next']) {
        if (d.has(N.of(k))) d.delete(N.of(k));
      }
      if (s === 'JavaScript') d.set(N.of('JS'), lib.PDFString.of(''));
      changed++;
    }
    // ação seguinte encadeada (/Next) com JavaScript
    const next = d.get(N.of('Next'));
    if (next) {
      const nx = ctx.lookup(next);
      if (nx instanceof lib.PDFArray) {
        const kept: any[] = [];
        for (let i = 0; i < nx.size(); i++) if (!isDangerousAction(nx.get(i))) kept.push(nx.get(i));
        if (kept.length !== nx.size()) {
          changed++;
          if (kept.length) d.set(N.of('Next'), ctx.obj(kept));
          else d.delete(N.of('Next'));
        }
      } else if (isDangerousAction(next)) {
        d.delete(N.of('Next'));
        changed++;
      }
    }
  };

  const visit = (obj: any, depth: number) => {
    if (depth > 6 || !obj) return;
    if (obj instanceof lib.PDFDict) {
      cleanDict(obj);
      for (const [, v] of obj.entries()) {
        if (v instanceof lib.PDFDict || v instanceof lib.PDFArray) visit(v, depth + 1);
      }
    } else if (obj instanceof lib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (v instanceof lib.PDFDict || v instanceof lib.PDFArray) visit(v, depth + 1);
      }
    } else if (obj instanceof lib.PDFStream) {
      cleanDict(obj.dict);
    }
  };

  // todos os objetos do arquivo (páginas, anotações, campos, marcadores, ações…)
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);

  // catálogo: JavaScript ao abrir e a árvore de nomes de scripts
  const catalog = doc.catalog;
  const open = catalog.get(N.of('OpenAction'));
  if (open && isDangerousAction(open)) {
    catalog.delete(N.of('OpenAction'));
    changed++;
  }
  const names = ctx.lookup(catalog.get(N.of('Names')));
  if (names instanceof lib.PDFDict && names.has(N.of('JavaScript'))) {
    names.delete(N.of('JavaScript'));
    changed++;
  }
  // formulários XFA podem ter scripts
  const acro = ctx.lookup(catalog.get(N.of('AcroForm')));
  if (acro instanceof lib.PDFDict && acro.has(N.of('XFA'))) {
    acro.delete(N.of('XFA'));
    changed++;
  }
  return changed;
}

function filterAnnots(lib: any, doc: any, drop: (subtype: string) => boolean): number {
  const N = lib.PDFName;
  const ctx = doc.context;
  let removed = 0;
  for (const page of doc.getPages()) {
    const arr = ctx.lookup(page.node.get(N.of('Annots')));
    if (!(arr instanceof lib.PDFArray)) continue;
    const kept: any[] = [];
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      const a = ctx.lookup(ref);
      const st = a instanceof lib.PDFDict ? nameText(lib, ctx.lookup(a.get(N.of('Subtype')))) || '' : '';
      if (drop(st)) removed++;
      else kept.push(ref);
    }
    if (kept.length !== arr.size()) {
      if (kept.length) page.node.set(N.of('Annots'), ctx.obj(kept));
      else page.node.delete(N.of('Annots'));
    }
  }
  return removed;
}

export class SanitizePDFProcessor extends BasePDFProcessor {
  async process(input: ProcessInput, onProgress?: ProgressCallback): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const opts: SanitizePDFOptions = { ...DEFAULT_SANITIZE_OPTIONS, ...(options as Partial<SanitizePDFOptions>) };

    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        tr('Envie exatamente 1 PDF.', 'Please provide exactly one PDF file to sanitize.'),
        `Received ${files.length} file(s).`
      );
    }
    const file = files[0];

    try {
      this.updateProgress(5, tr('Carregando…', 'Loading PDF library...'));
      const pdfLib: any = await loadPdfLib();
      const N = pdfLib.PDFName;
      const arrayBuffer = await file.arrayBuffer();
      const originalSize = arrayBuffer.byteLength;

      this.updateProgress(15, tr('Lendo o PDF…', 'Loading PDF document...'));
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
          tr('Remova a senha e tente de novo.', 'Please decrypt the file before sanitizing.')
        );
      }
      const pageCount = pdfDoc.getPageCount();
      if (pageCount === 0) {
        return this.createErrorOutput(PDFErrorCode.PDF_MALFORMED, tr('O PDF não tem páginas.', 'The PDF file contains no pages.'));
      }

      const removedItems: string[] = [];
      const catalog = pdfDoc.catalog;
      const ctx = pdfDoc.context;

      // JavaScript primeiro (antes de achatar: scripts de campos saem junto)
      if (opts.removeJavaScript) {
        this.updateProgress(25, tr('Removendo JavaScript…', 'Removing JavaScript...'));
        const n = stripActiveContent(pdfLib, pdfDoc);
        if (n > 0) removedItems.push(tr('JavaScript e ações automáticas', 'JavaScript and automatic actions'));
      }

      if (opts.flattenForms) {
        this.updateProgress(40, tr('Achatando o formulário…', 'Flattening forms...'));
        let fieldsCount = 0;
        let fallback = false;
        try {
          const form = pdfDoc.getForm();
          fieldsCount = form.getFields().length;
          if (fieldsCount > 0) {
            form.flatten();
            if (form.getFields().length === 0) catalog.delete(N.of('AcroForm'));
          }
        } catch (e) {
          console.warn('[limpar] formulário pelo pdf-lib falhou', e);
          fallback = true;
        }
        if (fallback) {
          const r = await flattenAnnotations(pdfLib, pdfDoc, { widgets: true, annotations: false });
          fieldsCount = Math.max(fieldsCount, r.widgets);
          // o que sobrou do formulário sai
          if (catalog.has(N.of('AcroForm'))) catalog.delete(N.of('AcroForm'));
        }
        if (fieldsCount > 0) removedItems.push(tr('formulário (achatado)', 'form fields (flattened)'));
      }

      if (opts.removeAttachments) {
        this.updateProgress(55, tr('Removendo anexos…', 'Removing embedded files...'));
        let n = 0;
        const names = ctx.lookup(catalog.get(N.of('Names')));
        if (names instanceof pdfLib.PDFDict && names.has(N.of('EmbeddedFiles'))) {
          names.delete(N.of('EmbeddedFiles'));
          n++;
        }
        if (catalog.has(N.of('Collection'))) {
          catalog.delete(N.of('Collection'));
          n++;
        }
        if (catalog.has(N.of('AF'))) {
          catalog.delete(N.of('AF'));
          n++;
        }
        n += filterAnnots(pdfLib, pdfDoc, (st) => st === 'FileAttachment');
        if (n > 0) removedItems.push(tr('anexos', 'embedded files'));
      }

      if (opts.removeLinks) {
        this.updateProgress(65, tr('Removendo links…', 'Removing links...'));
        const n = filterAnnots(pdfLib, pdfDoc, (st) => st === 'Link');
        if (n > 0) removedItems.push(tr(`${n} link(s)`, `${n} link(s)`));
      }

      if (opts.removeAnnotations) {
        this.updateProgress(72, tr('Removendo anotações…', 'Removing annotations...'));
        const n = filterAnnots(pdfLib, pdfDoc, (st) => st !== 'Widget');
        if (n > 0) removedItems.push(tr(`${n} anotação(ões)`, `${n} annotation(s)`));
      }

      if (opts.removeMetadata) {
        this.updateProgress(80, tr('Removendo metadados…', 'Removing metadata...'));
        const infoRef = ctx.trailerInfo.Info;
        const info = infoRef ? ctx.lookup(infoRef) : undefined;
        let n = 0;
        if (info instanceof pdfLib.PDFDict) {
          for (const k of info.keys()) {
            info.delete(k);
            n++;
          }
        }
        if (catalog.has(N.of('Metadata'))) {
          catalog.delete(N.of('Metadata'));
          n++;
        }
        if (catalog.has(N.of('PieceInfo'))) catalog.delete(N.of('PieceInfo'));
        for (const page of pdfDoc.getPages()) {
          if (page.node.has(N.of('Metadata'))) page.node.delete(N.of('Metadata'));
          if (page.node.has(N.of('PieceInfo'))) page.node.delete(N.of('PieceInfo'));
        }
        if (n > 0) removedItems.push(tr('metadados', 'metadata'));
      }

      if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing was cancelled.');

      this.updateProgress(90, tr('Salvando…', 'Saving sanitized PDF...'));
      const sanitizedPdfBytes = await pdfDoc.save({ useObjectStreams: true });
      const blob = new Blob([new Uint8Array(sanitizedPdfBytes)], { type: 'application/pdf' });

      this.updateProgress(100, tr('Pronto!', 'Complete!'));
      if (removedItems.length === 0) removedItems.push(tr('nada perigoso encontrado', 'nothing to remove'));
      return this.createSuccessOutput(blob, generateSanitizedFilename(file.name), {
        pageCount,
        originalSize,
        newSize: sanitizedPdfBytes.length,
        removedItems,
        sanitized: true,
      });
    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        tr('Não foi possível limpar o PDF.', 'Failed to sanitize PDF file.'),
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

function generateSanitizedFilename(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot === -1 ? originalName : originalName.slice(0, lastDot);
  return `${baseName}_sanitized.pdf`;
}

export function createSanitizeProcessor(): SanitizePDFProcessor {
  return new SanitizePDFProcessor();
}

export async function sanitizePDF(file: File, options?: Partial<SanitizePDFOptions>, onProgress?: ProgressCallback): Promise<ProcessOutput> {
  const processor = createSanitizeProcessor();
  return processor.process({ files: [file], options: options || {} }, onProgress);
}
