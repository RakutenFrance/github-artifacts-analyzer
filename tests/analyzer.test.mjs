import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitHubArtifactsAnalyzer } from '../dist/analyzer.js';
import { ReportGenerator } from '../dist/reporter.js';

// Stand-in for paginate.iterator(): calls the mock until it returns an empty page.
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

function createAnalyzer(octokit) {
  const analyzer = new GitHubArtifactsAnalyzer('test-token');
  analyzer.octokit = {
    ...octokit,
    paginate: { iterator: paginateIteratorShim }
  };
  return analyzer;
}

function workflowFixture() {
  return {
    total_count: 1,
    workflows: [{ id: 10, name: 'Build', path: '.github/workflows/build.yml', state: 'active' }],
  };
}

test('attributes each artifact to its workflow name via the run lookup', async () => {
  let runsPage = 0;
  let artifactsPage = 0;
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({
        data: {
          total_count: 2,
          workflows: [
            { id: 10, name: 'Build', path: '.github/workflows/build.yml', state: 'active' },
            { id: 20, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' },
          ],
        },
      }),
      listWorkflowRunsForRepo: async () => ({
        data: runsPage++ === 0
          ? [
            { id: 100, workflow_id: 10 },
            { id: 200, workflow_id: 20 },
          ]
          : [],
      }),
      listArtifactsForRepo: async () => ({
        data: artifactsPage++ === 0
          ? [
            {
              id: 1, name: 'build-output', size_in_bytes: 10, expired: false,
              created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
              workflow_run: { id: 100 },
            },
            {
              id: 2, name: 'deploy-output', size_in_bytes: 20, expired: false,
              created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
              workflow_run: { id: 200 },
            },
          ]
          : [],
      }),
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.totalArtifacts, 2);
  assert.deepEqual(
    analysis.artifacts.map(a => [a.name, a.workflowName]).sort(),
    [['build-output', 'Build'], ['deploy-output', 'Deploy']]
  );
});

test('filters the run lookup to runs no older than the oldest surviving artifact', async () => {
  let artifactsPage = 0;
  let seenCreatedFilter;
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRunsForRepo: async ({ created }) => {
        seenCreatedFilter = created;
        return { data: [] };
      },
      listArtifactsForRepo: async () => ({
        data: artifactsPage++ === 0
          ? [
            {
              id: 1, name: 'newer', size_in_bytes: 10, expired: false,
              created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
              workflow_run: { id: 100 },
            },
            {
              id: 2, name: 'older', size_in_bytes: 10, expired: false,
              created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
              workflow_run: { id: 200 },
            },
          ]
          : [],
      }),
    },
  });

  await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(seenCreatedFilter, '>=2026-01-01T00:00:00.000Z');
});

test('marks a repository incomplete when the workflow run lookup fails', async () => {
  let artifactsPage = 0;
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRunsForRepo: async () => {
        throw Object.assign(new Error('SSO authorization required'), { status: 403 });
      },
      // At least one artifact must be found, or the run lookup this test
      // targets is skipped entirely (nothing to attribute a name to).
      listArtifactsForRepo: async () => ({
        data: artifactsPage++ === 0
          ? [{
            id: 1, name: 'build-output', size_in_bytes: 10, expired: false,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
            workflow_run: { id: 100 },
          }]
          : [],
      }),
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.incomplete, true);
  assert.match(analysis.warnings[0], /SSO authorization required/);
});

test('tracks an unretried rate-limit error from artifact listing as a normal failure instead of aborting', async () => {
  // The @octokit/plugin-throttling transport layer retries real rate limits
  // before they ever reach application code, so anything that still throws
  // here is a genuine, non-recoverable failure and should just be tracked.
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRunsForRepo: async () => ({ data: [] }),
      listArtifactsForRepo: async () => {
        throw Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        });
      },
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.incomplete, true);
  assert.match(analysis.warnings[0], /API rate limit exceeded/);
});

