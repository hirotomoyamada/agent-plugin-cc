import * as core from "../../core/lib/fs.js"

import { AGENT_PROVIDER } from "./provider-config.js"

export const createTempDir = (prefix?: string) =>
  core.createTempDir(AGENT_PROVIDER, prefix)

export {
  ensureAbsolutePath,
  isProbablyText,
  readJsonFile,
  readStdinIfPiped,
  safeReadFile,
  writeJsonFile,
} from "../../core/lib/fs.js"
