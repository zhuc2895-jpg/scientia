import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReferenceInput,
  findDuplicateSource,
  normalizeDoi,
  normalizeSourceTitle,
  normalizeSourceUrl,
  normalizeSourceYear,
  parseBibTeX,
  parseMarkdownSource,
  parseRis,
  parseTexSource,
} from '../../app/source-library.js';

test('reference identifiers normalize to stable forms', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC.123'), '10.1000/abc.123');
  assert.equal(normalizeDoi('doi: 10.5555/Test'), '10.5555/test');
  assert.equal(normalizeSourceUrl(' HTTPS://Example.COM/Paper/#section '), 'https://example.com/Paper');
  assert.equal(normalizeSourceYear('Published 2024'), 2024);
  assert.equal(normalizeSourceYear('not a year'), null);
  assert.equal(normalizeSourceTitle('  A  {Nested}\n Title.  '), 'a nested title');
});

test('reference input distinguishes DOI from ordinary URLs', () => {
  assert.deepEqual(classifyReferenceInput('10.1000/ABC'), { kind: 'doi', value: '10.1000/abc' });
  assert.deepEqual(classifyReferenceInput('https://doi.org/10.1000/ABC'), { kind: 'doi', value: '10.1000/abc' });
  assert.deepEqual(classifyReferenceInput('https://example.com/article#part'), {
    kind: 'url',
    value: 'https://example.com/article',
  });
  assert.throws(() => classifyReferenceInput('not a reference'), /DOI 或 URL/);
});

test('BibTeX import parses multiple entries and preserves stable identifiers', () => {
  const records = parseBibTeX(`
@article{smith2024nested,
  title = {A {Nested} Title},
  author = {Smith, Jane and Doe, John},
  year = {2024},
  doi = {https://doi.org/10.1000/ABC},
  journal = {Journal of Tests}
}

@book{lee2021book,
  title = {Research Practice},
  author = {Lee, Ada},
  year = {2021},
  publisher = {Example Press}
}
`);

  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'bibtex');
  assert.equal(records[0].title, 'A Nested Title');
  assert.deepEqual(records[0].authors, ['Jane Smith', 'John Doe']);
  assert.equal(records[0].year, 2024);
  assert.equal(records[0].doi, '10.1000/abc');
  assert.equal(records[0].stableIdentifier, 'doi:10.1000/abc');
  assert.equal(records[1].stableIdentifier, null);
});

test('RIS import parses journal metadata and DOI', () => {
  const records = parseRis(`
TY  - JOUR
TI  - A reproducible trial
AU  - Smith, Jane
AU  - Doe, John
PY  - 2023
DO  - 10.1000/TRIAL
JO  - Journal of Reproducibility
ER  -
`);

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'ris');
  assert.equal(records[0].title, 'A reproducible trial');
  assert.deepEqual(records[0].authors, ['Jane Smith', 'John Doe']);
  assert.equal(records[0].year, 2023);
  assert.equal(records[0].venue, 'Journal of Reproducibility');
  assert.equal(records[0].doi, '10.1000/trial');
  assert.deepEqual(records[0].metadata, { entryType: 'JOUR' });
});

test('Markdown and TeX sources derive title and year metadata', () => {
  const markdown = parseMarkdownSource('---\ntitle: Field Notes\nyear: 2022\n---\n# Ignored heading\n');
  assert.equal(markdown.title, 'Field Notes');
  assert.equal(markdown.year, 2022);

  const tex = parseTexSource('\\title{A TeX Study}\n\\author{Ada Lee \\and Jane Smith}\n\\date{2020}\n');
  assert.equal(tex.title, 'A TeX Study');
  assert.deepEqual(tex.authors, ['Ada Lee', 'Jane Smith']);
  assert.equal(tex.year, 2020);
});

test('duplicate matching uses stable identifiers before normalized title and year', () => {
  const existing = [{
    id: 'source-1',
    title: 'A Reproducible Trial',
    year: 2023,
    doi: '10.1000/trial',
    url: null,
    stableIdentifier: 'doi:10.1000/trial',
  }];

  assert.equal(findDuplicateSource({
    title: 'Different title',
    year: 2023,
    doi: 'https://doi.org/10.1000/TRIAL',
    url: null,
    stableIdentifier: null,
  }, existing)?.id, 'source-1');

  assert.equal(findDuplicateSource({
    title: ' a reproducible   trial ',
    year: 2023,
    doi: null,
    url: null,
    stableIdentifier: null,
  }, existing)?.id, 'source-1');

  assert.equal(findDuplicateSource({
    title: 'A Reproducible Trial',
    year: 2024,
    doi: null,
    url: null,
    stableIdentifier: null,
  }, existing), null);
});

test('BibTeX citation keys are not stable identifiers across records', () => {
  const records = parseBibTeX(`
@article{same,
  title = {Alpha Study},
  year = {2020}
}

@article{same,
  title = {Beta Study},
  year = {2021}
}
`);

  assert.equal(records.length, 2);
  assert.equal(records[0].stableIdentifier, null);
  assert.equal(records[1].stableIdentifier, null);
  assert.equal(findDuplicateSource(records[1], [records[0]]), null);
});

test('different stable identifiers are not collapsed by matching title and year', () => {
  const existing = [{
    id: 'source-alpha',
    title: 'Same Display Title',
    year: 2024,
    doi: '10.1000/alpha',
    stableIdentifier: 'doi:10.1000/alpha',
  }];

  assert.equal(findDuplicateSource({
    title: 'Same Display Title',
    year: 2024,
    doi: '10.1000/beta',
    stableIdentifier: 'doi:10.1000/beta',
  }, existing), null);
});