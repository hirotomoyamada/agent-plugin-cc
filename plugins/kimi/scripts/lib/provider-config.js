export const KIMI_PROVIDER = {
    appServer: {
        brokerBusyMessage: "Shared Kimi broker is busy.",
        cliArgs: ["--wire"],
        cliBinary: "kimi",
        clientTitle: "Kimi Plugin",
        userAgentLabel: "kimi-companion-broker",
    },
    cliResumeBinary: "kimi",
    displayName: "Kimi",
    envVars: {
        brokerEndpoint: "KIMI_COMPANION_APP_SERVER_ENDPOINT",
        logFile: "KIMI_COMPANION_APP_SERVER_LOG_FILE",
        pidFile: "KIMI_COMPANION_APP_SERVER_PID_FILE",
        sessionId: "KIMI_COMPANION_SESSION_ID",
    },
    id: "kimi",
    log: {
        stderrLabel: "kimi",
    },
    paths: {
        brokerSessionPrefix: "kpc-",
        socketSuffix: "kimi-app-server",
        stateRootDirName: "kimi-companion",
        tempDirPrefix: "kimi-plugin-",
    },
    slashPrefix: "/kimi",
};
