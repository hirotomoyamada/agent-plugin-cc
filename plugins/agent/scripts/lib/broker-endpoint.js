import * as core from "../../core/lib/broker-endpoint.js";
import { AGENT_PROVIDER } from "./provider-config.js";
export const createBrokerEndpoint = (sessionDir, platform) => core.createBrokerEndpoint(AGENT_PROVIDER, sessionDir, platform);
export { parseBrokerEndpoint } from "../../core/lib/broker-endpoint.js";
