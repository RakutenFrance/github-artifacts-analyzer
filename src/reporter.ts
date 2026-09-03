import Table from 'cli-table3';
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import * as readline from 'readline';
import { loadConfig } from './config.js';

// GHCR container image/Helm chart storage is currently unmetered per
// GitHub's docs - it draws from no quota today, unlike Actions artifacts
// and every other package type, which share one Packages+Actions pool.
const PACKAGE_TYPES_EXCLUDED_FROM_QUOTA = { container: true };

class ReportGenerator {
  async generateReport(analysis, options, packagesAnalysis) {
    switch (options.format) {
      case 'json':
        this.generateJsonReport(analysis, options.outputFile, packagesAnalysis);
        break;
      case 'csv':
        this.generateCsvReport(analysis, options.outputFile, packagesAnalysis);
        break;
      case 'table':
      default:
        this.generateStorageOverview(analysis, packagesAnalysis);
        this.generateTopRepositoriesReport(analysis, options.topCount);
        this.generateTopPackagesReport(packagesAnalysis);
        break;
    }
  }

  async generateRepositoryReport(analysis, options) {
    switch (options.format) {
      case 'json':
        console.log(JSON.stringify(analysis, null, 2));
        break;
      case 'csv':
        this.generateRepositoryCsvReport(analysis);
        break;
      case 'table':
      default:
        this.generateRepositoryTableReport(analysis);
        break;
    }
  }

