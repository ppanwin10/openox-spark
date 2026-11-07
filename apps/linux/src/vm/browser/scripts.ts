export const captureBinding = "__oxBrowserCapture";

export const pageStateScript = (selector: string | null) => String.raw`(() => {
const state = (() => {
const selector = ${JSON.stringify(selector)};
const root = selector ? document.querySelector(selector) : document.body;
let truncated = false;
const text = value => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length > 160) truncated = true;
  return normalized.slice(0, 160);
};
const attribute = (element, name) => {
  const value = element.getAttribute(name);
  if (value === null) return null;
  if (value.length > 256) truncated = true;
  return value.slice(0, 256);
};
const visible = element => {
  if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
};
const collect = (query, limit, map) => {
  if (!root) return [];
  const matches = root.querySelectorAll(query);
  if (matches.length > 2000) truncated = true;
  const candidates = [...(root.matches(query) ? [root] : []), ...Array.from(matches).slice(0, 2000)];
  const result = [];
  for (const element of candidates) {
    if (!visible(element)) continue;
    if (result.length === limit) { truncated = true; break; }
    result.push(map(element));
  }
  return result;
};
const label = element => {
  const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent || '').join(' ');
  return text(labelled || element.getAttribute('aria-label') ||
    Array.from(element.labels || []).map(node => node.textContent).join(' ') ||
    (element.matches('button,a,[role="button"],[role="tab"]') ? element.textContent : '') ||
    element.getAttribute('placeholder') || element.getAttribute('title'));
};
const controls = collect('input,textarea,select,button,a[href],[role="button"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"]', 40, element => {
  const type = element.getAttribute('type') || element.localName;
  const control = {
    id: attribute(element, 'id'),
    name: attribute(element, 'name'),
    role: element.getAttribute('role') || element.localName,
    label: label(element),
    type,
    disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
    required: element.required === true || element.getAttribute('aria-required') === 'true',
    invalid: element.getAttribute('aria-invalid') === 'true',
  };
  if (element.matches('input[type="checkbox"],input[type="radio"]')) control.checked = element.checked;
  else if (element.hasAttribute('aria-checked')) control.checked = element.getAttribute('aria-checked') === 'true';
  if (element.hasAttribute('aria-expanded')) control.expanded = element.getAttribute('aria-expanded') === 'true';
  if (element.hasAttribute('aria-selected')) control.selected = element.getAttribute('aria-selected') === 'true';
  if (element.matches('input:not([type="password"]):not([type="hidden"]),textarea,select')) control.hasValue = Boolean(element.value);
  return control;
});
return {
  scope: selector,
  scopeFound: Boolean(root),
  readyState: document.readyState,
  busy: Boolean(root && (root.closest('[aria-busy="true"]') || root.querySelector('[aria-busy="true"]'))),
  headings: collect('h1,h2,h3,[role="heading"]', 10, element => text(element.textContent)),
  dialogs: collect('dialog[open],[role="dialog"],[role="alertdialog"]', 5, element => ({label: label(element)})),
  messages: collect('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]', 10, element => text(element.textContent)),
  controls,
  truncated,
  coverage: 'Visible light-DOM elements in the selected scope; frames and shadow roots are not inspected. Loading and application readiness are not inferred.',
};
})();
return { state, title: document.title, fullscreen: Boolean(document.fullscreenElement) };
})()`;

