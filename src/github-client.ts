import { Octokit as OctokitRest } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import chalk from 'chalk';

const Octokit = OctokitRest.plugin(throttling);

// Shared Octokit setup, rate-limit tracking, and progress reporting used by
// both the artifacts analyzer and the packages analyzer.
class GitHubClient {
  protected octokit: InstanceType<typeof Octokit>;
  protected token: string;
  private remainingRequests: number | null = null;
  private rateLimitResetAt: Date | null = null;
  protected onProgress: (message: string) => void;

  constructor(token, { onProgress = (_message: string) => {} } = {}) {
    this.token = token;
    this.onProgress = onProgress;
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
      const reset = response.headers['x-ratelimit-reset'];
      if (remaining !== undefined) {
        this.remainingRequests = Number(remaining);
      }
      if (reset !== undefined) {
        this.rateLimitResetAt = new Date(Number(reset) * 1000);
      }
    });
  }

  // Rate limits are per-user, not per-token, so a token dedicated to this tool
  // still shares quota with everything else the user does (e.g. their deploy
  // workflows). There's nothing the user can do about a low quota mid-run, so
  // just wait out the hourly reset instead of pressing on and starving them.
  protected async warnAndWaitIfQuotaLow(threshold = 500) {
    if (this.remainingRequests === null || this.remainingRequests > threshold || !this.rateLimitResetAt) {
      return;
    }

    const waitMs = this.rateLimitResetAt.getTime() - Date.now();
    if (waitMs <= 0) return;

    const waitMinutes = Math.ceil(waitMs / 60000);
    console.log(chalk.yellow(
      `\n⏳ Rate limit low (${this.remainingRequests} requests remaining). ` +
      `Waiting until ${this.rateLimitResetAt.toLocaleTimeString()} (${waitMinutes} minute${waitMinutes !== 1 ? 's' : ''})...`
    ));
    await this.sleep(waitMs + 1000);
    console.log(chalk.green('✓ Rate limit reset. Resuming operations...\n'));
    this.remainingRequests = null;
  }

  protected describeError(error) {
    return error?.message || 'Unknown error';
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
}

export { GitHubClient };
