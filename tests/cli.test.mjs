import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runCli(...args) {
  return spawnSync(process.execPath, ['dist/index.js', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  });
}

test('prints help when launched as an executable module', () => {
  const result = runCli('--help');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: github-artifacts/);
  assert.match(result.stdout, /analyze/);
  assert.match(result.stdout, /repo/);
});

test('prints the CLI version', () => {
  const result = runCli('--version');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.0.0');
});

test('rejects a non-numeric --min-size before making any API calls', () => {
  const result = runCli('analyze', '--token', 'x', '--min-size', 'abc');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--min-size.*non-negative integer/);
});

test('rejects a negative --top before making any API calls', () => {
  const result = runCli('analyze', '--token', 'x', '--top', '-1');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--top.*non-negative integer/);
});

test('rejects invalid --min-size and --top on analyze-org too', () => {
  const minSizeResult = runCli('analyze-org', 'my-org', '--token', 'x', '--min-size', 'abc');
  assert.notEqual(minSizeResult.status, 0);
  assert.match(minSizeResult.stderr, /--min-size.*non-negative integer/);

  const topResult = runCli('analyze-org', 'my-org', '--token', 'x', '--top', '-1');
  assert.notEqual(topResult.status, 0);
  assert.match(topResult.stderr, /--top.*non-negative integer/);
});
