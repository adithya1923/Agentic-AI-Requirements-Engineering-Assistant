import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { config } from '../config.js';

export class DocumentExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentExtractionError';
    this.status = 422;
    this.code = 'EXTRACTION_FAILED';
  }
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw new DocumentExtractionError('TXT file contains binary data.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new DocumentExtractionError('TXT file must use valid UTF-8 encoding.');
  }
}

async function extractDocx(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DocumentExtractionError('DOCX file is not a valid Office Open XML document.');
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch {
    throw new DocumentExtractionError('Unable to extract text from this DOCX file.');
  }
}

async function extractPdf(buffer) {
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DocumentExtractionError('PDF file signature is invalid.');
  }

  let loadingTask;
  let document;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    document = await loadingTask.promise;
    if (document.numPages > config.maxPdfPages) {
      throw new DocumentExtractionError(`PDF exceeds the ${config.maxPdfPages}-page extraction limit.`);
    }

    const pages = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      characterCount += text.length;
      if (characterCount > config.maxExtractedChars) {
        throw new DocumentExtractionError(`Extracted text exceeds the ${config.maxExtractedChars}-character limit.`);
      }
      pages.push(text);
      page.cleanup();
    }
    return pages.join('\n').trim();
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError('Unable to extract text from this PDF file.');
  } finally {
    await loadingTask?.destroy();
  }
}

export async function extractDocumentText(buffer, extension) {
  let text;
  if (extension === '.txt') text = decodeText(buffer);
  else if (extension === '.docx') text = await extractDocx(buffer);
  else if (extension === '.pdf') text = await extractPdf(buffer);
  else throw new DocumentExtractionError('This document format is not supported.');

  text = text.replaceAll('\r\n', '\n').trim();
  if (!text) throw new DocumentExtractionError('No text could be extracted from this document.');
  if (text.length > config.maxExtractedChars) {
    throw new DocumentExtractionError(`Extracted text exceeds the ${config.maxExtractedChars}-character limit.`);
  }
  return text;
}
