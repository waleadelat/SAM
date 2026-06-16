import type { config as MssqlConfig } from "mssql";

/**
 * Parse an ADO.NET-format SQL Server / Azure SQL connection string into an
 * mssql config object.
 *
 * Supported formats:
 *   Server=tcp:myserver.database.windows.net,1433;Initial Catalog=mydb;
 *   User ID=user;Password=pass;Encrypt=True;...
 *
 *   Authentication="Active Directory Password" is also supported.
 *
 * Returns null if the string cannot be parsed into a usable config.
 */
export function parseMssqlConnectionString(raw: string): MssqlConfig | null {
  if (!raw || !raw.trim()) return null;

  const pairs: Record<string, string> = {};
  const parts = raw.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, " ");
    const val = part.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) pairs[key] = val;
  }

  const server = pairs["server"] || pairs["data source"] || pairs["address"] || pairs["addr"] || pairs["network address"] || "";
  if (!server) return null;

  // Parse "tcp:host,port" or "host,port" or "host"
  let host = server.replace(/^tcp:/i, "");
  let port = 1433;
  const commaIdx = host.lastIndexOf(",");
  if (commaIdx !== -1) {
    const maybePort = parseInt(host.slice(commaIdx + 1), 10);
    if (!isNaN(maybePort)) {
      port = maybePort;
      host = host.slice(0, commaIdx);
    }
  }

  const database =
    pairs["initial catalog"] ||
    pairs["database"] ||
    pairs["attachdbfilename"] ||
    "";

  const user =
    pairs["user id"] ||
    pairs["uid"] ||
    pairs["user"] ||
    pairs["username"] ||
    "";

  const password =
    pairs["password"] ||
    pairs["pwd"] ||
    "";

  const encrypt =
    pairs["encrypt"] !== undefined
      ? pairs["encrypt"].toLowerCase() !== "false"
      : true;

  const trustServerCertificate =
    pairs["trustservercertificate"]?.toLowerCase() === "true" ||
    pairs["trust server certificate"]?.toLowerCase() === "true";

  const authType = (pairs["authentication"] || "").toLowerCase().replace(/\s+/g, " ");

  const config: MssqlConfig = {
    server: host,
    port,
    database: database || undefined,
    user: user || undefined,
    password: password || undefined,
    options: {
      encrypt,
      trustServerCertificate,
      connectTimeout: 15000,
      requestTimeout: 30000,
    },
  } as MssqlConfig;

  if (authType === "active directory password") {
    (config as any).authentication = {
      type: "azure-active-directory-password",
      options: { userName: user, password },
    };
    (config as any).user = undefined;
    (config as any).password = undefined;
  }

  return config;
}

/**
 * Return the connection string with the password portion masked.
 * Safe to log or display to users.
 */
export function maskConnectionString(raw: string): string {
  return raw
    .replace(/(password\s*=\s*)[^;]*/gi, "$1***")
    .replace(/(pwd\s*=\s*)[^;]*/gi, "$1***");
}

/**
 * Extract a human-readable "server.database" label from a connection string.
 */
export function connectionLabel(raw: string): string {
  const cfg = parseMssqlConnectionString(raw);
  if (!cfg) return "unknown";
  const srv = (cfg.server as string) || "unknown";
  const db = (cfg.database as string) || "";
  return db ? `${srv} / ${db}` : srv;
}
