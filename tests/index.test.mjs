import assert from 'node:assert/strict';
import test from 'node:test';

import { runPackagesAnalysis } from '../dist/index.js';

test('returns the packages analysis result when it succeeds', async () => {
  const packagesAnalyzer = { analyzePackages: async () => ({ summary: { totalPackages: 3 } }) };

  const result = await runPackagesAnalysis(packagesAnalyzer, 'my-org');

  assert.deepEqual(result, { summary: { totalPackages: 3 } });
});

test('returns null instead of throwing when the packages analysis fails unexpectedly', async () => {
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

  assert.equal(result, null);
  assert.ok(logged.some(line => line.includes('Packages analysis failed') && line.includes('boom')));
});