test('tracks repositories that could not be analyzed', async () => {
  let repositoryPage = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForAuthenticatedUser: async () => ({
        data: repositoryPage++ === 0
          ? [{ full_name: 'owner/repo', owner: { login: 'owner' }, name: 'repo', fork: false, private: true }]
          : [],
      }),
    },
    actions: {
      listRepoWorkflows: async () => {
        throw Object.assign(new Error('Not found'), { status: 404 });
      },
    },
  });

  const analysis = await analyzer.analyzeAllRepositories('owner');

  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.summary.repositoriesSkipped, 1);
  assert.deepEqual(analysis.skippedRepositories, [
    { fullName: 'owner/repo', reason: 'Repository not found or no access' },
  ]);
});

test('keeps scanning the rest of an org after one repository fails without retry', async () => {
  let repositoryPage = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForAuthenticatedUser: async () => ({
        data: repositoryPage++ === 0
          ? [{ full_name: 'owner/repo', owner: { login: 'owner' }, name: 'repo', fork: false, private: true }]
          : [],
      }),
    },
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRunsForRepo: async () => ({ data: [] }),
      listArtifactsForRepo: async () => {
        throw Object.assign(new Error('Secondary rate limit'), {
          status: 403,
          response: { headers: { 'retry-after': '60' } },
        });
      },
    },
  });

  const analysis = await analyzer.analyzeAllRepositories('owner');

  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.summary.repositoriesIncomplete, 1);
  assert.match(analysis.repositories[0].warnings[0], /Secondary rate limit/);
});

test('throttling plugin retries a primary rate limit and tracks the recovered quota', async () => {
  const analyzer = new GitHubArtifactsAnalyzer('test-token');
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
        },
      });
    }
    return new Response(JSON.stringify({ total_count: 0, workflows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
    });
  };

  try {
    const { data } = await analyzer.octokit.actions.listRepoWorkflows({ owner: 'owner', repo: 'repo' });
    assert.equal(data.total_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(callCount, 2);
  assert.equal(analyzer.remainingRequests, 4999);
});

test('warns once remaining quota drops to the configured threshold', async () => {
  const analyzer = new GitHubArtifactsAnalyzer('test-token');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({ total_count: 0, workflows: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '42' },
  });

  try {
    await analyzer.octokit.actions.listRepoWorkflows({ owner: 'owner', repo: 'repo' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));

  try {
    analyzer.warnIfQuotaLow(100);
  } finally {
    console.log = originalLog;
  }

  assert.ok(logged.some(line => line.includes('42')));
});

function countingOrgFixture({ repoCount, workflowsPerRepo, runsPerWorkflow }) {
  const counts = {};
  const count = (name) => { counts[name] = (counts[name] || 0) + 1; };

  const repos = Array.from({ length: repoCount }, (_, i) => ({
    full_name: `my-org/repo-${i}`,
    owner: { login: 'my-org' },
    name: `repo-${i}`,
    fork: false,
    private: false,
  }));

  const workflows = Array.from({ length: workflowsPerRepo }, (_, i) => ({
    id: i, name: `workflow-${i}`, path: `.github/workflows/w${i}.yml`, state: 'active',
  }));

  // One artifact per run, matching the old per-run fixture, so totalArtifacts
  // stays comparable across both the "before" and "after" call-count tests.
  const totalRuns = workflowsPerRepo * runsPerWorkflow;
  const runPage = new Map();
  const artifactPage = new Map();

  let repoPage = 0;
  const octokit = {
    repos: {
      listForOrg: async () => {
        count('listForOrg');
        return { data: repoPage++ === 0 ? repos : [] };
      },
    },
    actions: {
      listRepoWorkflows: async () => {
        count('listRepoWorkflows');
        return { data: { total_count: workflows.length, workflows } };
      },
      listWorkflowRunsForRepo: async ({ repo }) => {
        count('listWorkflowRunsForRepo');
        const page = runPage.get(repo) || 0;
        runPage.set(repo, page + 1);
        if (page > 0) return { data: [] };
        return {
          data: Array.from({ length: totalRuns }, (_, i) => ({ id: i, workflow_id: i % workflowsPerRepo })),
        };
      },
      listArtifactsForRepo: async ({ repo }) => {
        count('listArtifactsForRepo');
        const page = artifactPage.get(repo) || 0;
        artifactPage.set(repo, page + 1);
        if (page > 0) return { data: [] };
        return {
          data: Array.from({ length: totalRuns }, (_, i) => ({
            id: i, name: `artifact-${i}`, size_in_bytes: 10, expired: false,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
            workflow_run: { id: i },
          })),
        };
      },
    },
  };

  return { octokit, counts };
}

