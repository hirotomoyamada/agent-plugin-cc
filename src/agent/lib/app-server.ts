import fs from "node:fs"
import { fileURLToPath } from "node:url"

import * as core from "../../core/lib/app-server.js"

import { AGENT_PROVIDER } from "./provider-config.js"

const PLUGIN_MANIFEST_URL = new URL(
  "../../.claude-plugin/plugin.json",
  import.meta.url,
)
const PLUGIN_MANIFEST = JSON.parse(
  fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"),
) as { version?: string }

const DEFAULT_BROKER_SCRIPT = fileURLToPath(
  new URL("../app-server-broker.js", import.meta.url),
)

export const BROKER_ENDPOINT_ENV = AGENT_PROVIDER.envVars.brokerEndpoint
export const BROKER_BUSY_RPC_CODE = core.BROKER_BUSY_RPC_CODE

const DEFAULT_CLIENT_INFO: core.ClientInfo = {
  name: "Claude Code",
  title: AGENT_PROVIDER.appServer.clientTitle,
  version: PLUGIN_MANIFEST.version ?? "0.0.0",
}

const DEFAULT_CAPABILITIES: core.Capabilities = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
  ],
}

interface AgentClientOptions extends core.AppServerClientOptions {
  capabilities?: core.Capabilities
  clientInfo?: core.ClientInfo
}

export class AgentAppServerClient {
  static async connect(
    cwd: string,
    options: AgentClientOptions = {},
  ): Promise<core.AppServerClientBase> {
    const client = await core.connectAppServer(AGENT_PROVIDER, cwd, {
      ...options,
      brokerScriptPath: options.brokerScriptPath ?? DEFAULT_BROKER_SCRIPT,
    })
    await client.request("initialize", {
      capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
      clientInfo: options.clientInfo ?? DEFAULT_CLIENT_INFO,
    })
    client.notify("initialized", {})
    return client
  }
}

export type AppServerClientBase = core.AppServerClientBase
