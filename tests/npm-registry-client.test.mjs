import assert from 'node:assert/strict';
import test from 'node:test';

import { estimatePackageSize } from '../dist/npm-registry-client.js';

// estimatePackageSize makes two kinds of real fetch() calls: one GET to
// npm.pkg.github.com for the registry metadata document, then one GET
// (redirect: manual) + one HEAD per sampled version's tarball. Stubs
// globalThis.fetch for the duration of the test and restores it afterward.
function withMockedFetch(versionSizes, fn) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (typeof url === 'string' && url.startsWith('https://npm.pkg.github.com/@') && !init.method) {
        const versions = Object.fromEntries(
          Object.keys(versionSizes).map(name => [name, { dist: { tarball: `https://npm.pkg.github.com/download/x/${name}` } }])
        );
        return new Response(JSON.stringify({ versions }), { status: 200 });
      }
      if (init.redirect === 'manual') {
        const version = url.split('/').pop();
        return new Response(null, { status: 302, headers: { location: `https://blob.example.com/${version}` } });
      }
      if (init.method === 'HEAD') {
        const version = url.split('/').pop();
        const size = versionSizes[version];
        if (size === undefined) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { 'content-length': String(size) } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test('returns null for a package with no versions', async () => {
  const result = await estimatePackageSize('token', 'my-org', 'gtm-provider', []);

  assert.equal(result, null);
});

test('estimates package size from a sample of real tarball sizes, extrapolated to every version', withMockedFetch(
  { '3.0.0': 1000, '2.0.0': 2000, '1.0.0': 3000 },
  async () => {
    const versions = [
      { name: '3.0.0' },
      { name: '2.0.0' },
      { name: '1.0.0' },
    ];

    const result = await estimatePackageSize('token', 'my-org', 'gtm-provider', versions);

    // 3 versions is at the sample-everything threshold, so all 3 are sampled:
    // average(1000, 2000, 3000) * 3 versions = 6000.
    assert.equal(result.estimatedTotalBytes, 6000);
    assert.equal(result.sampleCount, 3);
  }
));

test('returns null when every sampled tarball lookup fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('https://npm.pkg.github.com/@') && !init.method) {
      return new Response(JSON.stringify({
        versions: { '1.0.0': { dist: { tarball: 'https://npm.pkg.github.com/download/x/1.0.0' } } }
      }), { status: 200 });
    }
    throw new Error('network unreachable');
  };

  let result;
  try {
    result = await estimatePackageSize('token', 'my-org', 'gtm-provider', [{ name: '1.0.0' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result, null);
});

test('throws when the registry metadata document itself cannot be fetched', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });

  try {
    await assert.rejects(
      () => estimatePackageSize('token', 'my-org', 'gtm-provider', [{ name: '1.0.0' }]),
      /HTTP 404/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('skips a sampled version with no tarball URL in the registry response', withMockedFetch(
  { '1.0.0': 1000 },
  async () => {
    const versions = [{ name: '1.0.0' }, { name: 'missing-from-registry' }];

    const result = await estimatePackageSize('token', 'my-org', 'gtm-provider', versions);

    assert.equal(result.sampleCount, 1);
    assert.equal(result.estimatedTotalBytes, 2000); // 1000 average * 2 versions
  }
));
