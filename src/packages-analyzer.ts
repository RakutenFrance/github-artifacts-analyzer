import { GitHubClient } from './github-client.js';

// All package_type values the REST packages API accepts.
export const PACKAGE_TYPES = ['npm', 'maven', 'rubygems', 'nuget', 'docker', 'container'];

// GitHub's GraphQL API only exposes PackageFile.size (byte sizes) for these
// registries; npm/docker/container/nuget/rubygems have no size field in any
// documented API short of resolving each version's real download URL, which
// doesn't scale (container layers can be gigabytes).
const PACKAGE_TYPES_WITH_KNOWN_SIZE = { maven: 'MAVEN' };

class GitHubPackagesAnalyzer extends GitHubClient {
  // Sums real byte sizes for every Maven package via GraphQL's PackageFile.size.
  // Page sizes are kept small (10 packages x 20 versions x 10 files) - a wider
  // query easily exceeds GitHub's GraphQL node-count resource limit for orgs
  // with many versions per package. Returns a Map of package name -> bytes.
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
        sizeByPackageName.set(pkg.name, totalSize);
      }

      hasNextPage = packages.pageInfo.hasNextPage;
      after = packages.pageInfo.endCursor;
    }

    return sizeByPackageName;
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

    let mavenSizes = new Map();
    if (packages.some(pkg => pkg.packageType in PACKAGE_TYPES_WITH_KNOWN_SIZE)) {
      try {
        mavenSizes = await this.fetchMavenPackageSizes(login);
      } catch (error) {
        warnings.push(`Fetching Maven package sizes: ${this.describeError(error)}`);
      }
    }

    for (const pkg of packages) {
      await this.warnAndWaitIfQuotaLow();
      this.onProgress(`Looking for versions of package ${pkg.name} (${pkg.packageType})...`);

      try {
        pkg.versions = await this.collectPackageVersions(login, pkg.packageType, pkg.name, isOrg);
      } catch (error) {
        warnings.push(`Listing versions for ${pkg.name}: ${this.describeError(error)}`);
        pkg.versions = [];
      }

      pkg.sizeBytes = mavenSizes.has(pkg.name) ? mavenSizes.get(pkg.name) : null;
    }

    const summary = {
      totalPackages: packages.length,
      totalVersions: packages.reduce((sum, pkg) => sum + pkg.versions.length, 0),
      totalSizeBytes: packages.reduce((sum, pkg) => sum + (pkg.sizeBytes ?? 0), 0),
      packagesWithUnknownSize: packages.filter(pkg => pkg.sizeBytes === null).length,
      byPackageType: PACKAGE_TYPES.reduce((byType, packageType) => {
        const ofType = packages.filter(pkg => pkg.packageType === packageType);
        byType[packageType] = {
          packageCount: ofType.length,
          versionCount: ofType.reduce((sum, pkg) => sum + pkg.versions.length, 0),
          sizeBytes: ofType.reduce((sum, pkg) => sum + (pkg.sizeBytes ?? 0), 0),
          sizeKnown: packageType in PACKAGE_TYPES_WITH_KNOWN_SIZE
        };
        return byType;
      }, {})
    };

    return { packages, summary, incomplete: warnings.length > 0, warnings };
  }
}

export { GitHubPackagesAnalyzer };