test('records fewer API calls per repo with the repo-level artifact/run scheme', async () => {
  const { octokit, counts } = countingOrgFixture({ repoCount: 2, workflowsPerRepo: 3, runsPerWorkflow: 10 });
  const analyzer = createAnalyzer(octokit);

  const analysis = await analyzer.analyzeOrganizationRepositories('my-org');

  assert.equal(analysis.summary.totalRepositories, 2);
  assert.equal(analysis.summary.totalArtifacts, 60); // 2 repos * 3 workflows * 10 runs * 1 artifact

  // One paginated run listing and one paginated artifact listing per repo,
  // instead of one artifacts call per run - down from 70 calls to 12 for
  // this fixture (was: listForOrg 2, listRepoWorkflows 2, listWorkflowRuns 6,
  // listWorkflowRunArtifacts 60).
  assert.deepEqual(counts, {
    listForOrg: 2,
    listRepoWorkflows: 2,
    listWorkflowRunsForRepo: 4,   // 2 repos * (1 page of data + 1 empty page)
    listArtifactsForRepo: 4,      // 2 repos * (1 page of data + 1 empty page)
  });
});

test('skips the run-history pagination entirely for a repo with workflows but no artifacts', async () => {
  const counts = {};
  const count = (name) => { counts[name] = (counts[name] || 0) + 1; };

  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => {
        count('listRepoWorkflows');
        return { data: workflowFixture() };
      },
      // Simulates a repo with a long run history (many pages) but no
      // surviving artifacts - this pagination should never be reached.
      listWorkflowRunsForRepo: async () => {
        count('listWorkflowRunsForRepo');
        return { data: [{ id: 1, workflow_id: 10 }] };
      },
      listArtifactsForRepo: async () => {
        count('listArtifactsForRepo');
        return { data: [] };
      },
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.totalArtifacts, 0);
  assert.deepEqual(counts, {
    listRepoWorkflows: 1,
    listArtifactsForRepo: 1,
  });
});

test('analyzes every non-fork repository across an organization', async () => {
  let repoPage = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => ({
        data: repoPage++ === 0
          ? [
            { full_name: 'my-org/service-a', owner: { login: 'my-org' }, name: 'service-a', fork: false, private: true },
            { full_name: 'my-org/service-b', owner: { login: 'my-org' }, name: 'service-b', fork: false, private: false },
            { full_name: 'my-org/vendored', owner: { login: 'my-org' }, name: 'vendored', fork: true, private: false },
          ]
          : [],
      }),
    },
    actions: {
      listRepoWorkflows: async () => ({ data: { total_count: 0, workflows: [] } }),
    },
  });

  const analysis = await analyzer.analyzeOrganizationRepositories('my-org');

  assert.equal(analysis.organizationName, 'my-org');
  assert.deepEqual(
    analysis.repositories.map(r => r.fullName),
    ['my-org/service-a', 'my-org/service-b']
  );
  assert.equal(analysis.summary.totalRepositories, 2);
});

test('paginates through multiple pages of organization repositories', async () => {
  const pages = [
    [{ full_name: 'my-org/repo-1', owner: { login: 'my-org' }, name: 'repo-1', fork: false, private: false }],
    [{ full_name: 'my-org/repo-2', owner: { login: 'my-org' }, name: 'repo-2', fork: false, private: false }],
    [],
  ];
  let callIndex = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => ({ data: pages[callIndex++] }),
    },
    actions: {
      listRepoWorkflows: async () => ({ data: { total_count: 0, workflows: [] } }),
    },
  });

  const analysis = await analyzer.analyzeOrganizationRepositories('my-org');

  assert.deepEqual(
    analysis.repositories.map(r => r.fullName),
    ['my-org/repo-1', 'my-org/repo-2']
  );
});

