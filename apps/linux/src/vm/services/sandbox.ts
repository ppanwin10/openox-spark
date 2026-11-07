import { CodemodeSandbox } from "@openox/agent/linux";

type SandboxOptions = ConstructorParameters<typeof CodemodeSandbox>[0];

export async function runIsolated(code: string, options: SandboxOptions & { signal?: AbortSignal }) {
  const { signal, ...settings } = options;
  const sandbox = new CodemodeSandbox({ ...settings, globals: settings.globals ?? [] });
  try { return await sandbox.execute(code, signal ? { signal } : {}); }
  finally { await sandbox.close(); }
}
