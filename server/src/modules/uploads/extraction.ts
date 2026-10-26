import { inflateRawSync } from 'node:zlib';
import { badRequest } from '../../platform/errors';

/**
 * Text extraction without a heavyweight parser dependency.
 *
 * We only ever read the text layer the client's own tool wrote:
 *  - DOCX  → the WordprocessingML parts inside the ZIP, unzipped by hand and scanned for <w:t>.
 *  - PDF   → the uncompressed text operators plus FlateDecode streams we can inflate.
 *
 * Deliberate limits, because a false extraction is worse than none:
 *  - a scanned PDF has no text layer, so we report `needsOcr` instead of guessing;
 *  - extraction failure is a normal outcome, never an exception that breaks an upload;
 *  - the extracted text is untrusted INPUT. It is data to compare against, never instructions.
 */

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_STREAMS = 400;

export interface ExtractionResult {
  status: 'done' | 'failed' | 'unsupported' | 'skipped';
  method: 'pdf_text' | 'docx_xml' | 'plain_text' | 'none';
  text: string;
  charCount: number;
  pageCount: number | null;
  needsOcr: boolean;
  error: string;
}

const failure = (error: string, method: ExtractionResult['method'] = 'none'): ExtractionResult => ({
  status: 'failed',
  method,
  text: '',
  charCount: 0,
  pageCount: null,
  needsOcr: false,
  error,
});

/** Sniff the real type from the bytes. We never trust the client's Content-Type. */
export function detectMime(buffer: Buffer): { mime: string; kind: 'pdf' | 'docx' | 'text' | 'zip' | 'unknown' } {
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', kind: 'pdf' };
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // ZIP container: DOCX is a zip with [Content_Types].xml; plain .zip/.docx are indistinguishable here.
    return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' };
  }
  // UTF-8 text heuristic: no NUL bytes and mostly printable.
  const sample = buffer.subarray(0, 512);
  const printable = sample.reduce((n, b) => n + (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) ? 1 : 0), 0);
  if (sample.length > 0 && printable / sample.length > 0.9 && !sample.includes(0)) return { mime: 'text/plain', kind: 'text' };
  return { mime: 'application/octet-stream', kind: 'unknown' };
}

export function isAllowedUpload(mime: string, sizeBytes: number): { allowed: boolean; reason?: string } {
  const allowed = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ]);
  if (!allowed.has(mime)) {
    return {
      allowed: false,
      reason: `Unsupported file type (${mime}). Accepted: PDF, DOCX, and plain text. Other formats are rejected rather than guessed at.`,
    };
  }
  if (sizeBytes > 15 * 1024 * 1024) return { allowed: false, reason: 'Files larger than 15 MB are not accepted.' };
  if (sizeBytes === 0) return { allowed: false, reason: 'The uploaded file is empty.' };
  return { allowed: true };
}

// ── DOCX ────────────────────────────────────────────────────────────────────

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // Locate the End Of Central Directory record (scan back over the comment area).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip container');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount && i < 2000; i += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        entries.set(name, method === 0 ? raw : inflateRawSync(raw));
      } catch {
        // A single unreadable part must not fail the whole document.
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function extractDocx(buffer: Buffer): ExtractionResult {
  try {
    const entries = readZipEntries(buffer);
    const article = entries.get('word/document.xml');
    if (!article) return failure('The file is a ZIP archive but has no Word document part (word/document.xml).', 'docx_xml');

    const xml = article.toString('utf8');
    const text = xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_TEXT_CHARS);

    if (!text) return { status: 'done', method: 'docx_xml', text: '', charCount: 0, pageCount: null, needsOcr: false, error: '' };
    return { status: 'done', method: 'docx_xml', text, charCount: text.length, pageCount: null, needsOcr: false, error: '' };
  } catch (err) {
    return failure(`Word document could not be read: ${err instanceof Error ? err.message : 'unknown error'}.`, 'docx_xml');
  }
}

// ── PDF ─────────────────────────────────────────────────────────────────────

