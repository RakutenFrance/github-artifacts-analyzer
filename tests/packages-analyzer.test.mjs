import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubPackagesAnalyzer, PACKAGE_TYPES } from '../dist/packages-analyzer.js';

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

test('lists packages across every package type and paginates their versions', async () => {
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
  assert.equal(result.packages[0].sizeBytes, null); // npm has no known size
});

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
