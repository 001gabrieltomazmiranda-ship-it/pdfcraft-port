import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../messages/en.json';
import { BookmarkTool } from '@/components/tools/bookmark/BookmarkTool';
import { processBookmarks } from '@/lib/pdf/processors/bookmark';

vi.mock('@/components/tools/FileUploader', () => ({
  FileUploader: ({ onFilesSelected }: { onFilesSelected: (files: File[]) => void }) => (
    <button
      data-testid="mock-uploader"
      onClick={() => {
        const file = new File(['%PDF'], 'book.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(4) });
        onFilesSelected([file]);
      }}
    >
      Upload PDF
    </button>
  ),
}));

vi.mock('@/lib/pdf/loader', () => ({
  configurePdfjsWorker: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: 'mock-worker.js' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 4,
      getPage: async () => ({}),
      getOutline: async () => [
        { title: 'Cover', items: [] },
        { title: 'Page 2', items: [] },
        { title: 'Page 3', items: [] },
        { title: 'Contents', items: [{ title: 'Chapter 1', items: [] }] },
      ],
    }),
  }),
}));

vi.mock('@/lib/pdf/processors/bookmark', () => ({
  processBookmarks: vi.fn(async () => ({ success: true, result: new Blob(['%PDF']) })),
}));

const renderAndLoad = async () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BookmarkTool />
    </NextIntlClientProvider>
  );
  fireEvent.click(screen.getByTestId('mock-uploader'));
  await screen.findByText('Cover');
};

const savedTitles = () => {
  const options = vi.mocked(processBookmarks).mock.calls[0][1];
  const titles: string[] = [];
  const collect = (items: { title: string; children?: unknown[] }[]) => {
    for (const item of items) {
      titles.push(item.title);
      collect((item.children ?? []) as typeof items);
    }
  };
  collect(options.bookmarks ?? []);
  return titles;
};

const originalCreateObjectURL = URL.createObjectURL;

describe('BookmarkTool', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(processBookmarks).mockClear();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    vi.restoreAllMocks();
    cleanup();
  });

  it('removes all bookmarks after confirmation and saves a PDF with none', async () => {
    await renderAndLoad();

    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Cover')).not.toBeInTheDocument();
    expect(screen.getByText('All bookmarks removed. Save to download a PDF with no bookmarks.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Bookmarks' }));
    await waitFor(() => expect(processBookmarks).toHaveBeenCalledTimes(1));
    expect(savedTitles()).toEqual([]);
  });

  it('keeps every bookmark when Remove all is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderAndLoad();

    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));

    expect(screen.getByText('Cover')).toBeInTheDocument();
    expect(screen.getByText('Chapter 1')).toBeInTheDocument();
  });

  it('still offers Save after the last bookmark is deleted individually', async () => {
    await renderAndLoad();

    for (const title of ['Cover', 'Page 2', 'Page 3', 'Contents']) {
      const row = screen.getByText(title).closest('[draggable="true"]') as HTMLElement;
      fireEvent.click(within(row).getByTitle('Delete'));
    }

    fireEvent.click(screen.getByRole('button', { name: 'Save Bookmarks' }));
    await waitFor(() => expect(processBookmarks).toHaveBeenCalledTimes(1));
    expect(savedTitles()).toEqual([]);
  });
});
