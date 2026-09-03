import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubPackagesAnalyzer, PACKAGE_TYPES, VERSION_COLLECTION_CONCURRENCY } from '../dist/packages-analyzer.js';

// listPackagesForOrganization/listPackagesForUser require a package_type
// filter and don't accept "all" - the analyzer loops over every known
// PACKAGE_TYPES value. Fixtures mock one method that returns pages keyed by
// the requested package_type, terminating on an empty array.
function paginateIteratorShim(method, parameters) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          const response = await method(parameters);
          if (!response?.data || response.data.length === 0) {
            done = true;
            return { done: true, value: undefined };
          }
          return { done: false, value: response };
        }
      };
    }
  };
}

function createPackagesAnalyzer(octokit, options = {}) {
  const analyzer = new GitHubPackagesAnalyzer('test-token', options);
  analyzer.octokit = {
    ...octokit,
    paginate: { iterator: paginateIteratorShim }
  };
  return analyzer;
}

// Builds a listPackagesForOrganization mock that returns one page of
// packages for `packageType` and an empty page for every other type.
function packagesFixture(packageType, packages) {
  let page = 0;
  return async ({ package_type }) => {
    if (package_type !== packageType) return { data: [] };
    return { data: page++ === 0 ? packages : [] };
  };
}

// estimateNpmPackageSize makes two kinds of real fetch() calls: one GET to
// npm.pkg.github.com for the registry metadata document, then one GET
// (redirect: manual) + one HEAD per sampled version's tarball. Stubs
// globalThis.fetch for the duration of the test and restores it afterward.
function withMockedNpmFetch(versionSizes, fn) {
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

test('lists packages across every package type and paginates their versions', withMockedNpmFetch({ '1.0.0': 1000 }, async () => {
  let versionsPage = 0;
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('npm', [
        {
          name: 'gtm-provider', visibility: 'private',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        },
      ]),
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({
        data: versionsPage++ === 0
          ? [{ id: 1, name: '1.0.0', created_at: '2026-01-01T00:00:00Z' }]
          : [],
      }),
    },
  });

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.equal(result.summary.totalPackages, 1);
  assert.equal(result.summary.totalVersions, 1);
  assert.equal(result.packages[0].name, 'gtm-provider');
  assert.equal(result.packages[0].packageType, 'npm');
  assert.equal(result.packages[0].sizeBytes, 1000); // estimated from its one sampled version
  assert.equal(result.packages[0].sizeEstimated, true);
}));

test('reports every known package_type value, not just the ones with data', async () => {
  const seenTypes = [];
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: async ({ package_type }) => {
        seenTypes.push(package_type);
        return { data: [] };
      },
    },
  });

  await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.deepEqual(seenTypes, PACKAGE_TYPES);
});

test('sums real Maven byte sizes via GraphQL and leaves other types unknown', async () => {
  let versionsPage = 0;
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('maven', [
        {
          name: 'com.rakuten.library', visibility: 'private',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        },
      ]),
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({
        data: versionsPage++ === 0
          ? [{ id: 1, name: '1.0.0', created_at: '2026-01-01T00:00:00Z' }]
          : [],
      }),
    },
  });

  analyzer.octokit.graphql = async () => ({
    repositoryOwner: {
      packages: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            name: 'com.rakuten.library',
            versions: { nodes: [{ files: { nodes: [{ size: 100 }, { size: 200 }] } }] },
          },
        ],
      },
    },
  });

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.equal(result.packages[0].sizeBytes, 300);
  assert.equal(result.summary.totalSizeBytes, 300);
  assert.equal(result.summary.byPackageType.maven.sizeKnown, true);
  assert.equal(result.summary.byPackageType.npm.sizeKnown, false);
});

test('reports Maven size as unknown, not a false 0 B, when the GraphQL size fetch fails', async () => {
  let versionsPage = 0;
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('maven', [
        {
          name: 'com.rakuten.library', visibility: 'private',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        },
      ]),
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({
        data: versionsPage++ === 0
          ? [{ id: 1, name: '1.0.0', created_at: '2026-01-01T00:00:00Z' }]
          : [],
      }),
    },
  });

  analyzer.octokit.graphql = async () => { throw new Error('GraphQL resource limit exceeded'); };

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.equal(result.packages[0].sizeBytes, null);
  assert.equal(result.summary.byPackageType.maven.sizeKnown, false);
  assert.equal(result.summary.byPackageType.maven.sizeBytes, 0);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Fetching Maven package sizes/);
});

