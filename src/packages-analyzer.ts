import pLimit from 'p-limit';
import { GitHubClient } from './github-client.js';

// All package_type values the REST packages API accepts.
export const PACKAGE_TYPES = ['npm', 'maven', 'rubygems', 'nuget', 'docker', 'container'];

// Mirrors artifact-analyzer.ts's PROBE_CONCURRENCY / @octokit/plugin-throttling's
// own global maxConcurrent default.
export const VERSION_COLLECTION_CONCURRENCY = 10;

// GitHub's GraphQL API exposes exact byte sizes (PackageFile.size) only for
// Maven/Debian/PyPI. npm sizes are instead estimated (see sampleSizeFor) via
// HEAD requests against the npm registry's tarball URLs - real but sampled,
// not an exact count. docker/container/nuget/rubygems have no size signal at
// all short of downloading every version's full contents, which doesn't scale.
const PACKAGE_TYPES_WITH_KNOWN_SIZE = { maven: 'MAVEN' };
const PACKAGE_TYPES_WITH_ESTIMATED_SIZE = { npm: true };

// How many of a package's versions to sample when estimating its size (npm).
// log2-scaled so packages with hundreds/thousands of versions don't blow up
// request count, while still sampling more from genuinely large packages.
// Below minSamples, just sample everything - one bad sample skews too much.
const NPM_SIZE_SAMPLE_MIN = 3;
const NPM_SIZE_SAMPLE_MAX = 10;

export function sampleSizeFor(versionCount) {
  if (versionCount <= NPM_SIZE_SAMPLE_MIN) return versionCount;
  return Math.min(NPM_SIZE_SAMPLE_MAX, Math.max(NPM_SIZE_SAMPLE_MIN, Math.ceil(Math.log2(versionCount))));
}

// Picks which versions to sample: always the latest, then a random subset of
// the rest - avoids bias toward only-recent or only-old sizes (e.g. a
// package that ballooned in size after some point in its history).
export function pickVersionsToSample(versions, sampleSize) {
  if (versions.length <= sampleSize) return versions;

  const [latest, ...rest] = versions;
  const shuffled = rest.slice().sort(() => Math.random() - 0.5);
  return [latest, ...shuffled.slice(0, sampleSize - 1)];
}

// A valid, empty analysis result - used whenever there's nothing to report
// (the analysis wasn't run, or it failed outright), so callers always have a
// real object to render instead of needing to branch on null/undefined.
function emptyPackagesAnalysis(warning = null) {
  return {
    packages: [],
    summary: {
      totalPackages: 0,
      totalVersions: 0,
      totalSizeBytes: 0,
      packagesWithUnknownSize: 0,
      byPackageType: PACKAGE_TYPES.reduce((byType, packageType) => {
        byType[packageType] = {
          packageCount: 0, versionCount: 0, sizeBytes: 0, sizeKnown: false,
          sizeEstimated: packageType in PACKAGE_TYPES_WITH_ESTIMATED_SIZE
        };
        return byType;
      }, {})
    },
    incomplete: warning !== null,
    warnings: warning !== null ? [warning] : []
  };
}

class GitHubPackagesAnalyzer extends GitHubClient {
  // Sums real byte sizes for every Maven package via GraphQL's PackageFile.size.
  // Page sizes are kept small (10 packages x 20 versions x 10 files) - a wider
  // query easily exceeds GitHub's GraphQL node-count resource limit for orgs
  // with many versions per package. Returns a Map of "maven:<name>" -> bytes,
  // namespaced by package type so a same-named non-Maven package can never
  // collide with (and silently inherit) a Maven package's size.
  private async fetchMavenPackageSizes(login) {
    const sizeByPackageName = new Map();
    let hasNextPage = true;
    let after = null;

    while (hasNextPage) {
      const response: any = await this.octokit.graphql(
        `query($login: String!, $after: String) {
          repositoryOwner(login: $login) {
            ... on Organization {
              packages(first: 10, after: $after, packageType: MAVEN) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  name
                  versions(first: 20) {
                    nodes {
                      files(first: 10) { nodes { size } }
                    }
                  }
                }
              }
            }
            ... on User {
              packages(first: 10, after: $after, packageType: MAVEN) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  name
                  versions(first: 20) {
                    nodes {
                      files(first: 10) { nodes { size } }
                    }
                  }
                }
              }
            }
          }
        }`,
        { login, after }
      );

      const packages = response.repositoryOwner?.packages;
      if (!packages) break;

      for (const pkg of packages.nodes) {
        const totalSize = pkg.versions.nodes
          .flatMap(v => v.files.nodes)
          .reduce((sum, file) => sum + file.size, 0);
        sizeByPackageName.set(`maven:${pkg.name}`, totalSize);
      }

      hasNextPage = packages.pageInfo.hasNextPage;
      after = packages.pageInfo.endCursor;
    }

    return sizeByPackageName;
  }

