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

test('marks a repository incomplete when a workflow query fails', async () => {
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRuns: async () => {
        throw Object.assign(new Error('SSO authorization required'), { status: 403 });
      },
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.skippedWorkflows, 1);
  assert.match(analysis.warnings[0], /SSO authorization required/);
});

test('tracks an unretried rate-limit error as a normal failure instead of aborting', async () => {
  // The @octokit/plugin-throttling transport layer retries real rate limits
  // before they ever reach application code, so anything that still throws
  // here is a genuine, non-recoverable failure and should just be tracked.
  const analyzer = createAnalyzer({
    actions: {
      listRepoWorkflows: async () => ({ data: workflowFixture() }),
      listWorkflowRuns: async () => ({
        data: { workflow_runs: [{ id: 20 }] },
      }),
      listWorkflowRunArtifacts: async () => {
        throw Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        });
      },
    },
  });

  const analysis = await analyzer.analyzeRepository('owner', 'repo');

  assert.equal(analysis.incomplete, true);
  assert.equal(analysis.skippedWorkflowRuns, 1);
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
      listWorkflowRuns: async () => ({
        data: { workflow_runs: [{ id: 20 }] },
      }),
      listWorkflowRunArtifacts: async () => {
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
  assert.equal(analysis.repositories[0].skippedWorkflowRuns, 1);
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
