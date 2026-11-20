import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifySourceEvidence } from '../source-verification.js';

test('source verification reads the source, resolves the locator, and binds the content hash', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-source-verification-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const sourceDirectory = path.join(workspace, '.science', 'sources');
  mkdirSync(sourceDirectory, { recursive: true });
  const relativeLocator = '.science/sources/paper.md';
  const sourcePath = path.join(workspace, relativeLocator);
  const content = '# Paper\n\nThe intervention reduced the measured error.\n';
  writeFileSync(sourcePath, content, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');

  const verification = await verifySourceEvidence({
    workspacePath: workspace,
    source: { localLocator: relativeLocator, observedContentHash: contentHash },
    locator: 'line:3',
    quote: 'intervention reduced the measured error',
    claim: 'The intervention reduced measurement error in this source.',
  });

  assert.equal(verification.contentHash, contentHash);
  assert.equal(verification.locator, 'line:3');
  assert.equal(verification.quote, 'intervention reduced the measured error');
});

test('source verification rejects a quote outside the resolved locator', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-source-verification-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, '.science', 'sources'), { recursive: true });
  const relativeLocator = '.science/sources/paper.md';
  const content = '# Paper\n\nThe intervention reduced measurement error.\n';
  writeFileSync(path.join(workspace, relativeLocator), content, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');

  await assert.rejects(
    verifySourceEvidence({
      workspacePath: workspace,
      source: { localLocator: relativeLocator, observedContentHash: contentHash },
      locator: 'line:1',
      quote: 'intervention reduced measurement error',
      claim: 'The intervention reduced measurement error.',
    }),
    /短引文/,
  );
});

test('source verification refuses content that no longer matches the recorded hash', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-source-verification-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, '.science', 'sources'), { recursive: true });
  const relativeLocator = '.science/sources/paper.md';
  const original = '# Paper\n\nOriginal evidence.\n';
  writeFileSync(path.join(workspace, relativeLocator), original, 'utf8');
  const contentHash = createHash('sha256').update(original).digest('hex');
  writeFileSync(path.join(workspace, relativeLocator), '# Paper\n\nReplacement evidence.\n', 'utf8');

  await assert.rejects(
    verifySourceEvidence({
      workspacePath: workspace,
      source: { localLocator: relativeLocator, observedContentHash: contentHash },
      locator: 'line:3',
      quote: 'Replacement evidence',
      claim: 'The replacement evidence supports the claim.',
    }),
    /内容已变化/,
  );
});

test('source verification resolves PDF page locators against extracted page text', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-source-verification-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, '.science', 'sources'), { recursive: true });
  const relativeLocator = '.science/sources/paper.pdf';
  const pdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length 60 >> stream
BT (The intervention reduced measurement error.) Tj ET
endstream
endobj
`, 'latin1');
  writeFileSync(path.join(workspace, relativeLocator), pdf);
  const contentHash = createHash('sha256').update(pdf).digest('hex');

  const verification = await verifySourceEvidence({
    workspacePath: workspace,
    source: { kind: 'pdf', localLocator: relativeLocator, observedContentHash: contentHash },
    locator: 'page:1',
    quote: 'intervention reduced measurement error',
    claim: 'The intervention reduced measurement error.',
  });
  assert.equal(verification.locator, 'page:1');
});
