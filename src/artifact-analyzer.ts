import pLimit from 'p-limit';
import chalk from 'chalk';
import { GitHubClient } from './github-client.js';

// Mirrors @octokit/plugin-throttling's own global maxConcurrent default.
export const PROBE_CONCURRENCY = 10;

class GitHubArtifactsAnalyzer extends GitHubClient {
  // Cheap, non-paginated existence check: does this repo have any artifacts
  // at all? Fails open (treats errors as "might have artifacts") so pass 3's
  // richer error handling gets a chance to classify the failure properly.
  private async probeRepositoryHasArtifacts(owner, repo) {
    try {
      const response = await this.octokit.actions.listArtifactsForRepo({ owner, repo, per_page: 1 });
      const totalCount = response.data.total_count ?? (Array.isArray(response.data) ? response.data.length : 0);
      return totalCount > 0;
    } catch {
      return true;
    }
  }

  // Probes every repo concurrently so only repos that might have artifacts
  // go through the expensive sequential analysis in analyzeRepositoryBatch.
  private async filterRepositoriesWithArtifacts(repos) {
    await this.warnAndWaitIfQuotaLow();

    let probedCount = 0;
    const limit = pLimit(PROBE_CONCURRENCY);
    const flags = await Promise.all(
      repos.map(repo => limit(async () => {
        const hasArtifacts = await this.probeRepositoryHasArtifacts(repo.owner.login, repo.name);
        probedCount++;
        this.onProgress(`Probing repositories for artifacts... (${probedCount}/${repos.length})`);
        return hasArtifacts;
      }))
    );

    const repositoriesToAnalyze = repos.filter((_, i) => flags[i]);
    const emptyRepositoryCount = repos.length - repositoriesToAnalyze.length;

    console.log(chalk.gray(
      `  Probed ${repos.length} repositories: ${repositoriesToAnalyze.length} may have artifacts, ` +
      `${emptyRepositoryCount} appear empty and will be skipped from detailed analysis.`
    ));

    return { repositoriesToAnalyze, emptyRepositoryCount };
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

    // No run can be older than the oldest surviving artifact, so filter
    // server-side instead of paginating the repo's entire run history.
    const oldestArtifactDate = new Date(Math.min(...analysis.artifacts.map(a => a.createdAt.getTime())));

    try {
      for await (const { data: runs } of this.octokit.paginate.iterator(
        this.octokit.actions.listWorkflowRunsForRepo,
        { owner, repo, per_page: 100, created: `>=${oldestArtifactDate.toISOString()}` }
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
      await this.warnAndWaitIfQuotaLow();
      this.onProgress(`Looking for artifacts in repository ${repo.full_name}...`);
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

  private buildAnalysisResult(repositories, skippedRepositories, extra = {}, emptyRepositoryCount = 0) {
    const summary = this.calculateSummary(repositories, skippedRepositories, emptyRepositoryCount);
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

  // Pass 1: list every repo owned by the user, with no per-repo API calls yet.
  private async listAllRepositoriesForUser(username) {
    const repos = [];

    // sort: 'created' is immutable, so a repo can't shift pages mid-scan.
    for await (const { data: page } of this.octokit.paginate.iterator(
      this.octokit.repos.listForAuthenticatedUser,
      {
        visibility: 'all', // Gets both public and private repos
        per_page: 100,
        sort: 'created'
      }
    )) {
      // Filter to only repos owned by the target user (not organizations)
      repos.push(...page.filter(repo => repo.owner.login === username && !repo.fork));
      this.onProgress(`Fetching repositories... (${repos.length} found)`);
    }

    return repos;
  }

  // Pass 1: list every public repo owned by the user, with no per-repo API calls yet.
  private async listPublicRepositoriesForUser(username) {
    const repos = [];

    for await (const { data: page } of this.octokit.paginate.iterator(
      this.octokit.repos.listForUser,
      {
        username,
        per_page: 100,
        type: 'owner', // Only repositories owned by the user, not organizations
        sort: 'created'
      }
    )) {
      repos.push(...page);
      this.onProgress(`Fetching repositories... (${repos.length} found)`);
    }

    return repos;
  }

  // Pass 1: list every non-fork repo in the org, with no per-repo API calls yet.
  private async listOrganizationRepositories(orgName) {
    const repos = [];

    // sort: 'created' is immutable, so a repo can't shift pages mid-scan.
    for await (const { data: page } of this.octokit.paginate.iterator(
      this.octokit.repos.listForOrg,
      {
        org: orgName,
        type: 'all', // all, public, private, forks, sources, member
        per_page: 100,
        sort: 'created'
      }
    )) {
      repos.push(...page.filter(repo => !repo.fork));
      this.onProgress(`Fetching organization repositories... (${repos.length} found)`);
    }

    return repos;
  }

  async analyzeAllRepositories(username, options = { includeExpired: false, minSize: 0 }) {
    // Get authenticated user if no username provided
    if (!username) {
      const { data: user } = await this.octokit.users.getAuthenticated();
      username = user.login;
    }

    console.log(chalk.blue(`\n📊 Analyzing repositories for user: ${username}\n`));

    let repos;
    try {
      repos = await this.listAllRepositoriesForUser(username);
    } catch (error) {
      // Fallback to public repos if authenticated call fails
      if (error.status === 401 || error.status === 403) {
        console.log(chalk.yellow('⚠ Using public repositories only (authentication issue)'));
        return this.analyzePublicRepositories(username, options);
      }
      throw error;
    }

    const { repositoriesToAnalyze, emptyRepositoryCount } = await this.filterRepositoriesWithArtifacts(repos);
    const { repositories, skippedRepositories } = await this.analyzeRepositoryBatch(repositoriesToAnalyze, options);

    return this.buildAnalysisResult(repositories, skippedRepositories, {}, emptyRepositoryCount);
  }

  async analyzePublicRepositories(username, options = { includeExpired: false, minSize: 0 }) {
    const repos = await this.listPublicRepositoriesForUser(username);
    const { repositoriesToAnalyze, emptyRepositoryCount } = await this.filterRepositoriesWithArtifacts(repos);
    const { repositories, skippedRepositories } = await this.analyzeRepositoryBatch(repositoriesToAnalyze, options);

    return this.buildAnalysisResult(repositories, skippedRepositories, {}, emptyRepositoryCount);
  }

  async analyzeOrganizationRepositories(
    orgName: string,
    options = {
      includeExpired: false,
      minSize: 0
    }
  ) {
    console.log(chalk.blue(`\n📊 Analyzing organization: ${orgName}\n`));

    let repos;
    try {
      repos = await this.listOrganizationRepositories(orgName);
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Organization '${orgName}' not found or you don't have access`);
      } else if (error.status === 403) {
        throw new Error('Access forbidden - check token has read:org permission');
      }
      throw error;
    }

    const { repositoriesToAnalyze, emptyRepositoryCount } = await this.filterRepositoriesWithArtifacts(repos);
    const { repositories, skippedRepositories } = await this.analyzeRepositoryBatch(repositoriesToAnalyze, {
      includeExpired: options.includeExpired ?? false,
      minSize: options.minSize ?? 0
    });

    return this.buildAnalysisResult(repositories, skippedRepositories, { organizationName: orgName }, emptyRepositoryCount);
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

  calculateSummary(repositories, skippedRepositories = [], emptyRepositoryCount = 0) {
    return {
      totalRepositories: repositories.length + skippedRepositories.length + emptyRepositoryCount,
      repositoriesSkipped: skippedRepositories.length,
      repositoriesWithoutArtifacts: emptyRepositoryCount,
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
