import process from "node:process"

import { runBrokerMain } from "../core/lib/app-server-broker.js"

import { KimiAppServerClient } from "./lib/app-server.js"
import { KIMI_PROVIDER } from "./lib/provider-config.js"

const STREAMING_METHODS = new Set(["prompt", "replay"])

function buildStreamThreadIds(
  _method: string,
  params: any,
  _result: any,
): Set<string> {
  const threadIds = new Set<string>()
  if (params?.session_id) {
    threadIds.add(params.session_id)
  }
  return threadIds
}

runBrokerMain({
  buildStreamThreadIds,
  config: KIMI_PROVIDER,
  connectClient: (cwd, options) => KimiAppServerClient.connect(cwd, options),
  interruptMethod: "cancel",
  shutdownMethod: "broker/shutdown",
  streamCompletedMethod: "event",
  streamingMethods: STREAMING_METHODS,
}).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
