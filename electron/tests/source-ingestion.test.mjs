import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(records[3].bibtex, /@article\{smith2024/);
  assert.equal(records[3].cslJson.title, 'Trial One');
  assert.deepEqual(records[3].cslJson.issued['date-parts'], [[2024]]);
  assert.equal(records[4].title, 'Trial Two');
  assert.equal(records[4].cslJson.title, 'Trial Two');
  for (const record of records) {
    assert.equal(typeof record.bibtex, 'string');
    assert.match(record.bibtex, /^@/);
  }

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
  const fetchImpl = async (url) => new Response(
    url.includes('doi.org') ? 'retrieved DOI content' : 'retrieved URL content',
    { status: 200, headers: { 'content-type': 'text/plain' } },
  );
  const doi = await ingestReference({
    workspacePath: workspace,
    reference: 'https://doi.org/10.1000/ABC',
    fetchImpl,
    now: () => '2026-11-19T12:00:00.000Z',
    idFactory: () => 'doi-source',
  });
  const url = await ingestReference({
    workspacePath: workspace,
    reference: 'https://example.com/paper#results',
    title: 'Public paper landing page',
    year: 2025,
    fetchImpl,
    now: () => '2026-11-19T12:01:00.000Z',
    idFactory: () => 'url-source',
  });

  assert.equal(doi.kind, 'doi');
  assert.equal(doi.doi, '10.1000/abc');
  assert.equal(doi.stableIdentifier, 'doi:10.1000/abc');
  assert.equal(url.kind, 'url');
  assert.equal(url.url, 'https://example.com/paper');
  assert.equal(url.title, 'Public paper landing page');
  assert.equal(doi.contentHash, createHash('sha256').update('retrieved DOI content').digest('hex'));
  assert.equal(url.contentHash, createHash('sha256').update('retrieved URL content').digest('hex'));

  for (const record of [doi, url]) {
    assert.equal(record.metadata.contentHashBasis, 'retrieved-content');
    assert.equal(record.metadata.fetchStatus, 'retrieved');
    const absolute = path.join(workspace, record.localLocator.split('#')[0]);
    assert.ok(readFileSync(absolute).length > 0);
  }
});

test('a failed batch import removes files copied by earlier entries', async (t) => {
  const workspace = temporaryWorkspace(t);
  const inputDir = path.join(workspace, 'inputs');
  mkdirSync(inputDir, { recursive: true });
  const markdown = path.join(inputDir, 'valid.md');
  const brokenBib = path.join(inputDir, 'broken.bib');
  writeFileSync(markdown, '# Valid source\nEvidence.', 'utf8');
  writeFileSync(brokenBib, '@article{broken, title={Unclosed', 'utf8');

  await assert.rejects(() => ingestSourceFiles({
    workspacePath: workspace,
    filePaths: [markdown, brokenBib],
  }), /括号未闭合/);

  const sourceDirectory = path.join(workspace, '.science', 'sources');
  assert.deepEqual(readdirSync(sourceDirectory), []);
});

test('DOI and URL imports hash and preserve fetched source content', async (t) => {
  const workspace = temporaryWorkspace(t);
  const fetchedBytes = Buffer.from('<html><body>retrieved evidence</body></html>', 'utf8');
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return new Response(fetchedBytes, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const record = await ingestReference({
    workspacePath: workspace,
    reference: 'https://example.com/paper',
    fetchImpl,
    now: () => '2026-11-20T01:00:00.000Z',
    idFactory: () => 'fetched-source',
  });

  assert.deepEqual(requested, ['https://example.com/paper']);
  assert.equal(record.contentHash, createHash('sha256').update(fetchedBytes).digest('hex'));
  assert.equal(record.metadata.contentHashBasis, 'retrieved-content');
  assert.ok(record.localLocator.endsWith('.html'));
  assert.deepEqual(readFileSync(path.join(workspace, record.localLocator)), fetchedBytes);
});

test('reference import does not register metadata when source content cannot be retrieved', async (t) => {
  const workspace = temporaryWorkspace(t);
  const fetchImpl = async () => new Response('missing', { status: 404 });

  await assert.rejects(() => ingestReference({
    workspacePath: workspace,
    reference: 'https://example.com/missing',
    fetchImpl,
  }), /无法获取 DOI\/URL 内容/);

  const sourceDirectory = path.join(workspace, '.science', 'sources');
  assert.equal(existsSync(sourceDirectory), false);
});
