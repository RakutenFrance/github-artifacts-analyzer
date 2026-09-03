import pLimit from 'p-limit';
import { sampleSizeFor, pickItemsToSample } from './sampling.js';

// GHCR's bearer token is scope-independent in practice - a token minted for
// any single package works for every package in the org - so it's fetched
// once per estimatePackageSize call and reused across all sampled versions,
// rather than re-minted per version.
async function fetchGhcrToken(token) {
  const response = await fetch('https://ghcr.io/token?service=ghcr.io', {
    headers: { Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` }
  });
  if (!response.ok) {
    throw new Error(`Fetching ghcr.io token: HTTP ${response.status}`);
  }
  const data: any = await response.json();
  return data.token;
}

// Reads a version's real manifest size with zero data transfer beyond the
// small manifest JSON itself (no blob downloads) - one GET to GHCR's
// manifest endpoint, addressed directly by digest (version.name from
// collectPackageVersions is already the digest, so no separate lookup step
// is needed, unlike npm's tarball-URL resolution).
//
// A multi-arch image returns a manifest list/index instead of a single
// manifest; its own entries' size fields are only the sub-manifests' JSON
// blob sizes, not real image content. Fetching each sub-manifest by digest
// for its real config+layers size was tried and found to 404 in practice
// for attestation sub-manifests on GHCR, so this falls back to summing the
// index's own listed sizes - an under-count, but non-zero and free (no
// extra request), and clearly marked as an estimate by the caller either way.
async function fetchManifestSize(owner, packageName, digest, ghcrToken) {
  const response = await fetch(`https://ghcr.io/v2/${owner}/${packageName}/manifests/${digest}`, {
    headers: {
      Authorization: `Bearer ${ghcrToken}`,
      Accept: [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.docker.distribution.manifest.list.v2+json'
      ].join(',')
    }
  });
  if (!response.ok) {
    throw new Error(`Fetching manifest for ${packageName}@${digest}: HTTP ${response.status}`);
  }
  const manifest: any = await response.json();

  if (Array.isArray(manifest.manifests)) {
    return manifest.manifests.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  }

  const layersSize = (manifest.layers ?? []).reduce((sum, layer) => sum + (layer.size ?? 0), 0);
  return (manifest.config?.size ?? 0) + layersSize;
}

// Estimates one container package's total size (Docker image or Helm chart -
// both OCI manifests, sized identically) from a sample of its versions' real
// manifest sizes, rather than fetching every version. Returns null if every
// sampled version's size lookup failed.
export async function estimatePackageSize(token, owner, packageName, versions, { concurrency = 10 } = {}) {
  if (versions.length === 0) return null;

  const sampleSize = sampleSizeFor(versions.length);
  const sampled = pickItemsToSample(versions, sampleSize);

  const ghcrToken = await fetchGhcrToken(token);

  const limit = pLimit(concurrency);
  const sizes = await Promise.all(sampled.map(version => limit(async () => {
    try {
      return await fetchManifestSize(owner, packageName, version.name, ghcrToken);
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
