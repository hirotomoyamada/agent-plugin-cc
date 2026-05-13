export const CODEX_PROVIDER = {
    appServer: {
        brokerBusyMessage: "Shared Codex broker is busy.",
        cliArgs: ["app-server"],
        cliBinary: "codex",
        clientTitle: "Codex Plugin",
        userAgentLabel: "codex-companion-broker",
    },
    cliResumeBinary: "codex",
    displayName: "Codex",
    envVars: {
        brokerEndpoint: "CODEX_COMPANION_APP_SERVER_ENDPOINT",
        logFile: "CODEX_COMPANION_APP_SERVER_LOG_FILE",
        pidFile: "CODEX_COMPANION_APP_SERVER_PID_FILE",
        sessionId: "CODEX_COMPANION_SESSION_ID",
    },
    id: "codex",
    log: {
        stderrLabel: "codex",
    },
    paths: {
        brokerSessionPrefix: "cxc-",
        socketSuffix: "codex-app-server",
        stateRootDirName: "codex-companion",
        tempDirPrefix: "codex-plugin-",
    },
    slashPrefix: "/codex",
};
