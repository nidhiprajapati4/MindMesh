import mammoth from 'mammoth';
import { HttpError } from '../../middleware/errors';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_CONTENT_CHARS = 50000;

export const ALLOWED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx'] as const;
type Kind = 'text' | 'markdown' | 'pdf' | 'docx';

const MIME: Record<Kind, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export type ExtractedFile = {
  title: string;
  content: string;
  truncated: boolean;
  mimeType: string;
  pageCount?: number;
};

const unsupported = () => new HttpError(415, `Unsupported file. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`);
const mismatch = () => new HttpError(415, "The file's contents don't match its extension");

function kindFromName(fileName: string): Kind {
  const ext = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0];
  if (ext === '.txt') return 'text';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  throw unsupported();
}

// Content sniffing: the extension alone is client-controlled, so check the leading bytes too.
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

function decodeText(b: Buffer): string {
  if (b.includes(0)) throw mismatch(); // NUL bytes mean binary, not text
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    throw new HttpError(415, 'Text files must be UTF-8 encoded');
  }
}

// pdfjs-dist is ESM-only; tsconfig's node16 module mode keeps this a real dynamic import.
const loadPdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');

async function extractPdf(b: Buffer) {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    // pdf.js may transfer/detach the array it is given, so hand it a private copy.
    data: new Uint8Array(b),
    isEvalSupported: false, // never compile code from PDF content
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text);
      page.cleanup();
    }
    return { text: pages.join('\n\n'), pageCount: doc.numPages };
  } catch {
    throw new HttpError(422, 'Could not read this PDF (it may be damaged or password-protected)');
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function extractDocx(b: Buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer: b });
    return value;
  } catch {
    throw new HttpError(422, 'Could not read this Word document');
  }
}

const normalise = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const titleFrom = (fileName: string, kind: Kind, text: string) => {
  if (kind === 'markdown') {
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (heading) return heading.slice(0, 200);
  }
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Untitled document';
};

/** Turns an uploaded file into note text. The raw file is not stored. */
export async function extractFile(fileName: string, buffer: Buffer): Promise<ExtractedFile> {
  const kind = kindFromName(fileName);
  if (!buffer.length) throw new HttpError(422, 'The file is empty');

  let text: string;
  let pageCount: number | undefined;
  if (kind === 'pdf') {
    if (!isPdf(buffer)) throw mismatch();
    ({ text, pageCount } = await extractPdf(buffer));
  } else if (kind === 'docx') {
    if (!isZip(buffer)) throw mismatch();
    text = await extractDocx(buffer);
  } else {
    if (isPdf(buffer) || isZip(buffer)) throw mismatch();
    text = decodeText(buffer);
  }

  text = normalise(text);
  if (!text) {
    throw new HttpError(422, kind === 'pdf' ? 'No text found in this PDF (scanned/image-only PDFs are not supported yet)' : 'No text found in this file');
  }

  const truncated = text.length > MAX_CONTENT_CHARS;
  return {
    title: titleFrom(fileName, kind, text),
    content: truncated ? text.slice(0, MAX_CONTENT_CHARS) : text,
    truncated,
    mimeType: MIME[kind],
    pageCount,
  };
}
