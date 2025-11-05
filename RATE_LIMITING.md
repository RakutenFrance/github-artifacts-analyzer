# Rate Limiting and Performance Tuning

This document explains how the GitHub Artifacts Analyzer handles rate limiting and how you can optimize performance.

## Understanding GitHub API Rate Limits

GitHub API has the following rate limits:

- **Authenticated requests**: 5,000 requests per hour
- **Search API**: 30 requests per minute
- **Secondary rate limits**: Triggered by rapid successive requests

When analyzing organizations with many repositories, you may encounter these limits.

## Built-in Rate Limiting Features

### 1. Configurable Delay (New!)

Control the delay between repository checks using the `--delay` option:

```bash
# Default: 100ms between repos
github-artifacts analyze-org my-org

# Conservative: 500ms between repos (recommended for large orgs)
github-artifacts analyze-org my-org --delay 500

# Very conservative: 1 second between repos
github-artifacts analyze-org my-org --delay 1000

# Fast (risky): 50ms between repos
github-artifacts analyze-org my-org --delay 50
```

### 2. Automatic Exponential Backoff (New!)

The tool automatically detects when you're hitting rate limits and slows down:

- **No errors**: Normal delay (your `--delay` value)
- **1-2 consecutive errors**: 2x delay
- **3-4 consecutive errors**: 4x delay
- **5+ consecutive errors**: 8x delay (max)
- **Success**: Resets back to normal delay

You'll see messages like:
```
⏱ Slowing down (delay: 400ms) due to errors...
```

### 3. Graceful Error Handling

When rate limits are hit during pagination:
- Continues with partial results instead of failing completely
- Shows clear messages about what was analyzed
- Provides actionable troubleshooting steps

## Recommended Delay Values

| Scenario | Recommended `--delay` | Estimated Time |
|----------|----------------------|----------------|
| Small org (<20 repos) | 100ms (default) | ~2 seconds |
| Medium org (20-50 repos) | 250ms | ~12 seconds |
| Large org (50-100 repos) | 500ms | ~50 seconds |
| Very large org (100+ repos) | 1000ms | ~2 minutes |
| Already hitting rate limits | 2000ms+ | Slower but reliable |

## Calculating API Usage

Each repository check uses approximately:
- **1 request**: List workflows
- **N requests**: List workflow runs (N = number of workflows)
- **M requests**: List artifacts (M = number of runs per workflow, limited to 100)

Example for 50 repositories with average 2 workflows each:
- Minimum: 50 + (50 × 2) = 150 requests
- Maximum: 50 + (50 × 2) + (50 × 2 × 100) = 10,150 requests

With 5,000 requests/hour limit, you can analyze approximately:
- **33 repositories** with full history every hour
- **~500 repositories** with minimal workflows every hour

## Performance Tips

### 1. Use Appropriate Delays for Your Situation

```bash
# If you're not in a hurry and want to be safe
github-artifacts analyze-org my-org --delay 500

# If you need results quickly and have rate limit budget
github-artifacts analyze-org my-org --delay 100

# If you're already seeing errors
github-artifacts analyze-org my-org --delay 1000
```

### 2. Filter to Reduce API Calls

```bash
# Only active artifacts (skips expired ones)
github-artifacts analyze-org my-org --delay 250

# Exclude forks (fewer repos to check)
github-artifacts analyze-org my-org --delay 250

# Both filters combined
github-artifacts analyze-org my-org --delay 250
```

### 3. Check Rate Limit Status

Before running analysis:
```bash
# Check current rate limit status
gh api rate_limit

# Look for these values:
# - resources.core.remaining: Should be > 1000 for large orgs
# - resources.core.reset: When limit resets (Unix timestamp)
```

### 4. Schedule Analysis During Off-Peak Hours

If you have automated analysis:
```bash
# Run during off-peak hours when API usage is lower
# Example cron: 2 AM daily
0 2 * * * /usr/bin/github-artifacts analyze-org my-org --delay 500 --output /tmp/results.json
```

## Troubleshooting Rate Limit Issues

### Symptom: Many "Access forbidden" Errors

```
⚠ Skipped (Access forbidden - token may lack actions:read scope or repo requires SSO authorization)
```

**Possible Causes:**
1. **Not rate limiting** - Token permissions issue (see TROUBLESHOOTING_ORG_ANALYSIS.md)
2. **Secondary rate limits** - Too many rapid requests

**Solution:**
```bash
# Increase delay significantly
github-artifacts analyze-org my-org --delay 2000
```

### Symptom: "Rate limit reached" Message

```
⚠ Rate limit reached at page 2. Analyzed 50 repositories.
```

**Solution:**
1. Wait for rate limit to reset:
   ```bash
   gh api rate_limit | grep reset
   ```

2. Use a longer delay on retry:
   ```bash
   github-artifacts analyze-org my-org --delay 1000
   ```

### Symptom: Automatic Slowdown Not Helping

```
⏱ Slowing down (delay: 800ms) due to errors...
⚠ Skipped (Access forbidden...)
⏱ Slowing down (delay: 800ms) due to errors...
```

**This is NOT rate limiting**. See TROUBLESHOOTING_ORG_ANALYSIS.md for permission issues.

## Advanced: Monitoring API Usage

### Check Rate Limit in Real-Time

```bash
# Before analysis
gh api rate_limit -q '.resources.core | {remaining, limit, reset: (.reset | strftime("%Y-%m-%d %H:%M:%S"))}'

# After analysis
gh api rate_limit -q '.resources.core | {remaining, limit, reset: (.reset | strftime("%Y-%m-%d %H:%M:%S"))}'
```

### Calculate Optimal Delay

```python
# Python script to calculate delay
import requests

response = requests.get('https://api.github.com/rate_limit',
                       headers={'Authorization': f'token YOUR_TOKEN'})
data = response.json()

remaining = data['resources']['core']['remaining']
reset_time = data['resources']['core']['reset']
current_time = time.time()

seconds_until_reset = reset_time - current_time
safe_requests = remaining * 0.8  # Use 80% of remaining
delay_ms = (seconds_until_reset / safe_requests) * 1000

print(f"Recommended delay: {int(delay_ms)}ms")
```

## Best Practices Summary

1. ✅ **Start conservative**: Use `--delay 500` for first run
2. ✅ **Monitor errors**: Watch for slowdown messages
3. ✅ **Check limits**: Run `gh api rate_limit` before large analyses
4. ✅ **Filter wisely**: Exclude forks and expired artifacts when possible
5. ✅ **Schedule smartly**: Run during off-peak hours for automated analysis
6. ✅ **Trust the backoff**: The tool will automatically slow down when needed
7. ✅ **Increase delay**: If seeing many errors, double the delay value

## Example Workflows

### Safe Organization Analysis
```bash
# Conservative approach for first-time analysis
github-artifacts analyze-org my-company \
  --delay 500 \
  --top 20 \
  --format json \
  --output results.json
```

### Fast User Analysis
```bash
# Faster for small personal repos
github-artifacts analyze \
  --delay 100 \
  --top 10
```

### Robust Large Organization Analysis
```bash
# Very safe for huge orgs with 100+ repos
github-artifacts analyze-org enterprise-org \
  --delay 1000 \
  --include-forks \
  --format csv \
  --output enterprise-results.csv
```

## When to Contact Support

If you're still experiencing issues after:
- Increasing delay to 2000ms+
- Verifying token permissions
- Checking rate limits show available quota
- Enabling SSO authorization

Then the issue may be with GitHub's API or your organization's security policies. Contact your GitHub organization admins or GitHub support.
