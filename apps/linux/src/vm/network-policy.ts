export const directProtocols = [
  { id: "ssh", name: "Outbound SSH / SFTP" }, { id: "smtp", name: "Outgoing email (SMTP)" },
  { id: "imap", name: "Email mailbox access (IMAP, POP3)" }, { id: "database", name: "Database connections" },
  { id: "ftp", name: "File transfer (FTP)" }, { id: "dns", name: "External DNS lookups" },
  { id: "tcp", name: "Other TCP connections" }, { id: "udp", name: "Other UDP traffic" },
] as const;
export type DirectProtocol = typeof directProtocols[number]["id"];
export const protocolKey = (id: DirectProtocol) => `ox.network.protocol.${id}`;
export const protocolEnabled = (actions: Record<string, string>, id: DirectProtocol) => ["ask", "allow"].includes(actions[protocolKey(id)] ?? "");
export function directProtocol(transport: "tcp" | "tls" | "udp", port: number): DirectProtocol {
  if ([53, 853].includes(port)) return "dns";
  if (transport === "udp") return "udp";
  if (port === 22) return "ssh";
  if ([25, 465, 587].includes(port)) return "smtp";
  if ([110, 143, 993, 995].includes(port)) return "imap";
  if ([1433, 3306, 5432, 6379, 6380, 27017].includes(port)) return "database";
  if ([20, 21, 989, 990].includes(port)) return "ftp";
  return "tcp";
}
