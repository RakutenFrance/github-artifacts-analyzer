import assert from 'node:assert/strict';
import test from 'node:test';

import { runPackagesAnalysis } from '../dist/index.js';

test('returns the packages analysis result when it succeeds', async () => {
  const packagesAnalyzer = { analyzePackages: async () => ({ summary: { totalPackages: 3 } }) };

  const result = await runPackagesAnalysis(packagesAnalyzer, 'my-org');

  assert.deepEqual(result, { summary: { totalPackages: 3 } });
});

test('returns a valid empty analysis instead of throwing when the packages analysis fails unexpectedly', async () => {
  const packagesAnalyzer = { analyzePackages: async () => { throw new Error('boom'); } };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));

  let result;
  try {
    result = await runPackagesAnalysis(packagesAnalyzer, 'my-org');
  } finally {
    console.error = originalError;
  }

  assert.equal(result.packages.length, 0);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /boom/);
  assert.ok(logged.some(line => line.includes('Packages analysis failed') && line.includes('boom')));
});
