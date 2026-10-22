/**
 * PDF Remove Metadata Processor
 * Requirements: 5.1
 * 
 * Implements PDF metadata removal functionality using pdf-lib.
 * Removes document properties like title, author, subject, keywords,
 * creation date, modification date, and custom metadata.
 */

import type {
  ProcessInput,
  ProcessOutput,
  ProgressCallback,
} from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';
import { tr } from '../ui-lang';

/**
 * Remove Metadata options
 */
export interface RemoveMetadataOptions {
  /** Remove title */
  removeTitle: boolean;
  /** Remove author */
  removeAuthor: boolean;
  /** Remove subject */
  removeSubject: boolean;
  /** Remove keywords */
  removeKeywords: boolean;
  /** Remove creator */
  removeCreator: boolean;
  /** Remove producer */
  removeProducer: boolean;
  /** Remove creation date */
  removeCreationDate: boolean;
  /** Remove modification date */
  removeModificationDate: boolean;
}

/**
 * Default remove metadata options
 */
const DEFAULT_REMOVE_METADATA_OPTIONS: RemoveMetadataOptions = {
  removeTitle: true,
  removeAuthor: true,
  removeSubject: true,
  removeKeywords: true,
  removeCreator: true,
  removeProducer: true,
  removeCreationDate: true,
  removeModificationDate: true,
};

/**
 * Remove Metadata Processor
 * Removes metadata from PDF files.
 */
export class RemoveMetadataProcessor extends BasePDFProcessor {
  /**
   * Process PDF file and remove metadata
   */
  async process(
    input: ProcessInput,
    onProgress?: ProgressCallback
  ): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const removeOptions: RemoveMetadataOptions = {
      ...DEFAULT_REMOVE_METADATA_OPTIONS,
      ...(options as Partial<RemoveMetadataOptions>),
    };

