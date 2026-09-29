import assert from 'node:assert/strict';
import test from 'node:test';

import { estimatePackageSize } from '../dist/container-registry-client.js';

// estimatePackageSize makes two kinds of real fetch() calls: one GET to
// ghcr.io/token to mint a bearer token (reused across every sampled
// version), then one GET per sampled version's manifest, addressed
// directly by digest. Stubs globalThis.fetch for the duration of the test
// and restores it afterward.
function withMockedFetch(manifestsByDigest, fn) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (typeof url === 'string' && url.startsWith('https://ghcr.io/token')) {
        return new Response(JSON.stringify({ token: 'ghcr-token' }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/manifests/')) {
        const digest = url.split('/manifests/').pop();
        const manifest = manifestsByDigest[digest];
        if (!manifest) return new Response(null, { status: 404 });
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    };

    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test('returns null for a package with no versions', async () => {
  const result = await estimatePackageSize('token', 'my-org', 'microservice-app', []);

  assert.equal(result, null);
});

test('estimates package size from a sample of real manifest sizes, extrapolated to every version', withMockedFetch(
  {
    'sha256:aaa': { config: { size: 100 }, layers: [{ size: 900 }] }, // total 1000
    'sha256:bbb': { config: { size: 200 }, layers: [{ size: 1800 }] }, // total 2000
    'sha256:ccc': { config: { size: 300 }, layers: [{ size: 2700 }] }, // total 3000
  },
  async () => {
    const versions = [
      { name: 'sha256:aaa' },
      { name: 'sha256:bbb' },
      { name: 'sha256:ccc' },
    ];

    const result = await estimatePackageSize('token', 'my-org', 'microservice-app', versions);

    // 3 versions is at the sample-everything threshold, so all 3 are sampled:
    // average(1000, 2000, 3000) * 3 versions = 6000.
    assert.equal(result.estimatedTotalBytes, 6000);
    assert.equal(result.sampleCount, 3);
  }
));

test('falls back to summing the index-level sizes for a multi-arch manifest list', withMockedFetch(
  {
    'sha256:index': {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ size: 2755 }, { size: 566 }]
    }
  },
  async () => {
    const result = await estimatePackageSize('token', 'my-org', 'pmdeploy_master', [{ name: 'sha256:index' }]);

    // Sub-manifest fetching isn't reliable for attestation manifests on GHCR
    // (confirmed against a real multi-arch image), so this sums the index's
    // own listed sizes as an under-counted but non-zero estimate.
    assert.equal(result.estimatedTotalBytes, 2755 + 566);
    assert.equal(result.sampleCount, 1);
  }
));

test('returns null when every sampled manifest lookup fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.startsWith('https://ghcr.io/token')) {
      return new Response(JSON.stringify({ token: 'ghcr-token' }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  let result;
  try {
    result = await estimatePackageSize('token', 'my-org', 'microservice-app', [{ name: 'sha256:missing' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result, null);
});

test('throws when the ghcr.io token itself cannot be fetched', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('forbidden', { status: 403 });

  try {
    await assert.rejects(
      () => estimatePackageSize('token', 'my-org', 'microservice-app', [{ name: 'sha256:aaa' }]),
      /HTTP 403/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
