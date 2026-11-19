import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  classifyReferenceInput,
  normalizeSourceYear,
  parseBibTeX,
  parseMarkdownSource,
  parsePdfSource,
  parseRis,
  parseTexSource,
} from '../app/source-library.js';

const SOURCE_FORMATS = new Map([
  ['.pdf', 'pdf'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.tex', 'tex'],
  ['.latex', 'tex'],
  ['.bib', 'bibtex'],
  ['.ris', 'ris'],
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSegment(value) {
  return String(value || 'source')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'source';
}

function relativeLocator(workspacePath, absolutePath) {
  return path.relative(workspacePath, absolutePath).split(path.sep).join('/');
}

function sourceBase(sourceName) {
  return String(sourceName || 'source').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function parseFileContent(kind, bytes, sourceName) {
  if (kind === 'pdf') return [parsePdfSource(bytes, { sourceName })];
  const text = bytes.toString('utf8');
  if (kind === 'markdown') return [parseMarkdownSource(text, { sourceName })];
  if (kind === 'tex') return [parseTexSource(text, { sourceName })];
  if (kind === 'bibtex') return parseBibTeX(text);
  if (kind === 'ris') return parseRis(text);
  throw new Error('不支持的来源文件类型。');
}

export async function ingestSourceFiles({
  workspacePath,
  filePaths,
  now = () => new Date().toISOString(),
  idFactory = randomUUID,
} = {}) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('Research Workspace 路径无效。');
  }
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  if (filePaths.length > 20) throw new Error('一次最多导入 20 个来源文件。');

  const sourceDirectory = path.join(workspacePath, '.science', 'sources');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const acquiredAt = now();
  const records = [];

  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('来源文件路径无效。');
    const extension = path.extname(filePath).toLowerCase();
    const kind = SOURCE_FORMATS.get(extension);
    if (!kind) throw new Error(`不支持的来源格式：${extension || '无扩展名'}`);
    const bytes = await fs.readFile(filePath);
    const fileHash = sha256(bytes);
    const sourceName = path.basename(filePath);
    const parsed = parseFileContent(kind, bytes, sourceName);
    if (!parsed.length) throw new Error(`无法从 ${sourceName} 读取任何来源条目。`);
    const id = String(idFactory());
    const destination = path.join(sourceDirectory, `${safeSegment(id)}-${safeSegment(sourceName)}`);
    await fs.copyFile(filePath, destination);
    const locator = relativeLocator(workspacePath, destination);

    parsed.forEach((entry, index) => {
      const stableIdentifier = entry.stableIdentifier || null;
      records.push({
        id: parsed.length > 1 ? String(idFactory()) : id,
        kind: entry.kind || kind,
        title: entry.title || sourceBase(sourceName),
        authors: Array.isArray(entry.authors) ? entry.authors : [],
        year: normalizeSourceYear(entry.year),
        doi: entry.doi || null,
        url: entry.url || null,
        venue: entry.venue || '',
        stableIdentifier,
        localLocator: parsed.length > 1 ? `${locator}#entry-${index + 1}` : locator,
        contentHash: fileHash,
        acquiredAt,
        metadata: {
          ...(entry.metadata || {}),
          sourceName,
          fileHash,
          contentHashBasis: 'original-file',
          importedFormat: kind,
        },
      });
    });
  }
  return records;
}

export async function ingestReference({
  workspacePath,
  reference,
  title = '',
  year = null,
  now = () => new Date().toISOString(),
  idFactory = randomUUID,
} = {}) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('Research Workspace 路径无效。');
  }
  const classified = classifyReferenceInput(reference);
  const id = String(idFactory());
  const acquiredAt = now();
  const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim()
    || (classified.kind === 'doi' ? `DOI ${classified.value}` : classified.value);
  const normalizedYear = normalizeSourceYear(year);
  const originalReference = String(reference).trim();
  const contentHash = sha256(Buffer.from(originalReference, 'utf8'));
  const payload = {
    id,
    kind: classified.kind,
    reference: classified.value,
    title: normalizedTitle,
    year: normalizedYear,
    acquiredAt,
    contentHash,
    contentHashBasis: 'imported-reference',
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const localFileHash = sha256(bytes);
  const directory = path.join(workspacePath, '.science', 'sources');
  const destination = path.join(directory, `${safeSegment(id)}-reference.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(destination, bytes);
  return {
    id,
    kind: classified.kind,
    title: normalizedTitle,
    authors: [],
    year: normalizedYear,
    doi: classified.kind === 'doi' ? classified.value : null,
    url: classified.kind === 'url' ? classified.value : null,
    venue: '',
    stableIdentifier: `${classified.kind}:${classified.value}`,
    localLocator: relativeLocator(workspacePath, destination),
    contentHash,
    acquiredAt,
    metadata: {
      reference: classified.value,
      sourceName: path.basename(destination),
      fileHash: localFileHash,
      contentHashBasis: 'imported-reference',
    },
  };
}
