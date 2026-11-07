import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { OxError } from "./functions";

export interface ExecutionClock { pause(): void; resume(): void }
export interface ScriptLimits { activeMs: number; maxLines: number; maxBytes: number }
export type ScriptCall = (name: string, args: unknown, signal: AbortSignal, clock: ExecutionClock) => Promise<unknown>;

const prelude = (contracts: Record<string, unknown>) => `const ox=(()=>{const C=${JSON.stringify(contracts)};const root={};`
  + `const fail=r=>{const f=(r&&r.error)||{};const e=new Error(String(f.message||"Operation failed"));e.name="OxError";e.code=String(f.code||"operation_failed");e.recovery=String(f.recovery||"");`
  + `e.message=e.code+": "+e.message+(e.recovery?" Recovery: "+e.recovery:"");throw e;};`
  + `const call=(n,a)=>__oxCall(n,a===undefined?{}:a).then(r=>r&&r.ok?r.value:fail(r));`
  + `for(const n of Object.keys(C)){const p=n.split(".").slice(1);let t=root;for(const k of p.slice(0,-1))t=t[k]||(t[k]={});`
  + `const f=a=>call(n,a);f.help=()=>C[n]?JSON.stringify(C[n]):n+" is not available on this Host.";t[p[p.length-1]]=f;}`
  + `const ns=(t,pre)=>{for(const[k,v]of Object.entries(t))if(v&&typeof v==="object")ns(v,pre+"."+k);`
  + `Object.defineProperty(t,"help",{value:()=>Object.keys(C).filter(n=>n.startsWith(pre+".")&&C[n]).join("\\n")});};ns(root,"ox");return root;})();`;

function clip(text: string, limits: ScriptLimits) {
  const encoder = new TextEncoder();
  let lines = text.split("\n");
  let clipped = false;
  if (lines.length > limits.maxLines) { lines = lines.slice(-limits.maxLines); clipped = true; }
  while (lines.length > 1 && encoder.encode(lines.join("\n")).length > limits.maxBytes) { lines.shift(); clipped = true; }
  let kept = lines.join("\n");
  const bytes = encoder.encode(kept);
  if (bytes.length > limits.maxBytes) {
    let start = bytes.length - limits.maxBytes;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    kept = new TextDecoder().decode(bytes.subarray(start));
    return `[Earlier output omitted; showing the last ${bytes.length - start} bytes.]\n${kept}`;
  }
  return clipped ? `[Earlier output omitted; showing the last ${lines.length} lines.]\n${kept}` : kept;
}

export async function runScript(source: string, contracts: Record<string, unknown>, call: ScriptCall, signal: AbortSignal | undefined, limits: ScriptLimits) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) controller.abort();
  const started = Date.now();
  let waited = 0;
  let since: number | undefined;
  let timedOut = false;
  const clock: ExecutionClock = {
    pause() { since ??= Date.now(); },
    resume() { if (since !== undefined) { waited += Date.now() - since; since = undefined; } },
  };
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - started - waited - (since === undefined ? 0 : now - since) > limits.activeMs) { timedOut = true; controller.abort(); }
  }, 250);
  const sandbox = new CodemodeSandbox({ timeoutMs: Infinity, memoryLimitBytes: 256 * 1024 * 1024, globals: [{
    name: "__oxCall", spread: true,
    execute: async (args, context) => {
      const [name, input] = args as [unknown, unknown];
      try { return { ok: true, value: await call(String(name), input, context.signal, clock) ?? null }; }
      catch (error) {
        const failure = error instanceof OxError ? error
          : new OxError((error as { code?: string }).code ?? "operation_failed", error instanceof Error ? error.message : String(error));
        return { ok: false, error: { code: failure.code, message: failure.message, recovery: failure.recovery } };
      }
    },
  }] });
  try {
    const result = await sandbox.execute(prelude(contracts) + source, { signal: controller.signal });
    const lines = result.output.flatMap(item => item.type === "text" ? [item.text] : []);
    if (result.ok && result.value !== undefined) lines.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
    if (!result.ok) {
      lines.push(timedOut ? `Execution exceeded the ${Math.round(limits.activeMs / 1000)}-second active time limit and was stopped.`
        : result.error.kind === "aborted" ? "Execution was cancelled."
        : result.error.stack ?? `${result.error.name ?? "Error"}: ${result.error.message}`);
    }
    const text = clip(lines.join("\n"), limits);
    return { text: text || "(no output)", isError: !result.ok };
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", stop);
    await sandbox.close();
  }
}
