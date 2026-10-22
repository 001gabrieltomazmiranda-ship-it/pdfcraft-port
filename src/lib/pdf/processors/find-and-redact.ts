/**
 * Find and Redact Processor
 * Requirements: 5.1
 * 
 * Search for specific text/patterns across all pages and redact matching content.
 * Useful for batch redacting sensitive information like account numbers, names, etc.
 */

import { loadPdfjs } from '../loader';
import { redactPDF, type RedactionArea } from './redact';
import { buildPageIndex, boxesForRange, escapeRegExp, wholeWordPattern } from '../text-search';

/**
 * Text match found in the PDF
 */
export interface TextMatch {
    /** Page number (1-indexed) */
    page: number;
    /** Text content that matched */
    text: string;
    /** X coordinate from left edge (in points) */
    x: number;
    /** Y coordinate from bottom edge (in points) - PDF coordinates */
    y: number;
    /** Width of the text (in points) */
    width: number;
    /** Height of the text (in points) */
    height: number;
    /** Unique identifier for this match */
    id: string;
    /** Whether this match is selected for redaction */
    selected: boolean;
}

/**
 * Search options for finding text
 */
export interface SearchOptions {
    /** Single search term or pattern (for backwards compatibility) */
    searchTerm?: string;
    /** Multiple search terms (comma or newline separated in input) */
    searchTerms?: string[];
    /** Whether to use case-sensitive matching */
    caseSensitive: boolean;
    /** Whether to use regex pattern matching */
    useRegex: boolean;
    /** Whether to match whole words only */
    wholeWord: boolean;
}

/**
 * Parse search input into multiple terms
 */
export function parseSearchTerms(input: string): string[] {
    // Split by comma (both English and Chinese), newline, trim whitespace, and filter empty strings
    return input
        .split(/[,，\n]/)
        .map(term => term.trim())
        .filter(term => term.length > 0);
}

/**
 * Redaction options
 */
export interface FindAndRedactOptions extends SearchOptions {
    /** Color for the redaction boxes (default: black) */
    color?: { r: number; g: number; b: number };
    /** Whether to add a border around redaction boxes */
    addBorder?: boolean;
    /** Replacement text to show in redacted areas */
    replacementText?: string;
    /** Array of match IDs to redact (if empty, redact all matches) */
    selectedMatchIds?: string[];
}

/**
 * Search result containing all matches
 */
export interface SearchResult {
    success: boolean;
    matches: TextMatch[];
    totalCount: number;
    pagesWithMatches: number[];
    error?: string;
}

/**
 * Redaction result
 */
export interface RedactionResult {
    success: boolean;
    result?: Blob;
    error?: string;
    redactedCount: number;
}

/**
 * Progress callback type
 */
export type ProgressCallback = (progress: number, message?: string) => void;

/**
 * Search for text in a PDF document
 * Returns all matches with their positions for preview
 */
export async function searchTextInPDF(
    file: File,
    options: SearchOptions,
    onProgress?: ProgressCallback
): Promise<SearchResult> {
    try {
        if (!file) {
            return {
                success: false,
                matches: [],
                totalCount: 0,
                pagesWithMatches: [],
                error: 'No file provided',
            };
        }

        // Get search terms array
        const searchTerms: string[] = options.searchTerms && options.searchTerms.length > 0
            ? options.searchTerms
            : options.searchTerm
                ? [options.searchTerm]
                : [];

        if (searchTerms.length === 0 || searchTerms.every(t => t.trim() === '')) {
            return {
                success: false,
                matches: [],
                totalCount: 0,
                pagesWithMatches: [],
                error: 'Search term is required',
            };
        }

        onProgress?.(5, 'Loading PDF library...');

        const pdfjs = await loadPdfjs();
        const arrayBuffer = await file.arrayBuffer();

        onProgress?.(10, 'Loading PDF document...');

        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;
        const matches: TextMatch[] = [];
        const pagesWithMatches: Set<number> = new Set();

        // Build search patterns for all terms
        const searchPatterns: { pattern: RegExp; term: string }[] = [];
        try {
            for (const term of searchTerms) {
                if (!term.trim()) continue;

                let pattern: RegExp;
                if (options.useRegex) {
                    pattern = new RegExp(
                        options.wholeWord ? `\\b(?:${term})\\b` : term,
                        options.caseSensitive ? 'g' : 'gi'
                    );
                } else {
                    // texto literal; espaços do termo valem para espaços/quebras do PDF;
                    // "palavra inteira" que entende acentos
                    const escaped = term.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
                    pattern = new RegExp(
                        options.wholeWord ? wholeWordPattern(escaped) : escaped,
                        options.caseSensitive ? 'gu' : 'giu'
                    );
                }
                searchPatterns.push({ pattern, term });
            }
        } catch (regexError) {
            return {
                success: false,
                matches: [],
                totalCount: 0,
                pagesWithMatches: [],
                error: `Invalid search pattern: ${regexError instanceof Error ? regexError.message : 'Unknown error'}`,
            };
        }

        if (searchPatterns.length === 0) {
            return {
                success: false,
                matches: [],
                totalCount: 0,
                pagesWithMatches: [],
                error: 'No valid search terms provided',
            };
        }

        const progressPerPage = 85 / totalPages;

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageProgress = 10 + (pageNum - 1) * progressPerPage;
            onProgress?.(pageProgress, `Searching page ${pageNum} of ${totalPages}...`);

            try {
                const page = await pdf.getPage(pageNum);
                // texto da página inteira (pedaços da mesma linha juntos)
                const index = await buildPageIndex(page);
                if (!index.text) continue;

                for (const { pattern: searchPattern } of searchPatterns) {
                    let match: RegExpExecArray | null;
                    searchPattern.lastIndex = 0;
                    while ((match = searchPattern.exec(index.text)) !== null) {
                        if (match[0].length === 0) {
                            searchPattern.lastIndex++;
                            continue;
                        }
                        const boxes = boxesForRange(index, match.index, match.index + match[0].length, 0);
                        for (const box of boxes) {
                            matches.push({
                                page: pageNum,
                                text: match[0],
                                x: box.x,
                                y: box.y,
                                width: box.width,
                                height: box.height,
                                id: `match-${pageNum}-${box.x.toFixed(2)}-${box.y.toFixed(2)}-${matches.length}`,
                                selected: true,
                            });
                        }
                        if (boxes.length) pagesWithMatches.add(pageNum);
                    }
                }
            } catch (pageError) {
                console.warn(`Error processing page ${pageNum}:`, pageError);
            }
        }

        onProgress?.(100, 'Search complete');

        return {
            success: true,
            matches,
            totalCount: matches.length,
            pagesWithMatches: Array.from(pagesWithMatches).sort((a, b) => a - b),
        };
    } catch (error) {
        console.error('Search error:', error);
        return {
            success: false,
            matches: [],
            totalCount: 0,
            pagesWithMatches: [],
            error: error instanceof Error ? error.message : 'Failed to search PDF',
        };
    }
}

