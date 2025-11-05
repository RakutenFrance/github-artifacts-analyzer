# Organization Support Implementation

This document describes the organization support feature added to the GitHub Artifacts Analyzer.

## Overview

The tool now supports analyzing GitHub Actions artifacts for entire organizations, not just individual users.

## What Was Added

### 1. Type Definitions (`src/types.ts`)
- Created comprehensive TypeScript interfaces for type safety
- `AnalysisOptions`, `OrganizationInfo`, `RepositoryAnalysis`, `AnalysisResult`, etc.

### 2. Analyzer Methods (`src/analyzer.ts`)

#### New Methods:
- **`listUserOrganizations()`**: Lists all organizations the authenticated user belongs to
- **`analyzeOrganizationRepositories(orgName, options)`**: Analyzes all repositories in a specific organization
- **`analyzeAllUserAndOrgRepositories(username, options)`**: Combines user repos + all org memberships
- **`checkOrganizationAccess(orgName)`**: Validates access to an organization

#### Updated Methods:
- **`analyzeAllRepositories()`**: Now supports `excludeOrgs` and `includeForks` options

### 3. CLI Commands (`src/index.ts`)

#### New Command:
```bash
github-artifacts analyze-org <org> [options]
```

Options:
- `-f, --format <format>`: Output format (table|json|csv)
- `-o, --output <file>`: Output file path
- `--include-expired`: Include expired artifacts
- `--min-size <bytes>`: Minimum artifact size filter
- `--top <count>`: Show top N repositories
- `--cleanup`: Interactive cleanup mode
- `--include-forks`: Include forked repositories

#### Updated Command:
```bash
github-artifacts analyze [options]
```

New options:
- `--include-orgs`: Include repositories from user organizations
- `--include-forks`: Include forked repositories

### 4. Reporter Updates (`src/reporter.ts`)
- Updated to display organization name in summary when analyzing organizations
- No changes needed for cleanup or other reporting functionality

### 5. Documentation Updates (`README.md`)
- Added `read:org` to required token permissions
- Added organization analysis examples
- Added new command options documentation
- Added troubleshooting for organization-specific errors
- Updated roadmap (checked off organization support)

## Usage Examples

### Analyze a Specific Organization
```bash
# Basic analysis
github-artifacts analyze-org my-company-org

# With options
github-artifacts analyze-org my-org --include-forks --top 20 --format json

# Cleanup mode
github-artifacts analyze-org my-org --cleanup
```

### Analyze User + All Organizations
```bash
# Include all repos from user and their organizations
github-artifacts analyze --include-orgs

# With specific user
github-artifacts analyze --username myuser --include-orgs
```

## Token Permissions

The following GitHub token scopes are now required:
- `repo` - Full control of private repositories
- `read:user` - Read access to user profile data
- `actions:read` - Read access to actions and workflows
- `read:org` - **NEW**: Read organization membership (required for org analysis)

## Implementation Details

### API Endpoints Used:
- `GET /user/orgs` - List organizations for authenticated user
- `GET /orgs/{org}/repos` - List repositories for an organization
- `GET /orgs/{org}` - Check organization access

### Error Handling:
- 404 errors: Organization not found or no access
- 403 errors: Token lacks required permissions
- SSO organizations: Clear error messages about token authorization

### Rate Limiting:
- 100ms delay between repository checks
- Respects GitHub API rate limits
- Same throttling strategy as user repository analysis

## Testing

Verified functionality:
- ✅ Type definitions compile correctly
- ✅ All new methods are accessible
- ✅ CLI commands registered properly
- ✅ Help documentation displays correctly
- ✅ Can list user organizations
- ✅ Code builds without TypeScript errors

## Future Enhancements

Possible improvements:
- Add organization member filtering
- Support for organization teams
- Parallel organization analysis
- Organization-level storage quotas
- Detailed permission checks before analysis
