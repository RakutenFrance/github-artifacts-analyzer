# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript CLI tool that analyzes GitHub Actions artifacts and storage usage across repositories and organizations. It helps users identify storage consumption, find expired artifacts, and provides interactive cleanup functionality.

## Build and Run Commands

### Essential Commands
```bash
# Build TypeScript to JavaScript (REQUIRED after any code changes)
npm run build

# Run the built version
npm run start -- <command> [options]

# Build and run (development)
npm run dev -- <command> [options]

# Quick analysis of authenticated user's repos
npm run analyze
```

### Testing Commands
```bash
# Analyze specific repository
npm run start -- repo <owner> <repo>

# Analyze organization (requires read:org scope and SSO auth if applicable)
npm run start -- analyze-org <org-name> --delay 500

# Analyze user repositories
npm run start -- analyze --username <username>

# Test with cleanup mode (interactive)
npm run start -- analyze --cleanup
```

## Architecture

### Core Components

**1. `analyzer.ts` - GitHubArtifactsAnalyzer class**
- Main analysis engine that interfaces with GitHub API via Octokit
- Handles three analysis modes: user repositories, organization repositories, and single repository
- Implements rate limiting with exponential backoff (see Rate Limiting section)
- Key methods:
  - `analyzeRepository()`: Core artifact analysis for a single repo
  - `analyzeAllRepositories()`: Scans all user repositories
  - `analyzeOrganizationRepositories()`: Scans all org repositories
  - `sleepWithBackoff()`: Implements exponential backoff based on `consecutiveErrors` counter

**2. `reporter.ts` - ReportGenerator class**
- Handles all output formatting (table, JSON, CSV)
- Provides interactive cleanup mode with prompts
- Generates storage optimization recommendations
- Key methods:
  - `generateReport()`: Formats and outputs analysis results
  - `runCleanupMode()`: Interactive artifact deletion workflow
  - `generateRecommendations()`: Suggests storage optimizations

**3. `index.ts` - CLI Entry Point**
- Uses Commander.js for CLI argument parsing
- Defines three commands: `analyze`, `repo`, `analyze-org`
- Wires together analyzer and reporter components

**4. `types.ts` - TypeScript Definitions**
- Defines all interfaces for analysis data structures
- Key types: `RepositoryAnalysis`, `AnalysisResult`, `ArtifactInfo`, `AnalysisSummary`

### Rate Limiting Architecture

The tool implements a sophisticated rate limiting system to handle GitHub API constraints:

- **Configurable base delay**: Set via `--delay` option (default 100ms)
- **Exponential backoff**: Automatically increases delay when consecutive errors occur:
  - 0 errors: normal delay
  - 1-2 errors: 2x delay
  - 3-4 errors: 4x delay
  - 5+ errors: 8x delay (max)
- **Error tracking**: `consecutiveErrors` counter in analyzer resets on success
- **Error detection**: Monitors for 403/429 status codes (rate limiting and permission errors)

When analyzing organizations with many repositories, use `--delay 500` or `--delay 1000` to avoid hitting rate limits.

### GitHub API Integration

**Authentication Requirements:**
- Token must have: `repo`, `read:user`, `actions:read`, `read:org` scopes
- Organization analysis requires SSO authorization if org has SSO enabled
- Token passed via `GITHUB_TOKEN` env var or `--token` flag

**API Call Pattern:**
1. List repositories (paginated, 100 per page)
2. For each repository:
   - List workflows
   - For each workflow: List workflow runs (limited to 100)
   - For each run: List artifacts
3. Aggregate and analyze data

**Error Handling:**
- 403 errors: Permission issues or rate limiting
- 404 errors: Repository not found or no access
- 429 errors: Explicit rate limit exceeded
- Graceful degradation: Continues with partial results when pagination hits limits

## Important Development Notes

### TypeScript Compilation

**CRITICAL**: This project uses TypeScript with ES modules. Always run `npm run build` after making changes to `src/` files. The compiled JavaScript in `dist/` is what actually executes.

### Rate Limit Debugging

If you encounter "Access forbidden" errors during organization analysis:

1. Check if it's actually rate limiting (not permissions):
   ```bash
   gh api rate_limit
   ```

2. Look for `remaining: 0` in the output - this means rate limited, NOT a permission error

3. The error message at `src/analyzer.ts:281` can be misleading when rate limited

### Cleanup Mode

The interactive cleanup mode (`--cleanup` flag) uses readline for prompts. It:
- NEVER deletes without explicit user confirmation
- Categories: expired artifacts, old active artifacts (>30 days)
- Implements 250ms delay between deletions for rate limit protection
- Reuses readline interface across multiple repositories for better UX

## Authentication and Permissions

**For organization analysis:**
1. Token must have `read:org` scope
2. If organization uses SSO, authorize token at: https://github.com/settings/tokens
3. Click "Configure SSO" and authorize for the specific organization

**Common permission errors:**
- "Access forbidden - check token has read:org permission" at line 281 can also indicate rate limiting (check with `gh api rate_limit`)
- "Repository not found or no access" at line 443 means token lacks `repo` or `actions:read` scope

## Output Formats

- **table** (default): Colorized CLI tables with recommendations
- **json**: Structured data for programmatic use
- **csv**: Spreadsheet-compatible format

JSON/CSV output can be saved with `--output <file>` option.