  // Reads a sampled version's real tarball size with zero data transfer: one
  // GET to resolve the tarball's redirect location (npm.pkg.github.com does
  // not support HEAD directly), then a HEAD against that final blob URL for
  // Content-Length. Neither request touches the GitHub REST API's rate limit
  // (confirmed: a separate host, no effect on x-ratelimit-remaining).
  private async fetchNpmTarballSize(tarballUrl) {
    const redirectResponse = await fetch(tarballUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${this.token}` }
    });

    const blobUrl = redirectResponse.headers.get('location');
    if (!blobUrl) throw new Error(`No redirect location for ${tarballUrl}`);

    const headResponse = await fetch(blobUrl, { method: 'HEAD' });
    const contentLength = headResponse.headers.get('content-length');
    if (contentLength === null) throw new Error(`No Content-Length for ${blobUrl}`);

    return Number(contentLength);
  }

  // Estimates one npm package's total size from a sample of its versions'
  // real tarball sizes (see sampleSizeFor/pickVersionsToSample), rather than
  // downloading or measuring every version. Returns null if every sampled
  // version's size lookup failed.
  private async estimateNpmPackageSize(login, packageName, versions) {
    if (versions.length === 0) return null;

    const sampleSize = sampleSizeFor(versions.length);
    const sampled = pickVersionsToSample(versions, sampleSize);

    const registryResponse = await fetch(`https://npm.pkg.github.com/@${login}/${packageName}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!registryResponse.ok) {
      throw new Error(`Fetching npm registry metadata: HTTP ${registryResponse.status}`);
    }
    const registryData: any = await registryResponse.json();

    const limit = pLimit(VERSION_COLLECTION_CONCURRENCY);
    const sizes = await Promise.all(sampled.map(version => limit(async () => {
      const tarballUrl = registryData.versions?.[version.name]?.dist?.tarball;
      if (!tarballUrl) return null;
      try {
        return await this.fetchNpmTarballSize(tarballUrl);
      } catch {
        return null;
      }
    })));

    const resolvedSizes = sizes.filter(size => size !== null);
    if (resolvedSizes.length === 0) return null;

    const averageSize = resolvedSizes.reduce((sum, size) => sum + size, 0) / resolvedSizes.length;
    return {
      estimatedTotalBytes: Math.round(averageSize * versions.length),
      sampleCount: resolvedSizes.length
    };
  }

  // Paginates every version of one package to surface per-version tags/dates -
  // useful later for spotting SNAPSHOT/beta/stale versions to clean up.
  private async collectPackageVersions(login, packageType, packageName, isOrg) {
    const versions = [];
    const listVersions: any = isOrg
      ? this.octokit.packages.getAllPackageVersionsForPackageOwnedByOrg
      : this.octokit.packages.getAllPackageVersionsForPackageOwnedByUser;
    const ownerParam = isOrg ? { org: login } : { username: login };

    for await (const { data: page } of this.octokit.paginate.iterator(
      listVersions,
      { ...ownerParam, package_type: packageType, package_name: packageName, per_page: 100 }
    )) {
      for (const version of page) {
        versions.push({
          id: version.id,
          name: version.name,
          createdAt: new Date(version.created_at),
          tags: version.metadata?.container?.tags ?? []
        });
      }
    }

    return versions;
  }

  // Pass 1: list every package of every type for the org/user, with no
  // per-package API calls yet - version_count isn't reliably present across
  // package types (container packages omit it entirely), so counts always
  // come from the real per-version pagination below, not this listing.
  private async listPackages(login, isOrg) {
    const packages = [];
    const warnings = [];
    const listPackages: any = isOrg
      ? this.octokit.packages.listPackagesForOrganization
      : this.octokit.packages.listPackagesForUser;
    const ownerParam = isOrg ? { org: login } : { username: login };

    for (const packageType of PACKAGE_TYPES) {
      try {
        for await (const { data: page } of this.octokit.paginate.iterator(
          listPackages,
          { ...ownerParam, package_type: packageType, per_page: 100 }
        )) {
          packages.push(...page.map(pkg => ({
            name: pkg.name,
            packageType,
            visibility: pkg.visibility,
            repositoryFullName: pkg.repository?.full_name ?? null,
            createdAt: new Date(pkg.created_at),
            updatedAt: new Date(pkg.updated_at)
          })));
        }
      } catch (error) {
        warnings.push(`Listing ${packageType} packages: ${this.describeError(error)}`);
      }

      this.onProgress(`Fetching packages for ${login}... (${packages.length} found)`);
    }

    return { packages, warnings };
  }

