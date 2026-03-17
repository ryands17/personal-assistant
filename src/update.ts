// Update feature is disabled — this project is managed via git, not npm.
// To update: git pull && npm install && npm run build

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkSucceeded: boolean;
}

/** No-op: update checks are disabled. Manage updates via git pull. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return {
    current: "0.0.0",
    latest: null,
    updateAvailable: false,
    checkSucceeded: false,
  };
}

/** No-op: update installs are disabled. Manage updates via git pull. */
export async function performUpdate(): Promise<{ ok: boolean; output: string }> {
  return { ok: false, output: "Updates are disabled. Use `git pull && npm install && npm run build` to update." };
}

