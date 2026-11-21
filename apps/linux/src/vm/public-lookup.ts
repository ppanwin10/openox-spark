import { publicLookupEnabled } from "../config";
import { allowsURL } from "./net";

export const publicLookupEngines = new Set(["duckduckgo.com", "search.brave.com", "google.com"]);
export type PublicLookup = { kind: "search" | "page"; subject: string; urls: Set<string> };

// Only infer a lookup for a named instrument, not a portfolio, trade, or reference to another turn.
function marketSubject(request: string): string | undefined {
  const query = request.replace(/^(?:(?:can|could) you\s+)?(?:please\s+)?(?:help me\s+)?(?:analy[sz]e|research|what(?:['’]s| is)|how much is)\s+/i, "")
    .replace(/^(?:请)?(?:帮我)?(?:分析(?:一下)?|研究(?:一下)?)/u, "");
  const issuer = /^(?:the )?(?:(?:current|latest) )?(?:stock|share) price of (.+?)(?: today)?$/i.exec(query)?.[1]
    ?? /^(.+?)(?:['’]s)? (?:stock(?: price)?|share price|shares)(?: today)?$/i.exec(query)?.[1];
  if (issuer && /^[\p{L}\p{N}][\p{L}\p{N}.-]*(?: [\p{L}\p{N}][\p{L}\p{N}.-]*){0,3}$/u.test(issuer)
    && !/\b(?:the|a|an|and|if|when|from|based|we|i|he|she|they|his|her|their|its|last|earlier|above|mentioned|portfolio|account|holdings?|shares?|orders?|buy|sell|remind|alert|file|email|client|confidential)\b/i.test(issuer)) return query;
  const company = /^([\p{Script=Han}A-Za-z0-9.-]{1,24}?)(?:今天|今日|当前|最新)?的?(?:股价|股票)(?:是多少|多少钱|怎么样|如何)?$/u.exec(query)?.[1];
  if (company && !/[我你他她它]|持仓|账户|组合|客户|公司内部|提到|之前|上次|刚才|这|那|如果|提醒|下单|买入|卖出|文件|邮件|并|以及|根据|机密/u.test(company)) return query;
}

// Recognize standalone requests, not a clause inside a larger task. Search engines receive
// the user's subject verbatim, never a model-generated expansion from private context.
export function requestedPublicLookup(text: string): PublicLookup | undefined {
  if (!publicLookupEnabled() || text.length > 300 || /[\r\n]/.test(text.trim())) return;
  const match = /^(?:(?:(?:can|could) you\s+)?(?:please\s+)?(?:look\s+up|search(?:\s+(?:the\s+)?(?:web|internet|online))?(?:\s+for)?|find\s+(?:public\s+)?(?:information|info)\s+(?:on|about)|read)\s+|(?:请\s*)?(?:帮我\s*)?(?:在网上|上网|网上)?(?:查一下|查询|查看|查查|搜索|搜一下|查阅|搜一搜|查))(.+)$/iu.exec(text.trim());
  const subject = match?.[1]?.trim().replace(/[。？！?!]$/, "").trim() ?? marketSubject(text.trim().replace(/[。？！?!]$/, "").trim());
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