  // Lists every package of every type for the org/user, with per-version
  // metadata and, where GitHub exposes it (Maven only), real byte sizes.
  async analyzePackages(login, { isOrg = true } = {}) {
    this.onProgress(`Fetching packages for ${login}...`);

    const { packages, warnings } = await this.listPackages(login, isOrg);

    // sizeKnown is derived from whether the Maven fetch actually succeeded,
    // not just from the package type - a failed/partial fetch must report
    // "unknown", never a false "0 B".
    let mavenSizes = new Map();
    let mavenSizeFetchSucceeded = false;
    if (packages.some(pkg => pkg.packageType in PACKAGE_TYPES_WITH_KNOWN_SIZE)) {
      try {
        mavenSizes = await this.fetchMavenPackageSizes(login);
        mavenSizeFetchSucceeded = true;
      } catch (error) {
        warnings.push(`Fetching Maven package sizes: ${this.describeError(error)}`);
      }
    }

    // Collect every package's versions concurrently, bounded, instead of one
    // package at a time - matches the concurrent-probing pattern already
    // used for repos in artifact-analyzer.ts's filterRepositoriesWithArtifacts.
    await this.warnAndWaitIfQuotaLow();

    let collectedCount = 0;
    const limit = pLimit(VERSION_COLLECTION_CONCURRENCY);
    await Promise.all(packages.map(pkg => limit(async () => {
      try {
        pkg.versions = await this.collectPackageVersions(login, pkg.packageType, pkg.name, isOrg);
      } catch (error) {
        warnings.push(`Listing versions for ${pkg.name}: ${this.describeError(error)}`);
        pkg.versions = [];
      }

      const sizeKey = `${pkg.packageType}:${pkg.name}`;
      pkg.sizeBytes = mavenSizes.has(sizeKey) ? mavenSizes.get(sizeKey) : null;
      pkg.sizeEstimated = false;

      if (pkg.packageType === 'npm') {
        try {
          const estimate = await this.estimateNpmPackageSize(login, pkg.name, pkg.versions);
          if (estimate) {
            pkg.sizeBytes = estimate.estimatedTotalBytes;
            pkg.sizeEstimated = true;
            pkg.sampleCount = estimate.sampleCount;
          }
        } catch (error) {
          warnings.push(`Estimating size for npm package ${pkg.name}: ${this.describeError(error)}`);
        }
      }

      collectedCount++;
      this.onProgress(`Looking for package versions... (${collectedCount}/${packages.length})`);
    })));

    const summary = {
      totalPackages: packages.length,
      totalVersions: packages.reduce((sum, pkg) => sum + pkg.versions.length, 0),
      totalSizeBytes: packages.reduce((sum, pkg) => sum + (pkg.sizeBytes ?? 0), 0),
      packagesWithUnknownSize: packages.filter(pkg => pkg.sizeBytes === null).length,
      byPackageType: PACKAGE_TYPES.reduce((byType, packageType) => {
        const ofType = packages.filter(pkg => pkg.packageType === packageType);
        const sizeKnown = (packageType in PACKAGE_TYPES_WITH_KNOWN_SIZE && mavenSizeFetchSucceeded)
          || (packageType in PACKAGE_TYPES_WITH_ESTIMATED_SIZE && ofType.some(pkg => pkg.sizeBytes !== null));
        const sizeEstimated = packageType in PACKAGE_TYPES_WITH_ESTIMATED_SIZE;
        byType[packageType] = {
          packageCount: ofType.length,
          versionCount: ofType.reduce((sum, pkg) => sum + pkg.versions.length, 0),
          sizeBytes: ofType.reduce((sum, pkg) => sum + (pkg.sizeBytes ?? 0), 0),
          sizeKnown,
          sizeEstimated
        };
        return byType;
      }, {})
    };

    return { packages, summary, incomplete: warnings.length > 0, warnings };
  }
}

export { GitHubPackagesAnalyzer, emptyPackagesAnalysis };
