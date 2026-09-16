// Shared environment typing for the MCP worker entry point.

export type Env = {
  /** Bare HTTPS origin of the existing HealthWorker deployment. */
  AGENT_BASE_URL: string;
  /** Cloudflare Access service credentials, stored as Worker secrets. */
  AGENT_CLIENT_ID?: string;
  AGENT_CLIENT_SECRET?: string;
  /** Unguessable path token required in the connector URL, stored as a Worker secret. */
  MCP_PATH_TOKEN?: string;
};
