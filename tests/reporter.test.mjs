import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ReportGenerator } from '../dist/reporter.js';

function captureLog(fn) {
  return async () => {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));

    try {
      await fn(logged);
    } finally {
      console.log = originalLog;
    }
  };
}

// loadConfig() reads relative to process.cwd() - run inside a temp directory
// with no config.json so every test here exercises the default 50GB/2GB quotas.
function withTempCwd(fn) {
  return async (...args) => {
    const directory = mkdtempSync(join(tmpdir(), 'reporter-test-'));
    const originalCwd = process.cwd();
    process.chdir(directory);

    try {
      await fn(...args);
    } finally {
      process.chdir(originalCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function analysisFixture(overrides = {}) {
  return {
    incomplete: false,
    organizationName: 'my-org',
    summary: {
      totalArtifacts: 100,
      totalSizeBytes: 1024 * 1024 * 1024, // 1 GB
    },
    repositories: [],
    ...overrides,
  };
}

function packagesAnalysisFixture(overrides = {}) {
  return {
    incomplete: false,
    warnings: [],
    packages: [],
    summary: {
      totalPackages: 0,
      totalSizeBytes: 0,
      packagesWithUnknownSize: 0,
      byPackageType: {
        npm: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: true },
        maven: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
        rubygems: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
        nuget: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
        docker: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
        container: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: true },
      },
      ...overrides.summary,
    },
    ...overrides,
    packages: overrides.packages ?? [],
  };
}

test('storage overview shows a % of quota bar for the default quota, using the default org quota', withTempCwd(captureLog(async (logged) => {
  const reporter = new ReportGenerator();

  reporter.generateStorageOverview(
    analysisFixture({ summary: { totalArtifacts: 100, totalSizeBytes: 25 * 1024 * 1024 * 1024 } }), // 25 GB
    packagesAnalysisFixture()
  );

  const output = logged.join('\n');
  assert.match(output, /% of 50 GB quota/);
  assert.match(output, /50%/); // 25 GB of a 50 GB default org quota
})));

test('excludes container storage from the quota bar and the quota-counted total', withTempCwd(captureLog(async (logged) => {
  const reporter = new ReportGenerator();

  reporter.generateStorageOverview(
    analysisFixture({ summary: { totalArtifacts: 0, totalSizeBytes: 0 } }),
    packagesAnalysisFixture({
      summary: {
        totalPackages: 51,
        totalSizeBytes: 20 * 1024 * 1024 * 1024, // 20 GB, all container
        packagesWithUnknownSize: 0,
        byPackageType: {
          npm: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: true },
          maven: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          rubygems: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          nuget: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          docker: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          container: { packageCount: 51, versionCount: 3243, sizeBytes: 20 * 1024 * 1024 * 1024, sizeKnown: true, sizeEstimated: true },
        },
      },
    })
  );

  const output = logged.join('\n');
  assert.match(output, /excluded - GHCR is unmetered/);
  // Quota-counted total is 0 bytes (container is the only storage, and it's excluded) - 0%.
  assert.match(output, /Total \(counts toward quota\)[^\n]*0%/);
})));

test('storage overview collapses package types with no size mechanism into one "other" row', withTempCwd(captureLog(async (logged) => {
  const reporter = new ReportGenerator();

  reporter.generateStorageOverview(
    analysisFixture(),
    packagesAnalysisFixture({
      summary: {
        totalPackages: 5,
        totalSizeBytes: 0,
        packagesWithUnknownSize: 5,
        byPackageType: {
          npm: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: true },
          maven: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          rubygems: { packageCount: 2, versionCount: 10, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          nuget: { packageCount: 1, versionCount: 3, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          docker: { packageCount: 2, versionCount: 7, sizeBytes: 0, sizeKnown: false, sizeEstimated: false },
          container: { packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false, sizeEstimated: true },
        },
      },
    })
  );

  const output = logged.join('\n');
  // maven has neither sizeKnown nor sizeEstimated set here (its fetch never
  // ran - no maven packages exist), so it collapses into the "other" row
  // alongside rubygems/nuget/docker, none of which have a size mechanism at all.
  assert.match(output, /Packages: maven\/rubygems\/nuget\/docker/);
  assert.doesNotMatch(output, /Packages: rubygems[^/]/); // never its own row
})));

test('top packages report ranks by storage size, not version count, and excludes unknown-size packages', captureLog(async (logged) => {
  const reporter = new ReportGenerator();

  reporter.generateTopPackagesReport({
    packages: [
      { name: 'small-but-many-versions', packageType: 'npm', repositoryFullName: 'org/a', versions: Array(500).fill({}), sizeBytes: 1024, sizeEstimated: true },
      { name: 'big-package', packageType: 'maven', repositoryFullName: 'org/b', versions: [{}], sizeBytes: 5 * 1024 * 1024 * 1024, sizeEstimated: false },
      { name: 'unknown-size', packageType: 'nuget', repositoryFullName: 'org/c', versions: Array(1000).fill({}), sizeBytes: null, sizeEstimated: false },
    ],
  });

  const output = logged.join('\n');
  const bigIndex = output.indexOf('big-package');
  const smallIndex = output.indexOf('small-but-many-versions');

  assert.ok(bigIndex !== -1 && smallIndex !== -1 && bigIndex < smallIndex); // bigger size ranks first
  assert.doesNotMatch(output, /unknown-size/); // no size at all - excluded from the ranking
}));
