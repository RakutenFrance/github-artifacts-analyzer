import assert from 'node:assert/strict';
import test from 'node:test';

import { sampleSizeFor, pickItemsToSample } from '../dist/sampling.js';

test('sampleSizeFor scales log2, staying within the configured min/max bounds', () => {
  assert.equal(sampleSizeFor(0), 0);
  assert.equal(sampleSizeFor(1), 1);
  assert.equal(sampleSizeFor(3), 3); // at/below the minimum: sample everything
  assert.equal(sampleSizeFor(4), 3); // log2(4) = 2, floored up to the minimum of 3
  assert.equal(sampleSizeFor(100), 7); // ceil(log2(100)) = 7
  assert.equal(sampleSizeFor(1024), 10); // ceil(log2(1024)) = 10, at the max
  assert.equal(sampleSizeFor(1_000_000), 10); // never exceeds the configured max
});

test('pickItemsToSample always includes the first item and samples the rest', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `v${i}` }));

  const sample = pickItemsToSample(items, 4);

  assert.equal(sample.length, 4);
  assert.equal(sample[0], items[0]); // first item (e.g. the latest version) always included
  assert.equal(new Set(sample.map(v => v.name)).size, 4); // no duplicates
});

test('pickItemsToSample returns every item when there are fewer than the sample size', () => {
  const items = [{ name: 'v0' }, { name: 'v1' }];

  const sample = pickItemsToSample(items, 5);

  assert.deepEqual(sample, items);
});