  // Merges what used to be three separate tables (artifacts summary,
  // packages summary, packages-by-type) into one Category/Packages/
  // Artifacts/Storage view, plus an optional "% of quota" column. The quota
  // is a configured assumption (github-artifacts-analyzer.config.json), not
  // fetched - GitHub exposes no API for the real per-org/per-user limit.
  // Container/GHCR storage is currently unmetered, so it's excluded from
  // the quota column and from the quota-counted total.
  generateStorageOverview(analysis, packagesAnalysis) {
    if (analysis.incomplete) {
      console.log(chalk.bold.red(
        '\n⚠ Incomplete analysis: some GitHub API requests failed. Totals below are partial.'
      ));
    }
    if (packagesAnalysis.incomplete) {
      console.log(chalk.bold.red(
        '\n⚠ Incomplete packages analysis: some GitHub API requests failed. Totals below are partial.'
      ));
      for (const warning of packagesAnalysis.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }

    const title = analysis.organizationName
      ? `🚀 Storage Overview - Organization: ${analysis.organizationName}`
      : '🚀 Storage Overview';
    console.log(chalk.bold.blue(`\n${title}`));
    console.log(chalk.gray('='.repeat(80)));

    const quotaGB = analysis.organizationName
      ? loadConfig().storageQuotaGB.organization
      : loadConfig().storageQuotaGB.user;
    const quotaBytes = quotaGB * 1024 * 1024 * 1024;

    const overviewTable = new Table({
      head: ['Category', 'Packages', 'Artifacts', 'Storage', `% of ${quotaGB} GB quota`],
      style: { head: ['cyan'] }
    });

    overviewTable.push([
      'Actions Artifacts',
      '',
      analysis.summary.totalArtifacts.toLocaleString(),
      this.formatBytes(analysis.summary.totalSizeBytes),
      this.formatQuotaBar(analysis.summary.totalSizeBytes, quotaBytes)
    ]);

    let quotaCountedPackages = 0;
    let quotaCountedBytes = analysis.summary.totalSizeBytes;
    const { summary: packagesSummary } = packagesAnalysis;

    // Types with a size mechanism (exact or estimated) get their own row;
    // types with no size signal at all are collapsed into one "other" row.
    const typesWithSize = [];
    const otherTypes = [];
    for (const [packageType, stats] of Object.entries<any>(packagesSummary.byPackageType)) {
      (stats.sizeKnown || stats.sizeEstimated ? typesWithSize : otherTypes).push(packageType);
    }

    for (const packageType of typesWithSize) {
      const stats = packagesSummary.byPackageType[packageType];
      const countsTowardQuota = !(packageType in PACKAGE_TYPES_EXCLUDED_FROM_QUOTA);
      if (countsTowardQuota) {
        quotaCountedPackages += stats.packageCount;
        quotaCountedBytes += stats.sizeBytes;
      }
      overviewTable.push([
        `Packages: ${packageType}`,
        stats.packageCount.toLocaleString(),
        '',
        this.formatPackageTypeSize(stats),
        countsTowardQuota
          ? this.formatQuotaBar(stats.sizeBytes, quotaBytes)
          : chalk.gray('(excluded - GHCR is unmetered)')
      ]);
    }

    const otherPackageCount = otherTypes.reduce((sum, t) => sum + packagesSummary.byPackageType[t].packageCount, 0);
    quotaCountedPackages += otherPackageCount;
    overviewTable.push([
      `Packages: ${otherTypes.join('/')}`,
      otherPackageCount.toLocaleString(),
      '',
      chalk.gray('—'),
      ''
    ]);

    const totalPackages = packagesSummary.totalPackages;
    const totalStorageBytes = analysis.summary.totalSizeBytes + packagesSummary.totalSizeBytes;

    overviewTable.push([
      chalk.bold('Total (all categories)'),
      chalk.bold(totalPackages.toLocaleString()),
      chalk.bold(analysis.summary.totalArtifacts.toLocaleString()),
      chalk.bold(this.formatBytes(totalStorageBytes)),
      ''
    ]);
    overviewTable.push([
      chalk.bold('Total (counts toward quota)'),
      chalk.bold(quotaCountedPackages.toLocaleString()),
      chalk.bold(analysis.summary.totalArtifacts.toLocaleString()),
      chalk.bold(this.formatBytes(quotaCountedBytes)),
      chalk.bold(this.formatQuotaBar(quotaCountedBytes, quotaBytes))
    ]);

    console.log(overviewTable.toString());

    console.log(chalk.gray(
      `\nNote: quota is a configured assumption (github-artifacts-analyzer.config.json), not fetched ` +
      `from GitHub - no API currently exposes the real per-org/per-user limit. Container/GHCR storage ` +
      `doesn't count against the Packages+Actions quota (currently unmetered) and is excluded above.`
    ));

    if (packagesSummary.packagesWithUnknownSize > 0) {
      console.log(chalk.gray(
        'Note: GitHub does not expose byte sizes for Docker (legacy), NuGet, or RubyGems packages via any ' +
        'documented API. Maven sizes are real byte counts; npm and container (Docker images and Helm ' +
        'charts) sizes are estimated by sampling a subset of each package\'s versions and extrapolating ' +
        '(marked "~").'
      ));
    }
  }

  // Renders a small inline bar + percentage for how much of the quota one
  // category uses. Falls back to a plain percentage with no bar past 100%
  // rather than truncating/wrapping a bar that would otherwise overflow.
  formatQuotaBar(bytes, quotaBytes, width = 20) {
    if (quotaBytes <= 0) return chalk.gray('n/a');

    const fraction = bytes / quotaBytes;
    const percentLabel = `${Math.round(fraction * 100)}%`;

    if (fraction > 1) {
      return `${percentLabel} (over quota)`;
    }

    const filled = Math.round(fraction * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    return `${bar} ${percentLabel}`;
  }

  generateTopRepositoriesReport(analysis, topCount) {
    if (analysis.repositories.length === 0) return;

    console.log(chalk.bold.blue(`\n📊 Top ${topCount} Repositories by Storage Usage`));
    console.log(chalk.gray('='.repeat(80)));

    const topRepos = analysis.repositories
      .filter(r => r.totalSizeBytes > 0)
      .sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
      .slice(0, topCount);

    if (topRepos.length === 0) {
      console.log(chalk.yellow('No repositories with artifacts found.'));
      return;
    }

    const repoTable = new Table({
      head: ['Repository', 'Workflows', 'Artifacts', 'Total Size', 'Active Size', 'Expired Size'],
      style: { head: ['cyan'] },
      colWidths: [30, 12, 12, 15, 15, 15]
    });

    for (const repo of topRepos) {
      const sizeColor = repo.totalSizeBytes > 100 * 1024 * 1024 ? 'red' : repo.totalSizeBytes > 10 * 1024 * 1024 ? 'yellow' : 'white';

      repoTable.push([
        repo.fullName,
        repo.workflows.length.toString(),
        repo.totalArtifacts.toString(),
        chalk[sizeColor](this.formatBytes(repo.totalSizeBytes)),
        this.formatBytes(repo.activeSizeBytes),
        repo.expiredSizeBytes > 0 ? chalk.gray(this.formatBytes(repo.expiredSizeBytes)) : '0 B'
      ]);
    }

    console.log(repoTable.toString());

    // Show detailed artifacts for top repository
    if (topRepos.length > 0 && topRepos[0].artifacts.length > 0) {
      console.log(chalk.bold.blue(`\n🔍 Detailed Artifacts for ${topRepos[0].fullName}`));
      console.log(chalk.gray('='.repeat(80)));

      this.showArtifactDetails(topRepos[0].artifacts.slice(0, 20)); // Show top 20 artifacts
    }

    // Storage recommendations
    this.generateRecommendations(analysis);
  }

  generateTopPackagesReport(packagesAnalysis) {
    const topBySize = packagesAnalysis.packages
      .filter(pkg => pkg.sizeBytes !== null)
      .slice()
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 10);

    if (topBySize.length === 0) return;

    console.log(chalk.bold.blue('\n📊 Top 10 Packages by Storage Used'));
    console.log(chalk.gray('='.repeat(60)));

    const topTable = new Table({
      head: ['Package', 'Type', 'Repository', 'Versions', 'Size'],
      style: { head: ['cyan'] }
    });

    for (const pkg of topBySize) {
      topTable.push([
        pkg.name,
        pkg.packageType,
        pkg.repositoryFullName || chalk.gray('unknown'),
        pkg.versions.length.toLocaleString(),
        this.formatPackageSize(pkg)
      ]);
    }

    console.log(topTable.toString());
  }

  formatPackageTypeSize(stats) {
    if (!stats.sizeKnown) return chalk.gray('unknown');
    return stats.sizeEstimated ? `~${this.formatBytes(stats.sizeBytes)}` : this.formatBytes(stats.sizeBytes);
  }

  formatPackageSize(pkg) {
    if (pkg.sizeBytes === null) return chalk.gray('unknown');
    return pkg.sizeEstimated ? `~${this.formatBytes(pkg.sizeBytes)}` : this.formatBytes(pkg.sizeBytes);
  }

  generateRepositoryTableReport(analysis) {
    console.log(chalk.bold.blue(`\n📊 Repository Analysis: ${analysis.fullName}`));
    console.log(chalk.gray('='.repeat(60)));

    if (analysis.incomplete) {
      console.log(chalk.bold.red(
        `⚠ Incomplete analysis: ${analysis.warnings.length} GitHub API request(s) failed.`
      ));
    }

    if (!analysis.hasWorkflows) {
      console.log(chalk.yellow('No GitHub Actions workflows found in this repository.'));
      return;
    }

    if (analysis.totalArtifacts === 0) {
      console.log(chalk.yellow('No artifacts found in this repository.'));
      return;
    }

    // Repository summary
    const summaryTable = new Table({
      head: ['Metric', 'Value'],
      style: { head: ['cyan'] }
    });

    summaryTable.push(
      ['Workflows', analysis.workflows.length.toString()],
      ['Total Artifacts', analysis.totalArtifacts.toString()],
      ['Total Size', this.formatBytes(analysis.totalSizeBytes)],
      ['Active Artifacts', `${analysis.activeArtifacts} (${this.formatBytes(analysis.activeSizeBytes)})`],
      ['Expired Artifacts', `${analysis.expiredArtifacts} (${this.formatBytes(analysis.expiredSizeBytes)})`]
    );

    console.log(summaryTable.toString());

    // Artifacts details
    if (analysis.artifacts.length > 0) {
      console.log(chalk.bold.blue('\n🔍 Artifacts Details'));
      console.log(chalk.gray('='.repeat(80)));

      this.showArtifactDetails(analysis.artifacts);
    }
  }

  showArtifactDetails(artifacts) {
    const artifactTable = new Table({
      head: ['Name', 'Size', 'Workflow', 'Created', 'Expires', 'Status'],
      style: { head: ['cyan'] },
      colWidths: [25, 12, 20, 12, 12, 10]
    });

    const sortedArtifacts = artifacts
      .sort((a, b) => b.sizeInBytes - a.sizeInBytes);

    for (const artifact of sortedArtifacts) {
      const status = artifact.expired ? chalk.red('Expired') : chalk.green('Active');
      const size = artifact.sizeInBytes > 50 * 1024 * 1024 ? 
        chalk.red(this.formatBytes(artifact.sizeInBytes)) : 
        this.formatBytes(artifact.sizeInBytes);

      artifactTable.push([
        artifact.name.length > 24 ? artifact.name.substring(0, 21) + '...' : artifact.name,
        size,
        artifact.workflowName?.substring(0, 18) || 'Unknown',
        this.formatDate(artifact.createdAt),
        this.formatDate(artifact.expiresAt),
        status
      ]);
    }

    console.log(artifactTable.toString());
  }

  generateJsonReport(analysis, outputFile, packagesAnalysis) {
    const jsonOutput = JSON.stringify({ ...analysis, packages: packagesAnalysis }, null, 2);

    if (outputFile) {
      writeFileSync(outputFile, jsonOutput);
      console.log(chalk.green(`✅ JSON report saved to: ${outputFile}`));
    } else {
      console.log(jsonOutput);
    }
  }

  generateCsvReport(analysis, outputFile, packagesAnalysis) {
    const csvLines = ['Repository,Status,Error,Workflows,Total Artifacts,Total Size (Bytes),Active Artifacts,Active Size (Bytes),Expired Artifacts,Expired Size (Bytes)'];

    for (const repo of analysis.repositories) {
      csvLines.push([
        this.escapeCsv(repo.fullName),
        repo.incomplete ? 'incomplete' : 'complete',
        this.escapeCsv(repo.warnings?.join('; ') || ''),
        repo.workflows.length.toString(),
        repo.totalArtifacts.toString(),
        repo.totalSizeBytes.toString(),
        repo.activeArtifacts.toString(),
        repo.activeSizeBytes.toString(),
        repo.expiredArtifacts.toString(),
        repo.expiredSizeBytes.toString()
      ].join(','));
    }

    for (const skipped of analysis.skippedRepositories || []) {
      csvLines.push([
        this.escapeCsv(skipped.fullName),
        'skipped',
        this.escapeCsv(skipped.reason),
        '', '', '', '', '', '', ''
      ].join(','));
    }

    csvLines.push('');
    csvLines.push('Package,Type,Repository,Versions,Size (Bytes),Size Known,Size Estimated');
    for (const pkg of packagesAnalysis.packages) {
      csvLines.push([
        this.escapeCsv(pkg.name),
        pkg.packageType,
        this.escapeCsv(pkg.repositoryFullName || ''),
        pkg.versions.length.toString(),
        (pkg.sizeBytes ?? '').toString(),
        (pkg.sizeBytes !== null).toString(),
        (pkg.sizeEstimated ?? false).toString()
      ].join(','));
    }

    const csvOutput = csvLines.join('\n');

    if (outputFile) {
      writeFileSync(outputFile, csvOutput);
      console.log(chalk.green(`✅ CSV report saved to: ${outputFile}`));
    } else {
      console.log(csvOutput);
    }
  }

  generateRepositoryCsvReport(analysis) {
    const csvLines = ['Name,Size (Bytes),Workflow,Created,Expires,Expired'];
    
    for (const artifact of analysis.artifacts) {
      csvLines.push([
        artifact.name,
        artifact.sizeInBytes.toString(),
        artifact.workflowName || 'Unknown',
        artifact.createdAt.toISOString(),
        artifact.expiresAt.toISOString(),
        artifact.expired.toString()
      ].join(','));
    }

    console.log(csvLines.join('\n'));
  }

  escapeCsv(value) {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  generateRecommendations(analysis) {
    console.log(chalk.bold.blue('\n💡 Storage Optimization Recommendations'));
    console.log(chalk.gray('='.repeat(60)));

    const recommendations = [];

    // High storage repositories
    const highStorageRepos = analysis.repositories
      .filter(r => r.activeSizeBytes > 100 * 1024 * 1024) // > 100MB
      .sort((a, b) => b.activeSizeBytes - a.activeSizeBytes);

    if (highStorageRepos.length > 0) {
      recommendations.push(`🔍 Review high-storage repositories: ${highStorageRepos.slice(0, 3).map(r => r.fullName).join(', ')}`);
    }

    // Expired artifacts
    if (analysis.summary.expiredSizeBytes > 0) {
      recommendations.push(`🗑️  Clean up expired artifacts to save ${this.formatBytes(analysis.summary.expiredSizeBytes)}`);
    }

    // Old artifacts
    const oldArtifacts = analysis.repositories
      .flatMap(r => r.artifacts)
      .filter(a => !a.expired && this.daysSince(a.createdAt) > 30)
      .reduce((sum, a) => sum + a.sizeInBytes, 0);

    if (oldArtifacts > 0) {
      recommendations.push(`📅 Consider cleaning artifacts older than 30 days: ${this.formatBytes(oldArtifacts)} potential savings`);
    }

    // Large single artifacts
    const largeArtifacts = analysis.repositories
      .flatMap(r => r.artifacts)
      .filter(a => !a.expired && a.sizeInBytes > 50 * 1024 * 1024)
      .length;

    if (largeArtifacts > 0) {
      recommendations.push(`📦 ${largeArtifacts} artifacts are larger than 50MB - consider optimizing build outputs`);
    }

    if (recommendations.length === 0) {
      console.log(chalk.green('✅ Your artifact storage looks well optimized!'));
    } else {
      for (let i = 0; i < recommendations.length; i++) {
        console.log(chalk.yellow(`${i + 1}. ${recommendations[i]}`));
      }
    }

    // Quick cleanup commands
    if (analysis.summary.expiredSizeBytes > 0) {
      console.log(chalk.bold.blue('\n⚡ Quick Cleanup Commands'));
      console.log(chalk.gray('='.repeat(40)));
      console.log(chalk.gray('To delete expired artifacts, you can use the GitHub CLI:'));
      console.log(chalk.white('gh api -X DELETE /repos/OWNER/REPO/actions/artifacts/ARTIFACT_ID'));
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDate(date) {
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: '2-digit',
      year: '2-digit'
    });
  }

  daysSince(date) {
    return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  }

  async runCleanupMode(analysis, analyzer) {
    console.log(chalk.bold.blue('\n🧹 Interactive Cleanup Mode'));
    console.log(chalk.gray('='.repeat(60)));
    
    // Find repositories with artifacts
    const reposWithArtifacts = analysis.repositories
      .filter(r => r.totalArtifacts > 0)
      .sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);

    if (reposWithArtifacts.length === 0) {
      console.log(chalk.green('✅ No repositories with artifacts found. Nothing to clean up!'));
      return;
    }

    console.log(`\nFound ${reposWithArtifacts.length} repositories with artifacts:\n`);

    for (const repo of reposWithArtifacts) {
      console.log(chalk.cyan(`📁 ${repo.fullName}`));
      console.log(`   Artifacts: ${repo.totalArtifacts} | Total Size: ${this.formatBytes(repo.totalSizeBytes)}`);
      console.log(`   Active: ${repo.activeArtifacts} (${this.formatBytes(repo.activeSizeBytes)}) | Expired: ${repo.expiredArtifacts} (${this.formatBytes(repo.expiredSizeBytes)})\n`);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (analysis.organizationName) {
      const totalArtifacts = reposWithArtifacts.reduce((sum, r) => sum + r.totalArtifacts, 0);
      const totalSizeBytes = reposWithArtifacts.reduce((sum, r) => sum + r.totalSizeBytes, 0);

      const confirmation: string = await this.askQuestion(rl,
        chalk.bold.red(
          `\n⚠ You are about to review cleanup for ${reposWithArtifacts.length} repositories ` +
          `(${totalArtifacts} artifacts, ${this.formatBytes(totalSizeBytes)}) in organization '${analysis.organizationName}'.\n` +
          `Continue? [y/N]: `
        )
      );

      if (confirmation.toLowerCase() !== 'y' && confirmation.toLowerCase() !== 'yes') {
        console.log(chalk.yellow('Cleanup cancelled.'));
        rl.close();
        return;
      }
    }

    for (const repo of reposWithArtifacts) {
      await this.runRepositoryCleanup(repo, analyzer, rl);
    }

    rl.close();
    console.log(chalk.green('\n🎉 Cleanup complete!'));
  }

  async runRepositoryCleanup(repo, analyzer, rl = null) {
    const shouldCloseRL = !rl;
    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
    }

    console.log(chalk.bold.blue(`\n🧹 Cleanup for ${repo.fullName}`));
    console.log(chalk.gray('='.repeat(50)));

    if (repo.totalArtifacts === 0) {
      console.log(chalk.green('✅ No artifacts to clean up!'));
      if (shouldCloseRL) rl.close();
      return;
    }

    // Show current state
    const expiredArtifacts = repo.artifacts.filter(a => a.expired);
    const activeArtifacts = repo.artifacts.filter(a => !a.expired);
    const oldActiveArtifacts = activeArtifacts.filter(a => this.daysSince(a.createdAt) > 30);

    console.log(`\n📊 Current State:`);
    console.log(`   Total: ${repo.totalArtifacts} artifacts (${this.formatBytes(repo.totalSizeBytes)})`);
    console.log(`   Expired: ${expiredArtifacts.length} artifacts (${this.formatBytes(repo.expiredSizeBytes)})`);
    console.log(`   Old (>30 days): ${oldActiveArtifacts.length} artifacts (${this.formatBytes(oldActiveArtifacts.reduce((sum, a) => sum + a.sizeInBytes, 0))})`);

    // Cleanup expired artifacts
    if (expiredArtifacts.length > 0) {
      console.log(chalk.yellow(`\n🗑️  EXPIRED ARTIFACTS (${expiredArtifacts.length} artifacts)`));
      for (const artifact of expiredArtifacts.slice(0, 5)) {
        console.log(`   ${artifact.name} - ${this.formatBytes(artifact.sizeInBytes)} (${this.formatDate(artifact.createdAt)})`);
      }
      if (expiredArtifacts.length > 5) {
        console.log(`   ... and ${expiredArtifacts.length - 5} more`);
      }

      const deleteExpired: string = await this.askQuestion(rl, 
        `\n❓ Delete all ${expiredArtifacts.length} expired artifacts? (saves ${this.formatBytes(repo.expiredSizeBytes)}) [y/N]: `
      );

      if (deleteExpired.toLowerCase() === 'y' || deleteExpired.toLowerCase() === 'yes') {
        console.log('🗑️ Deleting expired artifacts...');
        let deleted = 0;
        for (const artifact of expiredArtifacts) {
          process.stdout.write(`   Deleting ${artifact.name} (${this.formatBytes(artifact.sizeInBytes)})... `);
          const success = await analyzer.deleteArtifact(repo.owner, repo.name, artifact.id);
          if (success) {
            console.log(chalk.green('✓'));
            deleted++;
          } else {
            console.log(chalk.red('✗'));
          }
        }
        console.log(chalk.green(`✅ Deleted ${deleted}/${expiredArtifacts.length} expired artifacts`));
      }
    }

    // Cleanup old active artifacts
    if (oldActiveArtifacts.length > 0) {
      console.log(chalk.yellow(`\n📅 OLD ACTIVE ARTIFACTS (${oldActiveArtifacts.length} artifacts)`));
      console.log('Consider deleting artifacts older than 30 days:');
      
      const sortedOld = oldActiveArtifacts
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, 10);
      
      for (const artifact of sortedOld) {
        console.log(`   ${artifact.name} - ${this.formatBytes(artifact.sizeInBytes)} (${this.formatDate(artifact.createdAt)}, ${this.daysSince(artifact.createdAt)} days ago)`);
      }
      if (oldActiveArtifacts.length > 10) {
        console.log(`   ... and ${oldActiveArtifacts.length - 10} more`);
      }

      const totalOldSize = oldActiveArtifacts.reduce((sum, a) => sum + a.sizeInBytes, 0);
      const deleteOld: string = await this.askQuestion(rl,
        `\n❓ Delete old active artifacts (>30 days)? (saves ${this.formatBytes(totalOldSize)}) [y/N]: `
      );

      if (deleteOld.toLowerCase() === 'y' || deleteOld.toLowerCase() === 'yes') {
        console.log('🗑️ Deleting old active artifacts...');
        let deleted = 0;
        for (const artifact of oldActiveArtifacts) {
          process.stdout.write(`   Deleting ${artifact.name} (${this.formatBytes(artifact.sizeInBytes)})... `);
          const success = await analyzer.deleteArtifact(repo.owner, repo.name, artifact.id);
          if (success) {
            console.log(chalk.green('✓'));
            deleted++;
          } else {
            console.log(chalk.red('✗'));
          }
        }
        console.log(chalk.green(`✅ Deleted ${deleted}/${oldActiveArtifacts.length} old artifacts`));
      }
    }

    // Show recommendations
    console.log(chalk.blue('\n💡 Future Prevention Tips:'));
    console.log('   • Set shorter retention in workflows: retention-days: 7');
    console.log('   • Only upload essential artifacts');
    console.log('   • Use artifact cleanup actions');
    console.log('   • Monitor storage regularly');

    if (shouldCloseRL) rl.close();
  }

  askQuestion(rl: readline.Interface, question: string): Promise<string> {
    return new Promise(resolve => {
      rl.question(question, answer => {
        resolve(answer.trim());
      });
    });
  }
}

export { ReportGenerator };