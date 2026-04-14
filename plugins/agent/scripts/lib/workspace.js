import { ensureGitRepository } from "./git.js";
export function resolveWorkspaceRoot(cwd) {
    try {
        return ensureGitRepository(cwd);
    }
    catch {
        return cwd;
    }
}