function pdfLiteralToString(literal: string): string {
  return literal
    .replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Extracts text from all Tj/TJ show-text operators, including arrays with kerning offsets. */
function textFromContentStream(content: string): string {
  let out = '';
  const show = /\(((?:\\.|[^\\()])*)\)\s*(Tj|'|")/g;
  const arrayShow = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = show.exec(content)) !== null) out += pdfLiteralToString(m[1] ?? '') + ' ';
  while ((m = arrayShow.exec(content)) !== null) {
    const inner = m[1] ?? '';
    const parts = inner.match(/\((?:\\.|[^\\()])*\)/g) ?? [];
    for (const part of parts) out += pdfLiteralToString(part.slice(1, -1));
    out += ' ';
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

export function extractPdf(buffer: Buffer): ExtractionResult {
  try {
    const latin = buffer.toString('latin1');
    const pageCount = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length || null;
    let text = '';

    // 1) Uncompressed content streams.
    text += textFromContentStream(latin);

    // 2) Flate-compressed streams, inflated individually.
    let consumed = 0;
    let searchFrom = 0;
    while (consumed < MAX_PDF_STREAMS) {
      const streamAt = latin.indexOf('stream', searchFrom);
      if (streamAt < 0) break;
      const dictStart = latin.lastIndexOf('<<', streamAt);
      const dict = dictStart >= 0 ? latin.slice(dictStart, streamAt) : '';
      let dataStart = streamAt + 'stream'.length;
      if (latin[dataStart] === '\r') dataStart += 1;
      if (latin[dataStart] === '\n') dataStart += 1;
      const endAt = latin.indexOf('endstream', dataStart);
      if (endAt < 0) break;
      const raw = buffer.subarray(dataStart, endAt);
      if (/FlateDecode/.test(dict)) {
        try {
          text += ` ${textFromContentStream(inflateRawSync(raw).toString('latin1'))}`;
          consumed += 1;
        } catch {
          // Some streams are images or malformed; skip quietly.
        }
      } else if (/\/Text\b|Tj|TJ/.test(latin.slice(Math.max(0, dataStart), Math.min(latin.length, dataStart + 200)))) {
        text += ` ${textFromContentStream(raw.toString('latin1'))}`;
        consumed += 1;
      }
      searchFrom = endAt + 1;
    }

    const cleaned = text.replace(/\s{3,}/g, '  ').replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_TEXT_CHARS);
    const meaningful = cleaned.replace(/[^\p{L}\p{N}]/gu, '').length;

    if (meaningful < 40) {
      return {
        status: 'skipped',
        method: 'pdf_text',
        text: '',
        charCount: 0,
        pageCount,
        needsOcr: true,
        error:
          'No usable text layer was found in this PDF. It is most likely a scan or an export of images. Text extraction requires OCR, which is not enabled, so the file is stored but not read.',
      };
    }

    return { status: 'done', method: 'pdf_text', text: cleaned, charCount: cleaned.length, pageCount, needsOcr: false, error: '' };
  } catch (err) {
    return failure(`PDF could not be read: ${err instanceof Error ? err.message : 'unknown error'}.`, 'pdf_text');
  }
}

export function extractText(buffer: Buffer): ExtractionResult {
  const text = buffer.toString('utf8').slice(0, MAX_TEXT_CHARS);
  return { status: 'done', method: 'plain_text', text, charCount: text.length, pageCount: null, needsOcr: false, error: '' };
}

export function extract(buffer: Buffer, mime: string): ExtractionResult {
  if (mime === 'application/pdf') return extractPdf(buffer);
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return extractDocx(buffer);
  if (mime === 'text/plain' || mime === 'text/markdown') return extractText(buffer);
  return failure(`Text extraction is not supported for ${mime}.`, 'none');
}

/**
 * Candidate requirement lines suggested from a document. These are SUGGESTIONS for a human to
 * review and edit — they are never written into a baseline automatically, because inventing
 * scope from prose is exactly the failure mode this product exists to prevent.
 */
export interface CandidateRequirement {
  text: string;
  source: 'heading' | 'bullet' | 'keyword_sentence';
  confidence: 'low' | 'medium';
  lineNumber: number;
}

const REQUIREMENT_CUES = /\b(must|shall|should|will|needs? to|required|include[sd]?|deliver[s]?)\b/i;

export function suggestCandidateRequirements(text: string, limit = 60): CandidateRequirement[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const candidates: CandidateRequirement[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.length < 12 || line.length > 400) return;
    if (candidates.length >= limit) return;
    if (/^[•·▪◦*-]\s+/.test(line)) {
      candidates.push({ text: line.replace(/^[•·▪◦*-]\s+/, ''), source: 'bullet', confidence: 'medium', lineNumber: index + 1 });
      return;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      candidates.push({ text: line.replace(/^\d+[.)]\s+/, ''), source: 'bullet', confidence: 'medium', lineNumber: index + 1 });
      return;
    }
    if (REQUIREMENT_CUES.test(line) && line.split(/\s+/).length >= 6) {
      candidates.push({ text: line, source: 'keyword_sentence', confidence: 'low', lineNumber: index + 1 });
    }
  });
  return candidates;
}

export function assertExtractable(mime: string): void {
  const extracted = extract(Buffer.from('%PDF-'), mime);
  if (extracted.status === 'failed' && extracted.method === 'none' && mime.startsWith('application/octet-stream')) {
    throw badRequest('This file type cannot be read.');
  }
}