test('does not let a Maven package leak its size onto a same-named package of a different type', async () => {
  const packagesListedPerType = new Set();
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: async ({ package_type }) => {
        if (package_type !== 'npm' && package_type !== 'maven') return { data: [] };
        if (packagesListedPerType.has(package_type)) return { data: [] };
        packagesListedPerType.add(package_type);
        return {
          data: [{
            name: 'shared-utils', visibility: 'private',
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
          }],
        };
      },
      // Every package's version pagination immediately returns empty -
      // irrelevant to this test, which only checks size-key isolation.
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({ data: [] }),
    },
  });

  analyzer.octokit.graphql = async () => ({
    repositoryOwner: {
      packages: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            name: 'shared-utils',
            versions: { nodes: [{ files: { nodes: [{ size: 500 }] } }] },
          },
        ],
      },
    },
  });

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  const npmPkg = result.packages.find(p => p.packageType === 'npm');
  const mavenPkg = result.packages.find(p => p.packageType === 'maven');

  assert.equal(mavenPkg.sizeBytes, 500);
  assert.equal(npmPkg.sizeBytes, null); // must stay unknown, not inherit maven's 500
});

test('tracks a package-type listing failure as a warning instead of aborting the scan', async () => {
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: async ({ package_type }) => {
        if (package_type === 'maven') {
          throw Object.assign(new Error('Forbidden'), { status: 403 });
        }
        return { data: [] };
      },
    },
  });

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Forbidden/);
  assert.equal(result.summary.totalPackages, 0);
});

test('surfaces container version tags for later cleanup-marker detection', async () => {
  let versionsPage = 0;
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('container', [
        {
          name: 'microservice-app', visibility: 'private',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        },
      ]),
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({
        data: versionsPage++ === 0
          ? [{
            id: 1, name: 'sha256:abc', created_at: '2026-01-01T00:00:00Z',
            metadata: { container: { tags: ['0.0.1-SNAPSHOT'] } },
          }]
          : [],
      }),
    },
  });

  const result = await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.deepEqual(result.packages[0].versions[0].tags, ['0.0.1-SNAPSHOT']);
});

test('bounds concurrent package version collection to the configured limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const packages = Array.from({ length: 20 }, (_, i) => ({
    name: `pkg-${i}`, visibility: 'private',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  }));

  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('npm', packages),
      getAllPackageVersionsForPackageOwnedByOrg: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 10));
        inFlight--;
        return { data: [] };
      },
    },
  });

  await analyzer.analyzePackages('my-org', { isOrg: true });

  assert.ok(maxInFlight <= VERSION_COLLECTION_CONCURRENCY);
  assert.ok(maxInFlight > 1); // proves version collection actually ran concurrently, not serially
});

// The sampling math (sampleSizeFor/pickItemsToSample) and the npm HTTP
// mechanics (redirect-chasing, HEAD requests) are unit-tested independently
// in tests/sampling.test.mjs and tests/npm-registry-client.test.mjs. These
// two tests only verify that analyzePackages wires an npm package's real
// version list into that estimator and applies its result correctly.
test('estimates npm package size from a sample of real tarball sizes, extrapolated to every version', withMockedNpmFetch(
  { '3.0.0': 1000, '2.0.0': 2000, '1.0.0': 3000 },
  async () => {
    let versionsPage = 0;
    const analyzer = createPackagesAnalyzer({
      packages: {
        listPackagesForOrganization: packagesFixture('npm', [
          {
            name: 'gtm-provider', visibility: 'private',
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
          },
        ]),
        getAllPackageVersionsForPackageOwnedByOrg: async () => ({
          data: versionsPage++ === 0
            ? [
              { id: 3, name: '3.0.0', created_at: '2026-03-01T00:00:00Z' },
              { id: 2, name: '2.0.0', created_at: '2026-02-01T00:00:00Z' },
              { id: 1, name: '1.0.0', created_at: '2026-01-01T00:00:00Z' },
            ]
            : [],
        }),
      },
    });

    const result = await analyzer.analyzePackages('my-org', { isOrg: true });

    // 3 versions is at the sample-everything threshold, so all 3 are sampled:
    // average(1000, 2000, 3000) * 3 versions = 6000.
    assert.equal(result.packages[0].sizeBytes, 6000);
    assert.equal(result.packages[0].sizeEstimated, true);
    assert.equal(result.packages[0].sampleCount, 3);
    assert.equal(result.summary.byPackageType.npm.sizeKnown, true);
    assert.equal(result.summary.byPackageType.npm.sizeEstimated, true);
  }
));

test('reports npm size as unknown when every sampled tarball lookup fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unreachable'); };

  let versionsPage = 0;
  const analyzer = createPackagesAnalyzer({
    packages: {
      listPackagesForOrganization: packagesFixture('npm', [
        {
          name: 'gtm-provider', visibility: 'private',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        },
      ]),
      getAllPackageVersionsForPackageOwnedByOrg: async () => ({
        data: versionsPage++ === 0
          ? [{ id: 1, name: '1.0.0', created_at: '2026-01-01T00:00:00Z' }]
          : [],
      }),
    },
  });

  let result;
  try {
    result = await analyzer.analyzePackages('my-org', { isOrg: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.packages[0].sizeBytes, null);
  assert.equal(result.summary.byPackageType.npm.sizeKnown, false);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings.join('; '), /Estimating size for npm package/);
});
