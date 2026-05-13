import * as core from "../../core/lib/fs.js";
import { CODEX_PROVIDER } from "./provider-config.js";
export const createTempDir = (prefix) => core.createTempDir(CODEX_PROVIDER, prefix);
export { ensureAbsolutePath, isProbablyText, readJsonFile, readStdinIfPiped, safeReadFile, writeJsonFile, } from "../../core/lib/fs.js";
