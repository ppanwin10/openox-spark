import { publicLookupEnabled } from "../config";
import { allowsURL } from "./net";

export const publicLookupEngines = new Set(["duckduckgo.com", "search.brave.com", "google.com"]);
export type PublicLookup = { kind: "search" | "page"; subject: string; urls: Set<string> };

// Only infer a lookup for a named instrument, not a portfolio, trade, or reference to another turn.
function marketSubject(request: string): string | undefined {
  const english = /^(?:(?:can|could) you\s+)?(?:please\s+)?(?:help me\s+)?(?:analy[sz]e|research|what(?:['’]s| is)|how much is)\s+(.+)$/i.exec(request)?.[1];
  if (english) {
    const issuer = /^(?:the )?(?:(?:current|latest) )?(?:stock|share) price of (.+?)(?: today)?$/i.exec(english)?.[1]
      ?? /^(.+?)(?:['’]s)? (?:stock(?: price)?|share price|shares)(?: today)?$/i.exec(english)?.[1];
    if (!issuer || !/^[\p{L}\p{N}][\p{L}\p{N}.-]*$/u.test(issuer)
      && !/^[\p{Lu}\p{N}][\p{L}\p{N}.-]*(?: (?:of |and )?[\p{Lu}\p{N}][\p{L}\p{N}.-]*){1,3}$/u.test(issuer)) return;
    if (!/\b(?:the|a|an|if|when|we|i|his|her|their|its|last|earlier|above|mentioned|portfolio|account|holdings?|orders?|buy|sell|remind|alert|file|email|client|confidential)\b/i.test(issuer)) return english;
    return;
  }
  const chinese = /^(请问|(?:请)?(?:帮我)?(?:分析|研究)(?:一下)?)?([\p{Script=Han}A-Za-z0-9.-]{1,24}?)(?:今天|今日|当前|最新)?的?(?:股价|股票)(是多少|多少钱|怎么样|如何)?$/u.exec(request);
  if (chinese && (chinese[1] || chinese[3]) && !/[我你他她它]|持仓|账户|组合|客户|内部|提到|上次|这|那|如果|提醒|通知|转发|发送|下单|买入|卖出|文件|邮件|并|以及|根据|机密/u.test(chinese[2]!))
    return request.slice(chinese[1]?.length ?? 0);
}

// Recognize standalone requests, not a clause inside a larger task. Search engines receive
// the user's subject verbatim, never a model-generated expansion from private context.
export function requestedPublicLookup(text: string): PublicLookup | undefined {
  if (!publicLookupEnabled() || text.length > 300) return;
  const request = text.trim().replace(/[。？！?!]$/, "").trim();
  if (/[\r\n]/.test(request)) return;
  const match = /^(?:(?:(?:can|could) you\s+)?(?:please\s+)?(?:look\s+up|search(?:\s+(?:the\s+)?(?:web|internet|online))?(?:\s+for)?|find\s+(?:public\s+)?(?:information|info)\s+(?:on|about)|read)\s+|(?:请\s*)?(?:帮我\s*)?(?:在网上|上网|网上)?(?:查一下|查询|查看|查查|搜索|搜一下|查阅|搜一搜|查))(.+)$/iu.exec(request);
  const subject = match?.[1]?.trim() ?? marketSubject(request);
  if (!subject) return;
  if (/^https?:\/\//i.test(subject)) {
    if (/\s/.test(subject) || !allowsURL(subject)) return;
    const url = new URL(subject);
    if (url.search || url.hash) return;
    return { kind: "page", subject: url.href, urls: new Set([url.href]) };
  }
  if (/^(?:(?:can|could) you\s+)?(?:please\s+)?read\s/i.test(text.trim())) return;
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .’'-]{0,159}$/u.test(subject) || /[A-Za-z0-9._-]{32,}/.test(subject)
    || /\b(?:my|our|your|me|mine|this|that|it|them|previous|private|internal|password|token|secret|attached|attachment|inbox|calendar|then|instead|don't)\b|我的|我们|之前|刚才|上面|这个|那个|本机|本地|私人|私密|账户|账号|密码|密钥|凭据|然后|并且|不要|提醒我|待办|聊天记录|日程|邮箱|文件夹/iu.test(subject)) return;
  return { kind: "search", subject, urls: new Set() };
}
