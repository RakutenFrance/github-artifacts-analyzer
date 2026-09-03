import { existsSync, readFileSync } from 'fs';

// GitHub has no API for the real storage quota (the billing endpoint that
// used to expose it is deprecated, and its replacement needs admin:org
// scope this tool doesn't otherwise require) and the real limit is
// plan-tiered, not a flat number, so there's nothing to fetch and no way to
// detect which plan an org/user is on. These are reasonable guesses to
// override via config, not a discovered fact - Free tier is 500MB, which
// isn't realistic for anything worth running this tool against.
const DEFAULT_CONFIG = {
  storageQuotaGB: {
    organization: 50, // matches GitHub Enterprise Cloud's shared Packages+Actions quota
    user: 2 // matches a GitHub Team/Pro plan's shared Packages+Actions quota
  }
};

const CONFIG_FILE_NAME = 'github-artifacts-analyzer.config.json';

// Loads storageQuotaGB overrides from ./github-artifacts-analyzer.config.json
// in the current working directory, falling back to DEFAULT_CONFIG for
// anything the file doesn't specify. Never throws - a missing or malformed
// config file just means the defaults apply.
export function loadConfig() {
  if (!existsSync(CONFIG_FILE_NAME)) {
    return DEFAULT_CONFIG;
  }

  try {
    const userConfig = JSON.parse(readFileSync(CONFIG_FILE_NAME, 'utf8'));
    return {
      storageQuotaGB: {
        ...DEFAULT_CONFIG.storageQuotaGB,
        ...(userConfig.storageQuotaGB ?? {})
      }
    };
  } catch (error) {
    console.warn(`Warning: could not parse ${CONFIG_FILE_NAME} (${error.message}) - using default quota values.`);
    return DEFAULT_CONFIG;
  }
}