    // Validate we have exactly 1 file
    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        'Please provide exactly one PDF file.',
        `Received ${files.length} file(s).`
      );
    }

    const file = files[0];

    try {
      this.updateProgress(5, 'Loading PDF library...');

      // Load pdf-lib
      const pdfLib = await loadPdfLib();
      
      if (this.checkCancelled()) {
        return this.createErrorOutput(
          PDFErrorCode.PROCESSING_CANCELLED,
          'Processing was cancelled.'
        );
      }

      this.updateProgress(10, 'Reading PDF file...');

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      const originalSize = arrayBuffer.byteLength;

      this.updateProgress(20, 'Loading PDF document...');

      // Load the source PDF
      let sourcePdf;
      try {
        // updateMetadata: false = não escrever "pdf-lib" nem datas novas no arquivo
        sourcePdf = await pdfLib.PDFDocument.load(arrayBuffer, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('encrypt')) {
          return this.createErrorOutput(
            PDFErrorCode.PDF_ENCRYPTED,
            'The PDF file is encrypted.',
            'Please decrypt the file before removing metadata.'
          );
        }
        throw error;
      }

      if (this.checkCancelled()) {
        return this.createErrorOutput(
          PDFErrorCode.PROCESSING_CANCELLED,
          'Processing was cancelled.'
        );
      }

      this.updateProgress(30, 'Reading current metadata...');

      const pageCount = sourcePdf.getPageCount();

      if (pageCount === 0) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_MALFORMED,
          'The PDF file contains no pages.',
          'Cannot process an empty PDF.'
        );
      }

      if (sourcePdf.isEncrypted) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_ENCRYPTED,
          tr('Este PDF tem senha. Use "Remover senha" primeiro.', 'The PDF file is encrypted.'),
          tr('Remova a senha e tente de novo.', 'Please decrypt the file before removing metadata.')
        );
      }

      // Store original metadata for reporting
      const safe = <T,>(fn: () => T, fallback: T): T => {
        try {
          return fn();
        } catch {
          return fallback;
        }
      };
      const originalMetadata = {
        title: safe(() => sourcePdf.getTitle() || '', ''),
        author: safe(() => sourcePdf.getAuthor() || '', ''),
        subject: safe(() => sourcePdf.getSubject() || '', ''),
        keywords: safe(() => sourcePdf.getKeywords() || '', ''),
        creator: safe(() => sourcePdf.getCreator() || '', ''),
        producer: safe(() => sourcePdf.getProducer() || '', ''),
        creationDate: safe(() => sourcePdf.getCreationDate()?.toISOString() || '', ''),
        modificationDate: safe(() => sourcePdf.getModificationDate()?.toISOString() || '', ''),
      };

      // Track what was removed
      const removedFields: string[] = [];

      this.updateProgress(50, tr('Removendo metadados…', 'Removing metadata...'));

      // Apaga as chaves do dicionário de informações (em vez de deixar vazias)
      const { PDFName, PDFDict } = pdfLib;
      const ctx = sourcePdf.context;
      const infoRef = ctx.trailerInfo.Info;
      const info = infoRef ? ctx.lookup(infoRef) : undefined;
      const keys: [keyof RemoveMetadataOptions, string, string][] = [
        ['removeTitle', 'Title', 'title'],
        ['removeAuthor', 'Author', 'author'],
        ['removeSubject', 'Subject', 'subject'],
        ['removeKeywords', 'Keywords', 'keywords'],
        ['removeCreator', 'Creator', 'creator'],
        ['removeProducer', 'Producer', 'producer'],
        ['removeCreationDate', 'CreationDate', 'creationDate'],
        ['removeModificationDate', 'ModDate', 'modificationDate'],
      ];
      if (info instanceof PDFDict) {
        for (const [opt, key, label] of keys) {
          if (!removeOptions[opt]) continue;
          if (info.has(PDFName.of(key))) {
            info.delete(PDFName.of(key));
            removedFields.push(label);
          }
        }
        // chaves extras (personalizadas) saem quando tudo foi marcado
        const all = keys.every(([opt]) => removeOptions[opt]);
        if (all) {
          for (const k of info.keys()) {
            info.delete(k);
            if (!removedFields.includes('custom')) removedFields.push('custom');
          }
        }
      }

      // O XMP (catálogo /Metadata) repete título, autor, programa e datas: sai junto
      const anyRemoved = keys.some(([opt]) => removeOptions[opt]);
      if (anyRemoved) {
        const catalog = sourcePdf.catalog;
        if (catalog.has(PDFName.of('Metadata'))) {
          catalog.delete(PDFName.of('Metadata'));
          removedFields.push('xmp');
        }
        // e o mesmo nas páginas
        for (const page of sourcePdf.getPages()) {
          if (page.node.has(PDFName.of('Metadata'))) page.node.delete(PDFName.of('Metadata'));
          if (page.node.has(PDFName.of('PieceInfo'))) page.node.delete(PDFName.of('PieceInfo'));
        }
        if (catalog.has(PDFName.of('PieceInfo'))) catalog.delete(PDFName.of('PieceInfo'));
      }

      if (this.checkCancelled()) {
        return this.createErrorOutput(
          PDFErrorCode.PROCESSING_CANCELLED,
          'Processing was cancelled.'
        );
      }

      this.updateProgress(80, 'Saving PDF...');

      // Save the PDF
      const cleanedPdfBytes = await sourcePdf.save({
        useObjectStreams: true,
        addDefaultPage: false,
      });

      // Create blob from the Uint8Array
      const blob = new Blob([new Uint8Array(cleanedPdfBytes)], { type: 'application/pdf' });
      const newSize = cleanedPdfBytes.length;

      this.updateProgress(100, 'Complete!');

      // Generate output filename
      const outputFilename = generateCleanedFilename(file.name);

      return this.createSuccessOutput(blob, outputFilename, {
        pageCount,
        originalSize,
        newSize,
        removedFields,
        originalMetadata,
      });

    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        'Failed to remove PDF metadata.',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Get accepted file types for remove metadata processor
   */
  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

/**
 * Generate a filename for the cleaned PDF
 */
function generateCleanedFilename(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot === -1 ? originalName : originalName.slice(0, lastDot);
  return `${baseName}_no_metadata.pdf`;
}

/**
 * Create a new instance of the remove metadata processor
 */
export function createRemoveMetadataProcessor(): RemoveMetadataProcessor {
  return new RemoveMetadataProcessor();
}

/**
 * Remove metadata from a PDF file (convenience function)
 */
export async function removeMetadata(
  file: File,
  options?: Partial<RemoveMetadataOptions>,
  onProgress?: ProgressCallback
): Promise<ProcessOutput> {
  const processor = createRemoveMetadataProcessor();
  return processor.process(
    {
      files: [file],
      options: options || {},
    },
    onProgress
  );
}
