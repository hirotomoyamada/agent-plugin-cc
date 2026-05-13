import * as core from "../../core/lib/broker-endpoint.js";
import { KIMI_PROVIDER } from "./provider-config.js";
export const createBrokerEndpoint = (sessionDir, platform) => core.createBrokerEndpoint(KIMI_PROVIDER, sessionDir, platform);
export { parseBrokerEndpoint } from "../../core/lib/broker-endpoint.js";
