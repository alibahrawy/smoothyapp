import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';
import { getDocumentProxy, extractText } from 'unpdf';
import catalog from '../shared/chat-catalog.json';

export const chatFileExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'docx', 'txt', 'md', 'csv', 'tsv', 'json', 'srt', 'vtt'];

/** Only local bytes/text are read here; attaching never calls a provider. */
export async function readChatAttachment(file: string) {
  if (typeof file !== 'string' || !file) throw new Error('Choose a file.');
  const extension = path.extname(file).slice(1).toLowerCase();
  if (!chatFileExtensions.includes(extension)) throw new Error('Choose an image, PDF, Word document or text file.');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > catalog.maxFileBytes) throw new Error('Choose a file smaller than 10 MB.');
  const bytes = await fs.readFile(file);
  if (bytes.length > catalog.maxFileBytes) throw new Error('Choose a file smaller than 10 MB.');
  const name = path.basename(file).replace(/[\x00-\x1f]/g, '').slice(0, 120);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    try {
      const image = await sharp(bytes, { limitInputPixels: 50_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 82 }).toBuffer();
      if (image.length > catalog.maxImageBytes) throw new Error();
      return { type: 'image' as const, name, data: `data:image/jpeg;base64,${image.toString('base64')}` };
    } catch { throw new Error('This image could not be prepared. Choose a smaller PNG, JPEG, WebP or GIF.'); }
  }
  let text: string;
  try {
    if (extension === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        if (pdf.numPages > 80) throw new Error('too-long');
        text = (await extractText(pdf, { mergePages: true })).text;
      } finally { await pdf.loadingTask.destroy(); }
    } else if (extension === 'docx') {
      // Bound expanded data before the Word parser opens ZIP entries.
      const entries = new AdmZip(bytes).getEntries();
      if (entries.length > 5000 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > 32 * 1024 * 1024) throw new Error('too-long');
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('binary');
    }
  } catch { throw new Error('This document could not be read. Choose a text-based, unprotected PDF, DOCX or UTF-8 text file (up to 80 PDF pages).'); }
  text = text.trim();
  if (!text) throw new Error('This file has no readable text. For a scanned document, attach its pages as images.');
  if (text.length > catalog.maxAttachmentChars) throw new Error('This document is too long. Attach an excerpt of up to 24,000 characters.');
  return { type: 'text' as const, name, text };
}
