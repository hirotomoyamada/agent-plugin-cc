export interface ProviderEnvVars {
  brokerEndpoint: string
  logFile: string
  pidFile: string
  sessionId: string
}

export interface ProviderPaths {
  brokerSessionPrefix: string
  socketSuffix: string
  stateRootDirName: string
  tempDirPrefix: string
}

export interface ProviderAppServer {
  brokerBusyMessage: string
  cliArgs: string[]
  cliBinary: string
  clientTitle: string
  userAgentLabel: string
}

export interface ProviderLog {
  stderrLabel: string
}

export interface ProviderContext {
  appServer: ProviderAppServer
  cliResumeBinary: string
  displayName: string
  envVars: ProviderEnvVars
  id: string
  log: ProviderLog
  paths: ProviderPaths
  slashPrefix: string
}
