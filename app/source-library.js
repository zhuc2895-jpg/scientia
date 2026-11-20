const DOI_PATTERN = /^10\.\d{4,9}\/[\w.()/:;<>+@%?=#\-]+$/i;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const YEAR_PATTERN = /(?:^|[^0-9])((?:18|19|20)\d{2})(?:[^0-9]|$)/;

function cleanBraces(value) {
  return String(value || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function stripWrapping(value) {
  let result = String(value || '').trim();
  while ((result.startsWith('{') && result.endsWith('}')) || (result.startsWith('"') && result.endsWith('"'))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function splitAuthor(value) {
  const author = cleanBraces(stripWrapping(value)).replace(/\s+/g, ' ').trim();
  if (!author) return '';
  const comma = author.indexOf(',');
  if (comma < 0) return author;
  const family = author.slice(0, comma).trim();
  const given = author.slice(comma + 1).trim();
  return [given, family].filter(Boolean).join(' ');
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function normalizeSourceTitle(value) {
  return cleanBraces(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSourceYear(value) {
  if (Number.isInteger(value) && value >= 1000 && value <= 2999) return value;
  const match = String(value || '').match(YEAR_PATTERN);
  return match ? Number(match[1]) : null;
}

export function normalizeDoi(value) {
  let doi = String(value || '').trim();
  if (!doi) return null;
  doi = doi.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  doi = decodeURIComponent(doi).replace(/[),.;]+$/g, '').trim();
  return DOI_PATTERN.test(doi) ? doi.toLowerCase() : null;
}

export function normalizeSourceUrl(value) {
  const raw = String(value || '').trim();
  if (!HTTP_URL_PATTERN.test(raw)) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    let pathname = url.pathname.replace(/\/+$/g, '');
    if (!pathname) pathname = '/';
    url.pathname = pathname;
    return url.toString().replace(/\/$/g, (match, offset) => (url.pathname === '/' && offset === url.origin.length ? '' : match));
  } catch {
    return null;
  }
}

export function classifyReferenceInput(value) {
  const raw = String(value || '').trim();
  const doi = normalizeDoi(raw);
  if (doi) return { kind: 'doi', value: doi };
  const url = normalizeSourceUrl(raw);
  if (url) return { kind: 'url', value: url };
  throw new Error('请输入有效的 DOI 或 URL（HTTP/HTTPS）。');
}

export function stableIdentifierForSource(source) {
  if (typeof source?.stableIdentifier === 'string' && source.stableIdentifier.trim()) {
    return source.stableIdentifier.trim();
  }
  const doi = normalizeDoi(source?.doi);
  if (doi) return `doi:${doi}`;
  const url = normalizeSourceUrl(source?.url);
  if (url) return `url:${url}`;
  return null;
}

export function buildCslJson(source = {}) {
  const typeMap = {
    article: 'article-journal',
    book: 'book',
    inproceedings: 'paper-conference',
    JOUR: 'article-journal',
    BOOK: 'book',
    CONF: 'paper-conference',
    doi: 'article-journal',
    url: 'webpage',
  };
  const cslType = typeMap[source.entryType] || typeMap[source.kind] || 'document';
  const authors = (Array.isArray(source.authors) ? source.authors : []).map((author) => {
    const value = String(author || '').trim();
    const comma = value.indexOf(',');
    if (comma >= 0) return { family: value.slice(0, comma).trim(), given: value.slice(comma + 1).trim() };
    const parts = value.split(/\s+/);
    return parts.length > 1
      ? { family: parts.pop(), given: parts.join(' ') }
      : { literal: value };
  }).filter((author) => author.family || author.literal);
  const csl = {
    type: cslType,
    title: String(source.title || '').trim(),
    ...(authors.length ? { author: authors } : {}),
    ...(normalizeSourceYear(source.year) ? { issued: { 'date-parts': [[normalizeSourceYear(source.year)]] } } : {}),
    ...(normalizeDoi(source.doi) ? { DOI: normalizeDoi(source.doi) } : {}),
    ...(normalizeSourceUrl(source.url) ? { URL: normalizeSourceUrl(source.url) } : {}),
    ...(source.venue ? { 'container-title': String(source.venue).trim() } : {}),
  };
  return csl;
}

export function buildSourceRemovalCheckpointMetadata(source = {}) {
  return {
    sourceId: String(source.id || ''),
    title: String(source.title || ''),
    localLocator: String(source.localLocator || ''),
    trigger: 'User requested removal from the Project Source Library.',
    risk: 'The Source Record disappears from the Project and every Active Source Set; Evidence Freeze will be revoked.',
    options: ['Remove the Source Record', 'Cancel and keep the Source Record'],
    recommendation: 'Preserve the Source Record unless it is wrong or no longer relevant; removal returns the Project to Evidence.',
    estimatedTimeCost: 'Local metadata update; the managed source file is preserved; seconds, no model cost.',
  };
}

export function buildSourceRevisionCheckpointMetadata(source = {}) {
  return {
    sourceId: String(source.id || ''),
    title: String(source.title || ''),
    observedContentHash: String(source.observedContentHash || ''),
    ...((source.observedRevisionLocator || source.metadata?.observedRevisionLocator)
      ? { observedRevisionLocator: String(source.observedRevisionLocator || source.metadata.observedRevisionLocator) }
      : {}),
    trigger: 'The Source content changed and the observed revision must be accepted.',
    risk: 'Accepted content invalidates prior Evidence and requires re-verification before citation.',
    options: ['Accept the observed Source revision', 'Cancel and keep the previous version stale'],
    recommendation: 'Accept only if the new content is the intended source, then verify it before citation.',
    estimatedTimeCost: 'Local metadata update; seconds, no model cost.',
  };
}

export function sourceMetadataIsResolved(source = {}) {
  const title = String(source.title || '').replace(/\s+/g, ' ').trim();
  const authors = Array.isArray(source.authors) ? source.authors.filter(Boolean) : [];
  const venue = String(source.venue || '').trim();
  const year = Number(source.year);
  const identities = [source.doi, source.url, source.stableIdentifier]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const placeholderTitle = !title
    || identities.some((identity) => identity.toLowerCase() === title.toLowerCase())
    || /^(?:doi:|https?:\/\/)/i.test(title)
    || /^DOI\s+10\./i.test(title);
  return !placeholderTitle && (authors.length > 0 || venue) && Number.isInteger(year) && year >= 1000 && year <= 2200;
}

export function buildBibTeXKey(source = {}) {
  if (typeof source.citekey === 'string' && source.citekey.trim()) {
    return source.citekey.trim().replace(/[^A-Za-z0-9:_-]/g, '');
  }
  const title = String(source.title || '').trim();
  const year = normalizeSourceYear(source.year);
  const authors = (Array.isArray(source.authors) ? source.authors : []).map((author) => String(author || '').trim()).filter(Boolean);
  const firstFamily = (authors[0] || 'source').split(/\s+/).pop().replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'source';
  const titleWord = title.split(/\s+/).find((word) => word.length > 3)?.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'record';
  let hash = 0xcbf29ce484222325n;
  for (const char of `${firstFamily}|${year || 'nd'}|${title.toLowerCase()}`) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${firstFamily}${year || 'nd'}${titleWord}${hash.toString(36)}`;
}

export function buildBibTeX(source = {}) {
  const title = String(source.title || '').trim();
  const year = normalizeSourceYear(source.year);
  const authors = (Array.isArray(source.authors) ? source.authors : []).map((author) => String(author || '').trim()).filter(Boolean);
  const key = buildBibTeXKey(source);
  const entryType = source.kind === 'doi' || source.entryType === 'article' || source.entryType === 'JOUR'
    ? 'article'
    : source.entryType === 'book' || source.entryType === 'BOOK'
      ? 'book'
      : 'misc';
  const fields = [
    title ? `  title = {${title.replace(/[{}]/g, '')}}` : '',
    authors.length ? `  author = {${authors.join(' and ')}}` : '',
    year ? `  year = {${year}}` : '',
    normalizeDoi(source.doi) ? `  doi = {${normalizeDoi(source.doi)}}` : '',
    normalizeSourceUrl(source.url) ? `  url = {${normalizeSourceUrl(source.url)}}` : '',
    source.venue ? `  journal = {${String(source.venue).replace(/[{}]/g, '')}}` : '',
  ].filter(Boolean);
  return `@${entryType}{${key},\n${fields.join(',\n')}${fields.length ? '\n' : ''}}`;
}

export function findDuplicateSource(candidate, existingSources = []) {
  const candidateStable = stableIdentifierForSource(candidate);
  const candidateDoi = normalizeDoi(candidate?.doi);
  const candidateUrl = normalizeSourceUrl(candidate?.url);
  const candidateTitle = normalizeSourceTitle(candidate?.title);
  const candidateYear = normalizeSourceYear(candidate?.year);

  for (const existing of existingSources) {
    const existingStable = stableIdentifierForSource(existing);
    if (candidateStable && existingStable && candidateStable === existingStable) return existing;
    const existingDoi = normalizeDoi(existing?.doi);
    if (candidateDoi && existingDoi && candidateDoi === existingDoi) return existing;
    const existingUrl = normalizeSourceUrl(existing?.url);
    if (candidateUrl && existingUrl && candidateUrl === existingUrl) return existing;
  }

  if (!candidateTitle || !candidateYear) return null;
  const authoritativeStable = (value) => /^(?:doi|url):/i.test(value || '');
  return existingSources.find((existing) => {
    const existingStable = stableIdentifierForSource(existing);
    if (
      authoritativeStable(candidateStable)
      && authoritativeStable(existingStable)
      && candidateStable !== existingStable
    ) return false;
    return normalizeSourceTitle(existing?.title) === candidateTitle
      && normalizeSourceYear(existing?.year) === candidateYear;
  }) || null;
}

function parseBibFields(content) {
  const fields = {};
  let index = 0;
  while (index < content.length) {
    while (index < content.length && /[\s,]/.test(content[index])) index += 1;
    const keyMatch = content.slice(index).match(/^([A-Za-z][\w-]*)\s*=\s*/);
    if (!keyMatch) break;
    const key = keyMatch[1].toLowerCase();
    index += keyMatch[0].length;
    let value = '';
    if (content[index] === '{') {
      let depth = 1;
      const start = ++index;
      while (index < content.length && depth > 0) {
        if (content[index] === '{') depth += 1;
        else if (content[index] === '}') depth -= 1;
        if (depth > 0) index += 1;
      }
      value = content.slice(start, index);
      index += 1;
    } else if (content[index] === '"') {
      const start = ++index;
      while (index < content.length && content[index] !== '"') index += 1;
      value = content.slice(start, index);
      index += 1;
    } else {
      const start = index;
      while (index < content.length && content[index] !== ',' && content[index] !== '\n') index += 1;
      value = content.slice(start, index).trim();
    }
    fields[key] = value;
  }
  return fields;
}

export function parseBibTeX(text) {
  const source = String(text || '');
  const records = [];
  let index = 0;
  while (index < source.length) {
    const match = source.slice(index).match(/@([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/);
    if (!match) break;
    const entryType = match[1].toLowerCase();
    const citationKey = match[2].trim();
    const openIndex = index + match.index + match[0].lastIndexOf(match[0].includes('{') ? '{' : '(');
    const open = source[openIndex];
    const close = open === '{' ? '}' : ')';
    let depth = 1;
    let cursor = openIndex + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === open) depth += 1;
      else if (source[cursor] === close) depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error(`BibTeX 条目 ${citationKey} 的括号未闭合。`);
    const bodyStart = index + match.index + match[0].length;
    const fields = parseBibFields(source.slice(bodyStart, cursor - 1));
    const title = cleanBraces(stripWrapping(fields.title || fields.booktitle || ''));
    const authors = uniqueStrings(String(fields.author || '').split(/\s+and\s+/i).map(splitAuthor));
    const doi = normalizeDoi(fields.doi || '');
    const url = normalizeSourceUrl(fields.url || '');
    records.push({
      kind: 'bibtex',
      title: title || cleanBraces(citationKey),
      authors,
      year: normalizeSourceYear(fields.year || fields.date),
      doi,
      url,
      venue: cleanBraces(stripWrapping(fields.journal || fields.booktitle || fields.publisher || '')),
      stableIdentifier: stableIdentifierForSource({ doi, url }),
      metadata: { entryType, citationKey, fields },
      raw: source.slice(index + match.index, cursor),
    });
    index += match.index + (cursor - (index + match.index));
  }
  return records;
}

export function parseRis(text) {
  const source = String(text || '');
  const records = [];
  let current = null;
  const push = () => {
    if (!current) return;
    const title = cleanBraces((current.TI || current.T1 || [''])[0]);
    const doi = normalizeDoi((current.DO || [''])[0]);
    const url = normalizeSourceUrl((current.UR || [''])[0]);
    records.push({
      kind: 'ris',
      title: title || `RIS source ${records.length + 1}`,
      authors: uniqueStrings((current.AU || current.A1 || []).map(splitAuthor)),
      year: normalizeSourceYear((current.PY || current.Y1 || [''])[0]),
      doi,
      url,
      venue: cleanBraces((current.JO || current.JF || current.T2 || current.BT || [''])[0]),
      stableIdentifier: stableIdentifierForSource({ doi, url }),
      metadata: { entryType: (current.TY || [''])[0] },
      raw: current._raw.join('\n'),
    });
    current = null;
  };
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9]{2})\s{2}-\s?(.*)$/);
    if (!match) continue;
    const tag = match[1];
    const value = match[2].trim();
    if (tag === 'TY') {
      push();
      current = { TY: [value], _raw: [line] };
      continue;
    }
    if (!current) continue;
    if (tag === 'ER') {
      current._raw.push(line);
      push();
      continue;
    }
    if (!current[tag]) current[tag] = [];
    current[tag].push(value);
    current._raw.push(line);
  }
  push();
  return records;
}

export function parseMarkdownSource(text, { sourceName = 'source.md' } = {}) {
  const source = String(text || '');
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const fields = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (match) fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const heading = source.match(/^\s*#\s+(.+)$/m)?.[1] || '';
  const fallbackTitle = String(sourceName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const doi = normalizeDoi(source.match(/\b10\.\d{4,9}\/[^\s<>()]+/i)?.[0] || fields.doi || '');
  const url = normalizeSourceUrl(fields.url || source.match(/https?:\/\/[^\s<>()]+/i)?.[0] || '');
  return {
    kind: 'markdown',
    title: cleanBraces(fields.title || heading || fallbackTitle),
    authors: uniqueStrings(String(fields.author || fields.authors || '').split(/\s*(?:;|\band\b)\s*/i).map(splitAuthor)),
    year: normalizeSourceYear(fields.year || fields.date || source),
    doi,
    url,
    venue: cleanBraces(fields.venue || fields.journal || ''),
    stableIdentifier: stableIdentifierForSource({ doi, url }),
    metadata: { frontmatter: fields },
  };
}

function extractTexCommand(source, command) {
  const start = source.indexOf(`\\${command}`);
  if (start < 0) return '';
  const brace = source.indexOf('{', start + command.length + 1);
  if (brace < 0) return '';
  let depth = 1;
  let index = brace + 1;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') depth -= 1;
    index += 1;
  }
  return depth === 0 ? source.slice(brace + 1, index - 1).trim() : '';
}

export function parseTexSource(text, { sourceName = 'source.tex' } = {}) {
  const source = String(text || '');
  const title = cleanBraces(extractTexCommand(source, 'title'));
  const authors = uniqueStrings(extractTexCommand(source, 'author').split(/\\and\b/i).map(splitAuthor));
  const date = extractTexCommand(source, 'date');
  const doi = normalizeDoi(source.match(/\b10\.\d{4,9}\/[^\s{}]+/i)?.[0] || '');
  const url = normalizeSourceUrl(source.match(/https?:\/\/[^\s{}]+/i)?.[0] || '');
  return {
    kind: 'tex',
    title: title || String(sourceName).replace(/\.[^.]+$/, ''),
    authors,
    year: normalizeSourceYear(date || source),
    doi,
    url,
    venue: '',
    stableIdentifier: stableIdentifierForSource({ doi, url }),
    metadata: {},
  };
}

function decodePdfLiteral(value) {
  return String(value || '')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)))
    .trim();
}

export function parsePdfSource(content, { sourceName = 'source.pdf' } = {}) {
  const raw = Buffer.isBuffer(content) ? content.toString('latin1') : String(content || '');
  const title = decodePdfLiteral(raw.match(/\/Title\s*\((.*?)\)/s)?.[1] || '');
  const created = raw.match(/\/CreationDate\s*\(D:((?:18|19|20)\d{2})/)?.[1] || '';
  const doi = normalizeDoi(raw.match(/\b10\.\d{4,9}\/[^\s<>()]+/i)?.[0] || '');
  return {
    kind: 'pdf',
    title: cleanBraces(title || String(sourceName).replace(/\.[^.]+$/, '')),
    authors: [],
    year: normalizeSourceYear(created),
    doi,
    url: null,
    venue: '',
    stableIdentifier: doi ? `doi:${doi}` : null,
    metadata: { pdfMetadataDetected: Boolean(title || created) },
  };
}
