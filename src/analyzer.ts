import { Octokit as OctokitRest } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import chalk from 'chalk';

const Octokit = OctokitRest.plugin(throttling);

class GitHubArtifactsAnalyzer {
  private octokit: InstanceType<typeof Octokit>;
  private remainingRequests: number | null = null;

  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'github-artifacts-analyzer/1.0.0',
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.log(chalk.yellow(
            `\n⏳ Rate limit reached for ${options.method} ${options.url}. Waiting ${retryAfter}s...`
          ));
          return true;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          console.log(chalk.yellow(
            `\n⏳ Secondary rate limit reached for ${options.method} ${options.url}. Waiting ${retryAfter}s...`
          ));
          return true;
        }
      }
    });

    // Track remaining quota from response headers so we can warn the user
    // proactively, without spending a request on a dedicated rate-limit check.
    this.octokit.hook.after('request', (response) => {
      const remaining = response.headers['x-ratelimit-remaining'];
      if (remaining !== undefined) {
        this.remainingRequests = Number(remaining);
      }
    });
  }

  private warnIfQuotaLow(threshold = 100) {
    if (this.remainingRequests !== null && this.remainingRequests <= threshold) {
      console.log(chalk.yellow(
        `  ⚠ Only ${this.remainingRequests} GitHub API requests remaining this hour; expect throttling waits soon.`
      ));
    }
  }

  private describeError(error) {
    return error?.message || 'Unknown error';
  }

  private recordWarning(analysis, message) {
    analysis.incomplete = true;
    analysis.warnings.push(message);
  }

  // Paginates all artifacts for the repo directly, instead of listing runs per
  // workflow and artifacts per run - the O(runs) request cost this replaces.
  private async collectRepositoryArtifacts(owner, repo, options, analysis) {
    try {
      for await (const { data: artifacts } of this.octokit.paginate.iterator(
        this.octokit.actions.listArtifactsForRepo,
        { owner, repo, per_page: 100 }
      )) {
        for (const artifact of artifacts) {
          if (artifact.size_in_bytes < options.minSize) continue;

          const isExpired = artifact.expired || (artifact.expires_at ? new Date(artifact.expires_at) < new Date() : false);
          if (isExpired && !options.includeExpired) continue;

          analysis.artifacts.push({
            id: artifact.id,
            name: artifact.name,
            sizeInBytes: artifact.size_in_bytes,
            createdAt: new Date(artifact.created_at || Date.now()),
            updatedAt: new Date(artifact.updated_at || Date.now()),
            expiresAt: new Date(artifact.expires_at || Date.now()),
            expired: isExpired,
            workflowRunId: artifact.workflow_run?.id ?? null,
            workflowName: 'Unknown'
          });
        }
      }
    } catch (error) {
      this.recordWarning(analysis, `Artifact listing: ${this.describeError(error)}`);
    }
  }

  // Paginates all workflow runs for the repo once (instead of once per workflow)
  // to build a run_id -> workflow name lookup, then labels the artifacts already
  // collected. Only called when there's at least one artifact to attribute, so
  // a repo with no surviving artifacts skips this run-history pagination entirely.
  private async attributeWorkflowNames(owner, repo, analysis) {
    const workflowNameById = new Map(analysis.workflows.map(w => [w.id, w.name]));
    const workflowNameByRunId = new Map();

    try {
      for await (const { data: runs } of this.octokit.paginate.iterator(
        this.octokit.actions.listWorkflowRunsForRepo,
        { owner, repo, per_page: 100 }
      )) {
        for (const run of runs) {
          workflowNameByRunId.set(run.id, workflowNameById.get(run.workflow_id));
        }
      }
    } catch (error) {
      this.recordWarning(analysis, `Workflow run lookup: ${this.describeError(error)}`);
      return;
    }

    for (const artifact of analysis.artifacts) {
      artifact.workflowName = workflowNameByRunId.get(artifact.workflowRunId) || 'Unknown';
    }
  }

  // Analyzes repos while tracking per-repository failures instead of swallowing them.
  private async analyzeRepositoryBatch(repos, options) {
    const repositories = [];
    const skippedRepositories = [];

    for (const repo of repos) {
      this.warnIfQuotaLow();
      console.log(chalk.gray(`  Checking ${repo.full_name}${repo.private ? ' (private)' : ''}...`));
      try {
        const analysis = await this.analyzeRepository(repo.owner.login, repo.name, options);
        repositories.push(analysis);

        if (analysis.totalArtifacts > 0) {
          console.log(chalk.green(`    ✓ Found ${analysis.totalArtifacts} artifacts (${this.formatBytes(analysis.totalSizeBytes)})`));
        }
      } catch (error) {
        const reason = this.describeError(error);
        skippedRepositories.push({ fullName: repo.full_name, reason });
        console.log(chalk.yellow(`    ⚠ Skipped (${reason})`));
      }

      // Small delay to be respectful to the API
      await this.sleep(100);
    }

    return { repositories, skippedRepositories };
  }

  private buildAnalysisResult(repositories, skippedRepositories, extra = {}) {
    const summary = this.calculateSummary(repositories, skippedRepositories);
    const incompleteRepositories = repositories
      .filter(repo => repo.incomplete)
      .map(repo => ({ fullName: repo.fullName, warnings: repo.warnings }));

    return {
      ...extra,
      repositories,
      summary,
      incomplete: skippedRepositories.length > 0 || incompleteRepositories.length > 0,
      skippedRepositories,
      incompleteRepositories
    };
  }

  async analyzeAllRepositories(username, options = { includeExpired: false, minSize: 0 }) {
    // Get authenticated user if no username provided
    if (!username) {
      const { data: user } = await this.octokit.users.getAuthenticated();
      username = user.login;
    }

    console.log(chalk.blue(`\n📊 Analyzing repositories for user: ${username}\n`));

    // Get all repositories for the user - both public and private
    const repositories = [];
    const skippedRepositories = [];

    try {
      // sort: 'created' is immutable, so a repo can't shift pages mid-scan.
      for await (const { data: repos } of this.octokit.paginate.iterator(
        this.octokit.repos.listForAuthenticatedUser,
        {
          visibility: 'all', // Gets both public and private repos
          per_page: 100,
          sort: 'created'
        }
      )) {
        // Filter to only repos owned by the target user (not organizations)
        const userRepos = repos.filter(repo =>
          repo.owner.login === username && !repo.fork
        );

        const batch = await this.analyzeRepositoryBatch(userRepos, options);
        repositories.push(...batch.repositories);
        skippedRepositories.push(...batch.skippedRepositories);
      }
    } catch (error) {
      // Fallback to public repos if authenticated call fails
      if (error.status === 401 || error.status === 403) {
        console.log(chalk.yellow('⚠ Using public repositories only (authentication issue)'));
        return this.analyzePublicRepositories(username, options);
      }
      throw error;
    }

    return this.buildAnalysisResult(repositories, skippedRepositories);
  }

  async analyzePublicRepositories(username, options = { includeExpired: false, minSize: 0 }) {
    const repositories = [];
    const skippedRepositories = [];

    for await (const { data: repos } of this.octokit.paginate.iterator(
      this.octokit.repos.listForUser,
      {
        username,
        per_page: 100,
        type: 'owner', // Only repositories owned by the user, not organizations
        sort: 'created'
      }
    )) {
      const batch = await this.analyzeRepositoryBatch(repos, options);
      repositories.push(...batch.repositories);
      skippedRepositories.push(...batch.skippedRepositories);
    }

    return this.buildAnalysisResult(repositories, skippedRepositories);
  }

  async analyzeOrganizationRepositories(
    orgName: string,
    options = {
      includeExpired: false,
      minSize: 0
    }
  ) {
    console.log(chalk.blue(`\n📊 Analyzing organization: ${orgName}\n`));

    const repositories = [];
    const skippedRepositories = [];

    try {
      // sort: 'created' is immutable, so a repo can't shift pages mid-scan.
      for await (const { data: repos } of this.octokit.paginate.iterator(
        this.octokit.repos.listForOrg,
        {
          org: orgName,
          type: 'all', // all, public, private, forks, sources, member
          per_page: 100,
          sort: 'created'
        }
      )) {
        // Filter out forks (keep only source repos)
        const filteredRepos = repos.filter(repo => !repo.fork);

        const batch = await this.analyzeRepositoryBatch(filteredRepos, {
          includeExpired: options.includeExpired ?? false,
          minSize: options.minSize ?? 0
        });
        repositories.push(...batch.repositories);
        skippedRepositories.push(...batch.skippedRepositories);
      }
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Organization '${orgName}' not found or you don't have access`);
      } else if (error.status === 403) {
        throw new Error('Access forbidden - check token has read:org permission');
      }
      throw error;
    }

    return this.buildAnalysisResult(repositories, skippedRepositories, { organizationName: orgName });
  }

  async analyzeRepository(owner, repo, options = { includeExpired: false, minSize: 0 }) {
    const analysis = {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      hasWorkflows: false,
      workflows: [],
      artifacts: [],
      totalArtifacts: 0,
      totalSizeBytes: 0,
      activeArtifacts: 0,
      expiredArtifacts: 0,
      activeSizeBytes: 0,
      expiredSizeBytes: 0,
      incomplete: false,
      warnings: []
    };

    try {
      // Get workflows for the repository
      const { data: workflowsData } = await this.octokit.actions.listRepoWorkflows({
        owner,
        repo
      });

      if (workflowsData.total_count === 0) {
        return analysis; // No workflows, no artifacts possible
      }

      analysis.hasWorkflows = true;
      analysis.workflows = workflowsData.workflows.map(w => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state
      }));

      // Collect artifacts first, then only pay for the run-history pagination
      // needed to attribute workflow names if there's actually something to label.
      await this.collectRepositoryArtifacts(owner, repo, options, analysis);
      if (analysis.artifacts.length > 0) {
        await this.attributeWorkflowNames(owner, repo, analysis);
      }

      // Calculate statistics
      analysis.totalArtifacts = analysis.artifacts.length;
      analysis.totalSizeBytes = analysis.artifacts.reduce((sum, a) => sum + a.sizeInBytes, 0);
      analysis.activeArtifacts = analysis.artifacts.filter(a => !a.expired).length;
      analysis.expiredArtifacts = analysis.artifacts.filter(a => a.expired).length;
      analysis.activeSizeBytes = analysis.artifacts.filter(a => !a.expired).reduce((sum, a) => sum + a.sizeInBytes, 0);
      analysis.expiredSizeBytes = analysis.artifacts.filter(a => a.expired).reduce((sum, a) => sum + a.sizeInBytes, 0);

    } catch (error) {
      if (error?.status === 404) {
        throw new Error('Repository not found or no access');
      } else if (error?.status === 403) {
        throw new Error('Access forbidden - check token permissions');
      } else {
        throw error;
      }
    }

    return analysis;
  }

  calculateSummary(repositories, skippedRepositories = []) {
    return {
      totalRepositories: repositories.length,
      repositoriesSkipped: skippedRepositories.length,
      repositoriesIncomplete: repositories.filter(r => r.incomplete).length,
      repositoriesWithWorkflows: repositories.filter(r => r.hasWorkflows).length,
      repositoriesWithArtifacts: repositories.filter(r => r.totalArtifacts > 0).length,
      totalArtifacts: repositories.reduce((sum, r) => sum + r.totalArtifacts, 0),
      totalSizeBytes: repositories.reduce((sum, r) => sum + r.totalSizeBytes, 0),
      activeArtifacts: repositories.reduce((sum, r) => sum + r.activeArtifacts, 0),
      expiredArtifacts: repositories.reduce((sum, r) => sum + r.expiredArtifacts, 0),
      activeSizeBytes: repositories.reduce((sum, r) => sum + r.activeSizeBytes, 0),
      expiredSizeBytes: repositories.reduce((sum, r) => sum + r.expiredSizeBytes, 0)
    };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async deleteArtifact(owner, repo, artifactId) {
    try {
      await this.octokit.actions.deleteArtifact({
        owner,
        repo,
        artifact_id: artifactId
      });
      return true;
    } catch (error) {
      console.error(`Failed to delete artifact ${artifactId}:`, error.message);
      return false;
    }
  }
}

export { GitHubArtifactsAnalyzer };