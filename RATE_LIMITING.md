# Rate Limiting and API Management

This document explains how the GitHub Artifacts Analyzer automatically handles GitHub API rate limiting.

## Understanding GitHub API Rate Limits

GitHub API has the following rate limits:

- **Authenticated requests**: 5,000 requests per hour
- **Search API**: 30 requests per minute
- **Secondary rate limits**: Triggered by rapid successive requests

When analyzing organizations with many repositories, you may encounter these limits.

## Automatic Rate Limit Handling

The tool automatically detects and handles rate limiting without requiring any manual configuration.

### How It Works

1. **Error Detection**: When a 403 or 429 error occurs, the tool checks if it's a rate limit issue
2. **API Status Check**: Queries the GitHub API to get the current rate limit status
3. **Smart Waiting**: If rate limited, calculates the exact time until the limit resets
4. **Clear Feedback**: Displays a message showing when the limit will reset and how long to wait
5. **Automatic Resumption**: Continues operations once the rate limit resets

### What You'll See

When the tool encounters rate limiting:

```
⚠ Error detected (403 Forbidden)
⏳ Rate limit exceeded. Waiting until 3:45:30 PM (12 minutes)...
```

After the wait period:

```
✓ Rate limit reset. Resuming operations...
```

The tool then continues processing from where it left off.

## Rate Limit Best Practices

### Check Your Rate Limit Status

You can manually check your current rate limit status:

```bash
gh api rate_limit
```

This shows:
- How many requests you have remaining
- When your rate limit resets
- Rate limits for different API endpoints

### Understanding Rate Limit Usage

Different operations consume different amounts of rate limit:

- **Listing repositories**: 1 request per page (100 repos per page)
- **Listing workflows**: 1 request per repository
- **Listing workflow runs**: 1 request per workflow
- **Listing artifacts**: 1 request per workflow run

For a large organization with many repositories and workflows, this can add up quickly.

### Optimizing Your Analysis

**For large organizations:**
- The tool will automatically handle rate limiting
- Large scans may take time if rate limits are hit
- Consider running analysis during off-peak hours

**For frequent analysis:**
- GitHub resets rate limits every hour
- Plan your analysis runs to work within the 5,000 requests/hour limit
- Use filters like `--min-size` to reduce processing

**For automation:**
- When running in CI/CD or scheduled jobs, the tool will pause and wait for rate limit resets
- Ensure your job timeout is long enough to accommodate potential rate limit waits (typically up to 60 minutes)

## Troubleshooting

### "Still seeing errors after rate limit should be reset"

If you continue seeing errors after the tool says it waited:
1. Check if it's actually a permission issue, not a rate limit
2. Verify your token has the required scopes: `repo`, `read:user`, `actions:read`, `read:org`
3. For organizations with SSO, ensure your token is authorized

### "Rate limit resets too frequently"

If you're hitting rate limits very quickly:
1. You might be running multiple tools/scripts using the same token
2. Check what else is consuming your rate limit: `gh api rate_limit`
3. Consider using a different token for different automation tasks

### "Want to see rate limit information"

The tool automatically handles rate limiting, but if you want visibility:
1. Check rate limit before running: `gh api rate_limit`
2. Monitor the tool's output for rate limit messages
3. The tool will clearly indicate when it's waiting for rate limits

## Technical Details

### Rate Limit Detection

The tool uses Octokit's `rateLimit.get()` API to check the current rate limit status:

```typescript
const { data: rateLimit } = await this.octokit.rateLimit.get();
const remaining = rateLimit.resources.core.remaining;
const resetAt = new Date(rateLimit.resources.core.reset * 1000);
```

### Wait Calculation

When rate limited, the tool calculates the precise wait time:

```typescript
const waitMs = resetAt.getTime() - new Date().getTime();
```

It then pauses execution until the reset time, plus a 1-second buffer to ensure the limit has actually reset.

### Error Recovery

After waiting for a rate limit reset:
- The consecutive error counter is reset
- The tool continues processing from where it stopped
- No data is lost or re-fetched unnecessarily

## Summary

The GitHub Artifacts Analyzer handles rate limiting automatically:

✅ **No configuration needed** - works out of the box
✅ **Intelligent detection** - distinguishes rate limits from other errors
✅ **Precise waiting** - waits exactly until rate limit resets
✅ **Clear feedback** - tells you what's happening and when it will resume
✅ **Automatic recovery** - continues seamlessly after rate limit resets

You don't need to manually tune delays or worry about hitting rate limits. The tool handles everything automatically.
