import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestReference, ingestSourceFiles } from '../source-ingestion.js';

function temporaryWorkspace(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('file ingestion creates durable source records for PDF, Markdown, TeX, BibTeX, and RIS', async (t) => {
  const workspace = temporaryWorkspace(t);
  const inputDir = path.join(workspace, 'inputs');
  mkdirSync(inputDir, { recursive: true });

  const files = [
    ['paper.pdf', '%PDF-1.4\n1 0 obj\n<< /Title (A Text PDF) /CreationDate (D:20210101000000) >>\nendobj\n%%EOF'],
    ['notes.md', '# Field Notes\n\nEvidence body.'],
    ['manuscript.tex', '\\title{A TeX Study}\n\\author{Ada Lee}\n\\date{2020}'],
    ['library.bib', '@article{smith2024, title={Trial One}, author={Smith, Jane}, year={2024}, doi={10.1000/one}}'],
    ['library.ris', 'TY  - JOUR\nTI  - Trial Two\nAU  - Doe, John\nPY  - 2023\nER  - \n'],
  ];
  for (const [name, content] of files) writeFileSync(path.join(inputDir, name), content, 'utf8');

  let sequence = 0;
  const records = await ingestSourceFiles({
    workspacePath: workspace,
    filePaths: files.map(([name]) => path.join(inputDir, name)),
    now: () => '2026-11-19T12:00:00.000Z',
    idFactory: () => `source-${++sequence}`,
  });

  assert.deepEqual(records.map((record) => record.kind), ['pdf', 'markdown', 'tex', 'bibtex', 'ris']);
  assert.equal(records[0].title, 'A Text PDF');
  assert.equal(records[0].year, 2021);
  assert.equal(records[1].title, 'Field Notes');
  assert.equal(records[2].title, 'A TeX Study');
  assert.equal(records[3].doi, '10.1000/one');
  assert.equal(records[4].title, 'Trial Two');

  for (const record of records) {
    assert.match(record.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(record.acquiredAt, '2026-11-19T12:00:00.000Z');
    assert.ok(record.localLocator.startsWith('.science/sources/'));
    const absolute = path.join(workspace, record.localLocator.split('#')[0]);
    assert.ok(readFileSync(absolute).length > 0);
  }
});

test('DOI and URL references become hashed local source records', async (t) => {
  const workspace = temporaryWorkspace(t);
  const doi = await ingestReference({
    workspacePath: workspace,
    reference: 'https://doi.org/10.1000/ABC',
    now: () => '2026-11-19T12:00:00.000Z',
    idFactory: () => 'doi-source',
  });
  const url = await ingestReference({
    workspacePath: workspace,
    reference: 'https://example.com/paper#results',
    title: 'Public paper landing page',
    year: 2025,
    now: () => '2026-11-19T12:01:00.000Z',
    idFactory: () => 'url-source',
  });

  assert.equal(doi.kind, 'doi');
  assert.equal(doi.doi, '10.1000/abc');
  assert.equal(doi.stableIdentifier, 'doi:10.1000/abc');
  assert.equal(url.kind, 'url');
  assert.equal(url.url, 'https://example.com/paper');
  assert.equal(url.title, 'Public paper landing page');

  for (const record of [doi, url]) {
    assert.match(record.contentHash, /^[a-f0-9]{64}$/);
    const absolute = path.join(workspace, record.localLocator.split('#')[0]);
    const bytes = readFileSync(absolute);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.contentHash);
  }
});
