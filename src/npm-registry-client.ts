import pLimit from 'p-limit';
import { sampleSizeFor, pickItemsToSample } from './sampling.js';

// Reads a version's real tarball size with zero data transfer: one GET to
// resolve the tarball's redirect location (npm.pkg.github.com does not
// support HEAD directly), then a HEAD against that final blob URL for
// Content-Length. Neither request touches the GitHub REST API's rate limit
// (confirmed: a separate host, no effect on x-ratelimit-remaining).
async function fetchTarballSize(tarballUrl, token) {
  const redirectResponse = await fetch(tarballUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}` }
  });

  const blobUrl = redirectResponse.headers.get('location');
  if (!blobUrl) throw new Error(`No redirect location for ${tarballUrl}`);

  const headResponse = await fetch(blobUrl, { method: 'HEAD' });
  const contentLength = headResponse.headers.get('content-length');
  if (contentLength === null) throw new Error(`No Content-Length for ${blobUrl}`);

  return Number(contentLength);
}

// Estimates one npm package's total size from a sample of its versions' real
// tarball sizes, rather than downloading or measuring every version. Returns
// null if every sampled version's size lookup failed.
export async function estimatePackageSize(token, scope, packageName, versions, { concurrency = 10 } = {}) {
  if (versions.length === 0) return null;

  const sampleSize = sampleSizeFor(versions.length);
  const sampled = pickItemsToSample(versions, sampleSize);

  const registryResponse = await fetch(`https://npm.pkg.github.com/@${scope}/${packageName}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!registryResponse.ok) {
    throw new Error(`Fetching npm registry metadata: HTTP ${registryResponse.status}`);
  }
  const registryData: any = await registryResponse.json();

  const limit = pLimit(concurrency);
  const sizes = await Promise.all(sampled.map(version => limit(async () => {
    const tarballUrl = registryData.versions?.[version.name]?.dist?.tarball;
    if (!tarballUrl) return null;
    try {
      return await fetchTarballSize(tarballUrl, token);
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