test('paginates organization, user, and public repositories with a stable sort key', async () => {
  // 'created' can't shift mid-scan, unlike 'updated' or a renameable full_name.
  const seenSorts = [];
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async (params) => {
        seenSorts.push(['listForOrg', params.sort]);
        return { data: [] };
      },
      listForAuthenticatedUser: async (params) => {
        seenSorts.push(['listForAuthenticatedUser', params.sort]);
        return { data: [] };
      },
      listForUser: async (params) => {
        seenSorts.push(['listForUser', params.sort]);
        return { data: [] };
      },
    },
  });

  await analyzer.analyzeOrganizationRepositories('my-org');
  await analyzer.analyzeAllRepositories('owner');
  await analyzer.analyzePublicRepositories('owner');

  assert.deepEqual(seenSorts, [
    ['listForOrg', 'created'],
    ['listForAuthenticatedUser', 'created'],
    ['listForUser', 'created'],
  ]);
});

test('skips an organization repository that fails without aborting the scan', async () => {
  let repoPage = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => ({
        data: repoPage++ === 0
          ? [
            { full_name: 'my-org/broken', owner: { login: 'my-org' }, name: 'broken', fork: false, private: false },
            { full_name: 'my-org/ok', owner: { login: 'my-org' }, name: 'ok', fork: false, private: false },
          ]
          : [],
      }),
    },
    actions: {
      listRepoWorkflows: async ({ repo }) => {
        if (repo === 'broken') {
          throw Object.assign(new Error('Not found'), { status: 404 });
        }
        return { data: { total_count: 0, workflows: [] } };
      },
    },
  });

  const analysis = await analyzer.analyzeOrganizationRepositories('my-org');

  assert.deepEqual(analysis.repositories.map(r => r.fullName), ['my-org/ok']);
  assert.equal(analysis.summary.totalRepositories, 1);
  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.summary.repositoriesSkipped, 1);
  assert.deepEqual(analysis.skippedRepositories, [
    { fullName: 'my-org/broken', reason: 'Repository not found or no access' },
  ]);
});

test('tracks every organization repository failure instead of reporting a falsely complete summary', async () => {
  let repoPage = 0;
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => ({
        data: repoPage++ === 0
          ? [
            { full_name: 'my-org/rate-limited', owner: { login: 'my-org' }, name: 'rate-limited', fork: false, private: false },
            { full_name: 'my-org/no-access', owner: { login: 'my-org' }, name: 'no-access', fork: false, private: true },
            { full_name: 'my-org/ok', owner: { login: 'my-org' }, name: 'ok', fork: false, private: false },
          ]
          : [],
      }),
    },
    actions: {
      listRepoWorkflows: async ({ repo }) => {
        if (repo === 'rate-limited') {
          throw Object.assign(new Error('API rate limit exceeded'), {
            status: 403,
            response: { headers: { 'x-ratelimit-remaining': '0' } },
          });
        }
        if (repo === 'no-access') {
          throw Object.assign(new Error('Forbidden'), { status: 403 });
        }
        return { data: { total_count: 0, workflows: [] } };
      },
    },
  });

  const analysis = await analyzer.analyzeOrganizationRepositories('my-org');

  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.summary.totalRepositories, 1);
  assert.equal(analysis.summary.repositoriesSkipped, 2);
  assert.deepEqual(
    analysis.skippedRepositories.map(r => r.fullName).sort(),
    ['my-org/no-access', 'my-org/rate-limited']
  );
});

test('reports a clear error when the organization is not found or inaccessible', async () => {
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    },
  });

  await assert.rejects(
    () => analyzer.analyzeOrganizationRepositories('missing-org'),
    error => /missing-org.*not found or you don't have access/.test(error.message)
  );
});

