import type { ProviderContext } from "../../core/lib/provider.js"

export const AGENT_PROVIDER: ProviderContext = {
  appServer: {
    brokerBusyMessage: "Shared Agent broker is busy.",
    cliArgs: ["app-server"],
    cliBinary: "agent",
    clientTitle: "Agent Plugin",
    userAgentLabel: "agent-companion-broker",
  },
  cliResumeBinary: "agent",
  displayName: "Agent",
  envVars: {
    brokerEndpoint: "AGENT_COMPANION_APP_SERVER_ENDPOINT",
    logFile: "AGENT_COMPANION_APP_SERVER_LOG_FILE",
    pidFile: "AGENT_COMPANION_APP_SERVER_PID_FILE",
    sessionId: "AGENT_COMPANION_SESSION_ID",
  },
  id: "agent",
  log: {
    stderrLabel: "agent",
  },
  paths: {
    brokerSessionPrefix: "cpc-",
    socketSuffix: "agent-app-server",
    stateRootDirName: "agent-companion",
    tempDirPrefix: "agent-plugin-",
  },
  slashPrefix: "/agent",
}
