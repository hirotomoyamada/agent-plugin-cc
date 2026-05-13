import process from "node:process";
import { runBrokerMain } from "../core/lib/app-server-broker.js";
import { AgentAppServerClient } from "./lib/app-server.js";
import { AGENT_PROVIDER } from "./lib/provider-config.js";
const STREAMING_METHODS = new Set([
    "review/start",
    "thread/compact/start",
    "turn/start",
]);
function buildStreamThreadIds(method, params, result) {
    const threadIds = new Set();
    if (params?.threadId) {
        threadIds.add(params.threadId);
    }
    if (method === "review/start" && result?.reviewThreadId) {
        threadIds.add(result.reviewThreadId);
    }
    return threadIds;
}
runBrokerMain({
    buildStreamThreadIds,
    config: AGENT_PROVIDER,
    connectClient: (cwd, options) => AgentAppServerClient.connect(cwd, options),
    interruptMethod: "turn/interrupt",
    shutdownMethod: "broker/shutdown",
    streamCompletedMethod: "turn/completed",
    streamingMethods: STREAMING_METHODS,
}).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
