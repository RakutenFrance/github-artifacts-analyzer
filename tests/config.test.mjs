import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../dist/config.js';

// loadConfig reads github-artifacts-analyzer.config.json relative to
// process.cwd() - each test runs inside its own temp directory so it never
// touches this repo's real working directory.
function withTempCwd(fn) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'config-test-'));
    const originalCwd = process.cwd();
    process.chdir(directory);

    try {
      await fn(directory);
    } finally {
      process.chdir(originalCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('falls back to default quotas when no config file exists', withTempCwd(async () => {
  const config = loadConfig();

  assert.deepEqual(config.storageQuotaGB, { organization: 50, user: 2 });
}));

test('overrides only the values present in the config file, keeping other defaults', withTempCwd(async (directory) => {
  writeFileSync(
    join(directory, 'github-artifacts-analyzer.config.json'),
    JSON.stringify({ storageQuotaGB: { organization: 100 } })
  );

  const config = loadConfig();

  assert.deepEqual(config.storageQuotaGB, { organization: 100, user: 2 });
}));

test('falls back to defaults and warns instead of throwing on malformed JSON', withTempCwd(async (directory) => {
  writeFileSync(join(directory, 'github-artifacts-analyzer.config.json'), '{ not valid json');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  let config;
  try {
    config = loadConfig();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(config.storageQuotaGB, { organization: 50, user: 2 });
  assert.ok(warnings.some(line => line.includes('github-artifacts-analyzer.config.json')));
}));
