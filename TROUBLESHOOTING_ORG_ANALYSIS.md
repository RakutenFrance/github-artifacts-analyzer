# Troubleshooting Organization Analysis

## Your Specific Issue

### What You're Seeing:
```
⚠ Skipped (Access forbidden - token may lack actions:read scope or repo requires SSO authorization)
...
✖ Analysis failed
Error: Access forbidden - check token has read:org permission
```

### Root Cause:

Your output shows **TWO different issues**:

#### 1. **Many repos skipped with 403 errors** (Lines with "⚠ Skipped")
- The token **CAN** list organization repositories ✅
- The token **CANNOT** access GitHub Actions in ~70% of your repos ❌
- This is likely due to:
  - Missing `actions:read` scope on the token
  - **SSO (Single Sign-On) authorization** not enabled for those specific repos
  - Individual repository settings restricting Actions access

#### 2. **Final error about `read:org` permission**
- This happens when fetching **additional pages** of repositories
- After checking 100+ repos, GitHub's API returns 403 on pagination
- Could be:
  - Rate limiting kicking in
  - SSO authorization timeout
  - Secondary permission check failing

## Solutions

### Solution 1: Check Token Scopes (Most Likely)

```bash
# Check your token scopes
gh auth status

# Should include:
# - repo
# - read:user
# - read:org
# - actions:read  ← Make sure this is present!
```

If `actions:read` is missing, recreate your token with all required scopes:
- `repo`
- `read:user`
- `read:org`
- `actions:read` ⭐

### Solution 2: Enable SSO Authorization (Very Likely for Private Orgs)

If your organization uses SSO (Single Sign-On):

1. Go to: https://github.com/settings/tokens
2. Find your token
3. Click "Configure SSO"
4. Click "Authorize" next to **RakutenFrance**
5. Complete SSO authentication

**This is the most common issue with enterprise GitHub organizations!**

### Solution 3: Check Organization Settings

Your organization admins may have restricted Actions access:

1. Organization Settings → Actions → General
2. Check if "Read access to actions and workflows" is enabled for members
3. You may need admin approval to access Actions data

### Solution 4: Use a Different Token Type

Instead of Personal Access Token (classic), try:

1. **Fine-grained Personal Access Token** with specific permissions
2. **GitHub App** with Actions read permissions
3. **Organization-level token** with full access

## Verification Steps

### Step 1: Test with a single repo you know works
```bash
gh api repos/RakutenFrance/next-common/actions/workflows
```

If this fails with 403 → Token issue
If this works → Issue is with bulk operations

### Step 2: Check rate limits
```bash
gh api rate_limit
```

Look for:
- `resources.core.remaining` - Should be > 0
- `resources.search.remaining` - Should be > 0

### Step 3: Test organization access
```bash
gh api orgs/RakutenFrance
```

Should return organization details without error.

### Step 4: Test Actions access on failing repo
```bash
gh api repos/RakutenFrance/canopy-tech-ws/actions/workflows
```

If 403 → That specific repo requires SSO or has Actions disabled

## Expected Behavior After Fix

With proper permissions, you should see:

```
✓ Found 59 artifacts (445.64 MB)
✓ Found 299 artifacts (520.5 KB)
✓ Found 106 artifacts (681.62 KB)
...
✅ Analysis complete!

🚀 GitHub Artifacts Analysis - Organization: RakutenFrance
```

Instead of many "⚠ Skipped" messages.

## Temporary Workaround

If you cannot get full access, analyze repos individually:

```bash
# Analyze repos you DO have access to
github-artifacts repo RakutenFrance next-common
github-artifacts repo RakutenFrance merchant-test-automation
```

Or create a list of accessible repos and batch process them.

## Technical Details

### Why Individual Repos Fail but Org Listing Works:

GitHub has **layered permissions**:

1. **Organization level** (`read:org`) - List repos, members, teams ✅
2. **Repository level** (`repo`) - Access repo content ✅
3. **Actions level** (`actions:read`) - Access workflow runs/artifacts ❌ (Your issue)
4. **SSO layer** - Enterprise organizations add another auth layer ❌ (Likely your issue)

A token can pass levels 1-2 but fail at 3-4 for specific repositories.

### The 403 on Pagination:

After checking many repos (100+ in your case), GitHub's API:
- May hit secondary rate limits
- May require SSO re-authorization
- May have per-page permission checks

The improved error handling now catches this and shows partial results instead of failing completely.

## Recommended Actions

### Immediate:
1. ✅ Check token has `actions:read` scope
2. ✅ Enable SSO authorization for RakutenFrance organization
3. ✅ Test with a single known-good repo first

### Short-term:
1. Contact GitHub org admins about Actions permissions
2. Verify individual repository settings
3. Consider using GitHub App instead of PAT

### Long-term:
1. Document required scopes for your team
2. Set up organization-wide Actions access policies
3. Create service account with proper permissions

## Error Message Reference

| Error | Meaning | Solution |
|-------|---------|----------|
| `Access forbidden - token may lack actions:read scope` | Token cannot access Actions in this repo | Add `actions:read` scope or enable SSO |
| `Organization not found or no access` | Cannot list org repos | Add `read:org` scope |
| `Rate limit reached` | Too many API calls | Wait or use authenticated requests |
| `Repository not found or no access` | Repo doesn't exist or token lacks `repo` scope | Check repo name and token scopes |

## Need More Help?

Check your token permissions:
```bash
gh api user -i | grep x-oauth-scopes
```

This shows exactly what scopes your current token has.
