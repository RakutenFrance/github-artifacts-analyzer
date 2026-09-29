// How many items to sample out of a total count. log2-scaled so collections
// with hundreds/thousands of items don't blow up request count, while still
// sampling more from genuinely large collections. Below minSamples, just
// sample everything - one bad sample skews the average too much.
const SAMPLE_MIN = 3;
const SAMPLE_MAX = 10;

export function sampleSizeFor(itemCount) {
  if (itemCount <= SAMPLE_MIN) return itemCount;
  return Math.min(SAMPLE_MAX, Math.max(SAMPLE_MIN, Math.ceil(Math.log2(itemCount))));
}

// Picks which items to sample: always the first (e.g. the latest version of
// a package), then a random subset of the rest - avoids bias toward only
// the first/last items in whatever order the caller's list is in (e.g. a
// package that ballooned in size after some point in its history).
export function pickItemsToSample(items, sampleSize) {
  if (items.length <= sampleSize) return items;

  const [first, ...rest] = items;
  const shuffled = rest.slice().sort(() => Math.random() - 0.5);
  return [first, ...shuffled.slice(0, sampleSize - 1)];
}