test('reports a clear error when the token lacks read:org access', async () => {
  const analyzer = createAnalyzer({
    repos: {
      listForOrg: async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      },
    },
  });

  await assert.rejects(
    () => analyzer.analyzeOrganizationRepositories('my-org'),
    error => /read:org permission/.test(error.message)
  );
});

test('CSV reports include incomplete and skipped status metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-report-'));
  const outputFile = join(directory, 'report.csv');
  const reporter = new ReportGenerator();

  try {
    reporter.generateCsvReport({
      repositories: [{
        fullName: 'owner/partial',
        incomplete: true,
        warnings: ['run failed, retry later'],
        workflows: [],
        totalArtifacts: 0,
        totalSizeBytes: 0,
        activeArtifacts: 0,
        activeSizeBytes: 0,
        expiredArtifacts: 0,
        expiredSizeBytes: 0,
      }],
      skippedRepositories: [{ fullName: 'owner/skipped', reason: 'No access' }],
    }, outputFile);

    const csv = readFileSync(outputFile, 'utf8');
    assert.match(csv, /owner\/partial,incomplete,"run failed, retry later"/);
    assert.match(csv, /owner\/skipped,skipped,No access/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repoWithArtifactsFixture(fullName) {
  return {
    fullName,
    owner: fullName.split('/')[0],
    name: fullName.split('/')[1],
    totalArtifacts: 1,
    totalSizeBytes: 500,
    activeArtifacts: 0,
    activeSizeBytes: 0,
    expiredArtifacts: 1,
    expiredSizeBytes: 500,
    artifacts: [{ id: 1, name: 'a', sizeInBytes: 500, expired: true, createdAt: new Date() }],
  };
}

test('cleanup requires an org-level confirmation before touching organization repositories', async () => {
  const reporter = new ReportGenerator();
  const questions = [];
  reporter.askQuestion = async (rl, question) => {
    questions.push(question);
    return 'n';
  };

  await reporter.runCleanupMode({
    organizationName: 'my-org',
    repositories: [repoWithArtifactsFixture('my-org/repo1')]
  }, {});

  assert.equal(questions.length, 1);
  assert.match(questions[0], /my-org/);
  assert.match(questions[0], /1 repositories/);
});

test('cleanup skips all repository prompts when the org-level confirmation is declined', async () => {
  const reporter = new ReportGenerator();
  let repoPromptCount = 0;
  reporter.askQuestion = async (rl, question) => {
    if (/organization/.test(question)) return 'n';
    repoPromptCount++;
    return 'n';
  };

  await reporter.runCleanupMode({
    organizationName: 'my-org',
    repositories: [repoWithArtifactsFixture('my-org/repo1')]
  }, {});

  assert.equal(repoPromptCount, 0);
});

test('cleanup proceeds to per-repository prompts once the org-level confirmation is accepted', async () => {
  const reporter = new ReportGenerator();
  let repoPromptCount = 0;
  reporter.askQuestion = async (rl, question) => {
    if (/organization/.test(question)) return 'y';
    repoPromptCount++;
    return 'n';
  };

  await reporter.runCleanupMode({
    organizationName: 'my-org',
    repositories: [repoWithArtifactsFixture('my-org/repo1')]
  }, { deleteArtifact: async () => true, sleep: async () => {} });

  assert.equal(repoPromptCount, 1);
});

test('cleanup does not ask for an org-level confirmation outside organization analysis', async () => {
  const reporter = new ReportGenerator();
  const questions = [];
  reporter.askQuestion = async (rl, question) => {
    questions.push(question);
    return 'n';
  };

  await reporter.runCleanupMode({
    repositories: [repoWithArtifactsFixture('owner/repo1')]
  }, { deleteArtifact: async () => true, sleep: async () => {} });

  assert.equal(questions.length, 1);
  assert.doesNotMatch(questions[0], /organization/);
});
