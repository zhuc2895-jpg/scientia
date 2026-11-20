import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { sourceMetadataIsResolved } from '../app/source-library.js';
import { isWithin } from './path-boundary.js';

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function assertResolvedSourceMetadata(source) {
  if (!sourceMetadataIsResolved(source)) {
    throw new Error('Source 元数据尚未解析完整，不能标记为 verified。');
  }
}

function lineRange(locator, lineCount) {
  const match = String(locator || '').trim().match(/^line:(\d+)(?:-(\d+))?$/i);
  if (!match) throw new Error('Source locator 必须使用 line:<行号> 或 page:<页码>。');
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lineCount) {
    throw new Error('Source locator 超出来源内容范围。');
  }
  return { start, end };
}

function decodePdfString(value) {
  return value
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([nrtbf])/g, (_match, escape) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escape] || '')
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function pdfTextLayer(source) {
  const strings = [];
  for (const match of source.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
    strings.push(decodePdfString(match[0].slice(1, -1)));
  }
  return normalizedText(strings.join(' '));
}

function pdfStreamBytes(body) {
  const stream = body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  if (!stream) return null;
  let bytes = Buffer.from(stream[1], 'latin1');
  if (/\/FlateDecode\b/.test(body)) {
    try {
      bytes = inflateSync(bytes);
    } catch {
      return null;
    }
  }
  return bytes;
}

function pdfPages(bytes) {
  const raw = bytes.toString('latin1');
  const objects = new Map();
  for (const match of raw.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const pages = [];
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) continue;
    const contents = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    const contentBytes = contents ? pdfStreamBytes(objects.get(Number(contents[1])) || '') : null;
    pages.push(contentBytes ? pdfTextLayer(contentBytes.toString('latin1')) : '');
  }
  if (pages.length) return pages;
  const fallback = [];
  for (const body of objects.values()) {
    const streamBytes = pdfStreamBytes(body);
    if (streamBytes) fallback.push(pdfTextLayer(streamBytes.toString('latin1')));
  }
  return fallback.length ? fallback : [pdfTextLayer(raw)];
}

function pdfPageText(locator, pages) {
  const match = String(locator || '').trim().match(/^page:(\d+)$/i);
  if (!match) throw new Error('PDF Source locator 必须使用 page:<页码>。');
  const page = Number(match[1]);
  if (!Number.isInteger(page) || page < 1 || page > pages.length) {
    throw new Error('Source locator 超出来源内容范围。');
  }
  return normalizedText(pages[page - 1]);
}

export async function verifySourceEvidence({
  workspacePath,
  source,
  locator,
  quote,
  claim,
} = {}) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('Research Workspace 路径无效。');
  }
  if (!source || typeof source.localLocator !== 'string' || !source.localLocator.trim()) {
    throw new Error('Source Record 缺少本地定位。');
  }
  assertResolvedSourceMetadata(source);
  const normalizedLocator = String(locator || '').trim();
  const normalizedQuote = normalizedText(quote);
  const normalizedClaim = String(claim || '').replace(/\s+/g, ' ').trim();
  if (!normalizedLocator || !normalizedQuote || !normalizedClaim) {
    throw new Error('验证 Source 需要定位、短引文和支持主张。');
  }
  if (normalizedClaim.length > 2000) throw new Error('Source 支持主张过长。');
  if (normalizedQuote.length > 2000) throw new Error('Source 短引文过长。');

  const relativeLocator = source.localLocator.split('#')[0];
  const sourcePath = path.resolve(workspacePath, relativeLocator);
  if (!isWithin(workspacePath, sourcePath)) throw new Error('Source local locator 不在当前 Research Workspace 中。');
  const [realWorkspace, realSource] = await Promise.all([fs.realpath(workspacePath), fs.realpath(sourcePath)]);
  if (!isWithin(realWorkspace, realSource)) throw new Error('Source local locator 指向当前 Research Workspace 之外。');
  const bytes = await fs.readFile(realSource);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const expectedHash = String(source.observedContentHash || source.contentHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Source Record 缺少内容哈希。');
  if (contentHash !== expectedHash) throw new Error('Source 内容已变化，请先刷新并重新接受版本。');

  let locatedText;
  if (source.kind === 'pdf' || path.extname(relativeLocator).toLowerCase() === '.pdf') {
    locatedText = pdfPageText(normalizedLocator, pdfPages(bytes));
  } else {
    const content = bytes.toString('utf8');
    const lines = content.split(/\r?\n/);
    const range = lineRange(normalizedLocator, lines.length);
    locatedText = normalizedText(lines.slice(range.start - 1, range.end).join('\n'));
  }
  if (!locatedText.includes(normalizedQuote)) {
    throw new Error('短引文未出现在 locator 指向的来源内容中。');
  }
  return {
    locator: normalizedLocator,
    quote: normalizedQuote,
    claim: normalizedClaim,
    contentHash,
    verifiedAt: new Date().toISOString(),
  };
}