/**
 * Apply redactions to found text matches
 */
export async function applyFindAndRedact(
    file: File,
    matches: TextMatch[],
    options: Omit<FindAndRedactOptions, keyof SearchOptions>,
    onProgress?: ProgressCallback
): Promise<RedactionResult> {
    try {
        if (!file) {
            return {
                success: false,
                error: 'No file provided',
                redactedCount: 0,
            };
        }

        // Filter to only selected matches
        const selectedMatches = options.selectedMatchIds && options.selectedMatchIds.length > 0
            ? matches.filter(m => options.selectedMatchIds!.includes(m.id))
            : matches.filter(m => m.selected);

        if (selectedMatches.length === 0) {
            return {
                success: false,
                error: 'No matches selected for redaction',
                redactedCount: 0,
            };
        }

        onProgress?.(10, 'Loading PDF document...');

        const pdfjs = await loadPdfjs();
        const arrayBuffer = await file.arrayBuffer();
        const pdfDocProxy = await pdfjs.getDocument({ data: arrayBuffer.slice(0) }).promise;
        const totalPages = pdfDocProxy.numPages;

        // Collect page dimensions
        const pageDimensions = new Map<number, { width: number; height: number }>();
        for (let p = 1; p <= totalPages; p++) {
            const pageProxy = await pdfDocProxy.getPage(p);
            const vp = pageProxy.getViewport({ scale: 1.0 });
            pageDimensions.set(p, { width: vp.width, height: vp.height });
        }

        const hexColor = options.color
            ? '#' + [options.color.r, options.color.g, options.color.b]
                .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
                .join('')
            : '#000000';

        const redactions: RedactionArea[] = [];
        for (const match of selectedMatches) {
            if (match.page < 1 || match.page > totalPages) {
                console.warn(`Invalid page number: ${match.page}. Skipping.`);
                continue;
            }

            const pageDim = pageDimensions.get(match.page);
            if (!pageDim) continue;

            const padX = 1.5;
            const padY = 1.5;
            const canvasX = Math.max(0, match.x - padX);
            const canvasY = Math.max(0, pageDim.height - match.y - match.height - padY);
            const canvasW = match.width + padX * 2;
            const canvasH = match.height + padY * 2;

            redactions.push({
                id: match.id,
                type: 'rect',
                page: match.page,
                x: canvasX,
                y: canvasY,
                width: canvasW,
                height: canvasH,
                pageWidth: pageDim.width,
                pageHeight: pageDim.height,
                style: options.color ? 'custom-color' : 'blackout',
                color: hexColor,
                borderColor: options.addBorder ? '#4d4d4d' : undefined,
                label: options.replacementText?.trim() || undefined,
            });
        }

        // Execute irreversible physical rasterization and deep metadata sanitization
        const finalPdfBytes = await redactPDF(
            file,
            redactions,
            {
                renderScale: 2.0,
                outputQuality: 0.95,
                stripMetadata: true,
                purgeAnnotations: true,
            },
            onProgress
        );

        const blob = new Blob([finalPdfBytes as unknown as BlobPart], { type: 'application/pdf' });

        return {
            success: true,
            result: blob,
            redactedCount: selectedMatches.length,
        };
    } catch (error) {
        console.error('Redaction error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to apply redactions',
            redactedCount: 0,
        };
    }
}

/**
 * Combined function to search and redact in one step
 */
export async function findAndRedact(
    file: File,
    options: FindAndRedactOptions,
    onProgress?: ProgressCallback
): Promise<RedactionResult> {
    // First, search for matches
    const searchResult = await searchTextInPDF(
        file,
        {
            searchTerm: options.searchTerm,
            searchTerms: options.searchTerms,
            caseSensitive: options.caseSensitive,
            useRegex: options.useRegex,
            wholeWord: options.wholeWord,
        },
        (progress, message) => onProgress?.(progress * 0.5, message)
    );

    if (!searchResult.success || searchResult.matches.length === 0) {
        return {
            success: searchResult.success,
            error: searchResult.error || 'No matches found',
            redactedCount: 0,
        };
    }

    // Then apply redactions
    return applyFindAndRedact(
        file,
        searchResult.matches,
        {
            color: options.color,
            addBorder: options.addBorder,
            replacementText: options.replacementText,
            selectedMatchIds: options.selectedMatchIds,
        },
        (progress, message) => onProgress?.(50 + progress * 0.5, message)
    );
}

export default {
    searchTextInPDF,
    applyFindAndRedact,
    findAndRedact,
    parseSearchTerms,
};
