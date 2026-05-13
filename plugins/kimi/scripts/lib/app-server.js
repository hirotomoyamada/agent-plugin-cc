import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "../../core/lib/app-server.js";
import { KIMI_PROVIDER } from "./provider-config.js";
const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
const DEFAULT_BROKER_SCRIPT = fileURLToPath(new URL("../app-server-broker.js", import.meta.url));
export const KIMI_PROTOCOL_VERSION = "1.10";
export const BROKER_ENDPOINT_ENV = KIMI_PROVIDER.envVars.brokerEndpoint;
export const BROKER_BUSY_RPC_CODE = core.BROKER_BUSY_RPC_CODE;
const DEFAULT_CLIENT_INFO = {
    name: "claude-code-kimi-plugin",
    version: PLUGIN_MANIFEST.version ?? "0.0.0",
};
const DEFAULT_CAPABILITIES = {
    supports_plan_mode: false,
    supports_question: false,
};
export class KimiAppServerClient {
    static async connect(cwd, options = {}) {
        const client = await core.connectAppServer(KIMI_PROVIDER, cwd, {
            ...options,
            brokerScriptPath: options.brokerScriptPath ?? DEFAULT_BROKER_SCRIPT,
        });
        await client.request("initialize", {
            capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
            client: options.clientInfo ?? DEFAULT_CLIENT_INFO,
            protocol_version: KIMI_PROTOCOL_VERSION,
        });
        return client;
    }
}
