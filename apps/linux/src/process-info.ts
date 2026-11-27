async function field(pid: number, name: "lstart=" | "args=" | "stat=") {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Cannot verify an invalid process identity.");
  const child = Bun.spawn(["/bin/ps", "-ww", "-p", String(pid), "-o", name], {
    env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code === 1 && !output.trim() && !error.trim()) return null;
  if (code !== 0 || !output.trim()) throw new Error("Cannot verify the owned process identity.");
  return output.trim();
}

export const processBirth = (pid: number) => field(pid, "lstart=");

export async function processDetails(pid: number) {
  const birth = await processBirth(pid);
  if (!birth) return null;
  const [command, state] = await Promise.all([field(pid, "args="), field(pid, "stat=")]);
  if (!command || !state || state.startsWith("Z")) return null;
  const after = await processBirth(pid);
  if (!after) return null;
  if (birth !== after) throw new Error("The process identity changed while it was being verified.");
  return { pid, birth, command };
}
