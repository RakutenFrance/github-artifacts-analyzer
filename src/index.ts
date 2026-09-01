#!/usr/bin/env node

import * as dotenv from 'dotenv';
import { Command, InvalidArgumentError } from 'commander';
import { GitHubArtifactsAnalyzer } from './artifact-analyzer.js';
import { GitHubPackagesAnalyzer } from './packages-analyzer.js';
import { ReportGenerator } from './reporter.js';
import chalk from 'chalk';
import ora from 'ora';
import { pathToFileURL } from 'url';

// Load environment variables from .env file
dotenv.config();

function parseNonNegativeInteger(value) {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('must be a non-negative integer.');
  }
  return parseInt(value, 10);
}

// Isolated from the artifact scan that precedes it: an unexpected
// packages-analysis failure shouldn't discard an already-completed,
// potentially long-running artifact scan for the whole organization.
async function runPackagesAnalysis(packagesAnalyzer, org) {
  try {
    return await packagesAnalyzer.analyzePackages(org, { isOrg: true });
  } catch (error) {
    console.error(chalk.yellow(`\n⚠ Packages analysis failed: ${error?.message || 'Unknown error'}`));
    return null;
  }
}

const program = new Command();

program
  .name('github-artifacts')
  .description('Analyze GitHub repository artifacts and storage usage')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze artifacts across all repositories')
  .option('-t, --token <token>', 'GitHub Personal Access Token (or set GITHUB_TOKEN env var)')
  .option('-u, --username <username>', 'GitHub username (defaults to authenticated user)')
  .option('-f, --format <format>', 'Output format (table|json|csv)', 'table')
  .option('-o, --output <file>', 'Output file path')
  .option('--include-expired', 'Include expired artifacts in analysis', false)
  .option('--min-size <bytes>', 'Minimum artifact size to include (in bytes)', parseNonNegativeInteger, 0)
  .option('--top <count>', 'Show top N repositories by storage usage', parseNonNegativeInteger, 10)
  .option('--cleanup', 'Interactive cleanup mode - delete artifacts to save space', false)
  .action(async (options) => {
    const token = options.token || process.env.GITHUB_TOKEN;
    if (!token) {
      console.error(chalk.red('Error: GitHub token is required. Use --token or set GITHUB_TOKEN environment variable'));
      process.exit(1);
    }

    const spinner = ora('Initializing GitHub API...').start();

    try {
      const analyzer = new GitHubArtifactsAnalyzer(token, {
        onProgress: (message) => { spinner.text = message; }
      });
      const reporter = new ReportGenerator();

      spinner.text = 'Fetching repositories...';

      const analysis = await analyzer.analyzeAllRepositories(
        options.username,
        {
          includeExpired: options.includeExpired,
          minSize: options.minSize,
        }
      );

      spinner.succeed('Analysis complete!');

      if (options.cleanup) {
        await reporter.runCleanupMode(analysis, analyzer);
      } else {
        await reporter.generateReport(analysis, {
          format: options.format,
          outputFile: options.output,
          topCount: options.top,
        });
      }

    } catch (error) {
      spinner.fail('Analysis failed');
      console.error(chalk.red('Error:'), error?.message || 'Unknown error');
      process.exit(1);
    }
  });

program
  .command('repo')
  .description('Analyze artifacts for a specific repository')
  .argument('<owner>', 'Repository owner')
  .argument('<repo>', 'Repository name')
  .option('-t, --token <token>', 'GitHub Personal Access Token (or set GITHUB_TOKEN env var)')
  .option('-f, --format <format>', 'Output format (table|json|csv)', 'table')
  .option('--include-expired', 'Include expired artifacts in analysis', false)
  .option('--cleanup', 'Interactive cleanup mode for this repository', false)
  .action(async (owner, repo, options) => {
    const token = options.token || process.env.GITHUB_TOKEN;
    if (!token) {
      console.error(chalk.red('Error: GitHub token is required. Use --token or set GITHUB_TOKEN environment variable'));
      process.exit(1);
    }

    const spinner = ora(`Analyzing ${owner}/${repo}...`).start();

    try {
      const analyzer = new GitHubArtifactsAnalyzer(token);
      const reporter = new ReportGenerator();

      const analysis = await analyzer.analyzeRepository(owner, repo, {
        includeExpired: options.includeExpired,
        minSize: 0,
      });

      spinner.succeed('Analysis complete!');

      if (options.cleanup) {
        await reporter.runRepositoryCleanup(analysis, analyzer);
      } else {
        await reporter.generateRepositoryReport(analysis, {
          format: options.format,
        });
      }

    } catch (error) {
      spinner.fail('Analysis failed');
      console.error(chalk.red('Error:'), error?.message || 'Unknown error');
      process.exit(1);
    }
  });

program
  .command('analyze-org')
  .description('Analyze artifacts across all repositories in an organization')
  .argument('<org>', 'GitHub organization name')
  .option('-t, --token <token>', 'GitHub Personal Access Token (or set GITHUB_TOKEN env var)')
  .option('-f, --format <format>', 'Output format (table|json|csv)', 'table')
  .option('-o, --output <file>', 'Output file path')
  .option('--include-expired', 'Include expired artifacts in analysis', false)
  .option('--min-size <bytes>', 'Minimum artifact size to include (in bytes)', parseNonNegativeInteger, 0)
  .option('--top <count>', 'Show top N repositories by storage usage', parseNonNegativeInteger, 10)
  .option('--cleanup', 'Interactive cleanup mode - delete artifacts to save space', false)
  .action(async (org, options) => {
    const token = options.token || process.env.GITHUB_TOKEN;
    if (!token) {
      console.error(chalk.red('Error: GitHub token is required. Use --token or set GITHUB_TOKEN environment variable'));
      process.exit(1);
    }

    const spinner = ora(`Analyzing organization: ${org}...`).start();

    try {
      const onProgress = (message) => { spinner.text = message; };
      const analyzer = new GitHubArtifactsAnalyzer(token, { onProgress });
      const packagesAnalyzer = new GitHubPackagesAnalyzer(token, { onProgress });
      const reporter = new ReportGenerator();

      spinner.text = 'Fetching organization repositories...';
      const analysis = await analyzer.analyzeOrganizationRepositories(org, {
        includeExpired: options.includeExpired,
        minSize: options.minSize,
      });

      if (options.cleanup) {
        spinner.succeed('Analysis complete!');
        await reporter.runCleanupMode(analysis, analyzer);
      } else {
        const packagesAnalysis = await runPackagesAnalysis(packagesAnalyzer, org);

        spinner.succeed('Analysis complete!');
        await reporter.generateReport(analysis, {
          format: options.format,
          outputFile: options.output,
          topCount: options.top,
        }, packagesAnalysis);
      }

    } catch (error) {
      spinner.fail('Analysis failed');
      console.error(chalk.red('Error:'), error?.message || 'Unknown error');
      process.exit(1);
    }
  });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.parse();
}

export { program, runPackagesAnalysis };