export const captureScript = (id: string, includeBodies: boolean) => String.raw`(() => {
  if (globalThis.top !== globalThis) return false;
  globalThis.__oxCaptureControl?.stop?.();
  const control = { active: true, id: '${id}', includeBodies: ${includeBodies ? "true" : "false"} };
  globalThis.__oxCaptureControl = control;
  const sensitive = /authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|signature|nonce|jwt|(?:^|[^a-z0-9])(?:auth|code)(?:$|[^a-z0-9])/i;
  const redactURL = raw => {
    try {
      const url = new URL(raw, location.href);
      if (url.username || url.password) { url.username = '[REDACTED]'; url.password = '[REDACTED]'; }
      if (sensitive.test(url.pathname)) url.pathname = '/[REDACTED]';
      for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, '[REDACTED]');
      if (sensitive.test(url.hash)) url.hash = '#[REDACTED]';
      return url.href;
    } catch { return '[UNPARSEABLE URL]'; }
  };
  const headers = value => {
    const result = {};
    try {
      let count = 0;
      for (const [key, item] of new Headers(value)) {
        if (count++ >= 64) break;
        result[key] = sensitive.test(key) ? '[REDACTED]' : String(item).slice(0, 2048);
      }
    } catch {}
    return result;
  };
  const body = value => {
    if (value == null) return null;
    if (value instanceof URLSearchParams || value instanceof FormData) {
      const fields = {};
      let count = 0;
      for (const [key, entry] of value) {
        if (count++ >= 64) break;
        fields[key] = sensitive.test(key) ? '[REDACTED]' : String(entry).slice(0, 2048);
      }
      return JSON.stringify(fields).slice(0, 8192);
    }
    if (typeof value !== 'string') return '[' + (value.constructor?.name || typeof value) + ']';
    const text = value.slice(0, 8192);
    try {
      const parsed = JSON.parse(text);
      const clean = item => Array.isArray(item) ? item.map(clean) : item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, sensitive.test(key) ? '[REDACTED]' : clean(entry)])) : item;
      return JSON.stringify(clean(parsed));
    } catch { return sensitive.test(text) ? '[REDACTED]' : text; }
  };
  const send = value => {
    if (!control.active) return;
    try {
      const post = globalThis.${captureBinding};
      if (typeof post === 'function') post({ captureID: control.id, timestamp: Date.now(), frameURL: redactURL(location.href), ...value })?.catch?.(() => {});
    } catch {}
  };
  const readers = new Set();
  const readResponseBody = async response => {
    let reader;
    try { reader = response.body?.getReader?.(); } catch { return null; }
    if (!reader) return null;
    readers.add(reader);
    const decoder = new TextDecoder();
    let text = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, 1000);
    try {
      while (!timedOut && text.length < 8192) {
        const { done, value } = await reader.read();
        if (done) { text = (text + decoder.decode()).slice(0, 8192); break; }
        text = (text + decoder.decode(value, { stream: true })).slice(0, 8192);
        if (text.length >= 8192) { void reader.cancel(); break; }
      }
    } catch { return null; }
    finally {
      clearTimeout(timeout);
      readers.delete(reader);
    }
    if (timedOut) return null;
    return body(text);
  };
  const originalFetch = globalThis.fetch;
  const capturedFetch = originalFetch && async function(input, init = {}) {
    if (!control.active) return originalFetch.apply(this, arguments);
    const includeBodies = control.includeBodies;
    const request = input instanceof Request ? input : null;
    const started = Date.now();
    const item = {
      kind: 'fetch',
      method: init.method || request?.method || 'GET',
      url: redactURL(request?.url || input),
      requestHeaders: headers(init.headers || request?.headers),
      requestBody: includeBodies ? body(init.body) : null
    };
    try {
      const response = await originalFetch.apply(this, arguments);
      const result = { ...item, status: response.status, responseHeaders: headers(response.headers), durationMs: Date.now() - started };
      if (!includeBodies) {
        send(result);
      } else {
        try {
          void readResponseBody(response.clone())
            .then(responseBody => send({ ...result, responseBody }))
            .catch(() => send({ ...result, responseBody: null }));
        } catch { send({ ...result, responseBody: null }); }
      }
      return response;
    } catch (error) {
      send({ ...item, error: String(error?.name || 'FetchError'), durationMs: Date.now() - started });
      throw error;
    }
  };
  if (capturedFetch) globalThis.fetch = capturedFetch;
  const xhr = globalThis.XMLHttpRequest?.prototype;
  const open = xhr?.open;
  const setRequestHeader = xhr?.setRequestHeader;
  const xhrSend = xhr?.send;
  const capturedOpen = open && function(method, url) {
    if (control.active) this.__oxCapture = { includeBodies: control.includeBodies, kind: 'xhr', method, url: redactURL(url), started: Date.now() };
    return open.apply(this, arguments);
  };
  const capturedSetRequestHeader = setRequestHeader && function(key, value) {
    const item = this.__oxCapture;
    if (control.active && item) {
      (item.requestHeaders || (item.requestHeaders = {}))[key] = sensitive.test(key) ? '[REDACTED]' : String(value).slice(0, 2048);
    }
    return setRequestHeader.apply(this, arguments);
  };
  const capturedXHRSend = xhrSend && function(value) {
    const item = this.__oxCapture;
    if (!control.active || !item) return xhrSend.apply(this, arguments);
    item.requestBody = item.includeBodies ? body(value) : null;
    this.addEventListener('loadend', () => {
      if (!control.active) return;
      let responseBody = null;
      const responseHeaders = {};
      if (item.includeBodies) { try { responseBody = body(this.responseText); } catch {} }
      try {
        for (const line of this.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
          const index = line.indexOf(':');
          if (index > 0) {
            const key = line.slice(0, index);
            responseHeaders[key] = sensitive.test(key) ? '[REDACTED]' : line.slice(index + 1).trim().slice(0, 2048);
          }
        }
      } catch {}
      const { includeBodies, ...event } = item;
      send({ ...event, status: this.status, responseHeaders, responseBody, durationMs: Date.now() - item.started });
    }, { once: true });
    return xhrSend.apply(this, arguments);
  };
  if (capturedOpen) xhr.open = capturedOpen;
  if (capturedSetRequestHeader) xhr.setRequestHeader = capturedSetRequestHeader;
  if (capturedXHRSend) xhr.send = capturedXHRSend;
  const submit = event => {
    if (!control.active) return;
    const form = event.target;
    let requestBody = null;
    if (control.includeBodies) {
      try { requestBody = body(new FormData(form)); } catch {}
    }
    send({ kind: 'form', method: (form.method || 'GET').toUpperCase(), url: redactURL(form.action || location.href), requestBody });
  };
  addEventListener('submit', submit, true);
  let observer = null;
  try {
    observer = new PerformanceObserver(list => {
      if (!control.active) return;
      for (const item of list.getEntries()) send({ kind: 'resource', url: redactURL(item.name), initiatorType: item.initiatorType, durationMs: Math.round(item.duration) });
    });
    observer.observe({ entryTypes: ['resource'] });
  } catch {}
  const OriginalWebSocket = globalThis.WebSocket;
  const CapturedWebSocket = OriginalWebSocket && new Proxy(OriginalWebSocket, {
    construct(target, args) {
      if (control.active) send({ kind: 'websocket', url: redactURL(args[0]), event: 'open' });
      return Reflect.construct(target, args);
    }
  });
  if (CapturedWebSocket) globalThis.WebSocket = CapturedWebSocket;
  control.stop = () => {
    control.active = false;
    if (capturedFetch && globalThis.fetch === capturedFetch) globalThis.fetch = originalFetch;
    if (capturedOpen && xhr.open === capturedOpen) xhr.open = open;
    if (capturedSetRequestHeader && xhr.setRequestHeader === capturedSetRequestHeader) xhr.setRequestHeader = setRequestHeader;
    if (capturedXHRSend && xhr.send === capturedXHRSend) xhr.send = xhrSend;
    removeEventListener('submit', submit, true);
    observer?.disconnect();
    for (const reader of readers) void reader.cancel().catch(() => {});
    readers.clear();
    if (CapturedWebSocket && globalThis.WebSocket === CapturedWebSocket) globalThis.WebSocket = OriginalWebSocket;
    if (globalThis.__oxCaptureControl === control) delete globalThis.__oxCaptureControl;
    return true;
  };
  return true;
})()`;

export const stopCaptureScript = "(() => globalThis.__oxCaptureControl?.stop?.() !== false)()";

export const injectedScript = (domains: readonly string[], source: string) => `(() => {
  const domains = ${JSON.stringify(domains)};
  const host = location.hostname.toLowerCase();
  if (!domains.some(domain => host === domain || host.endsWith('.' + domain))) return;
  ${source}
})();`;
