/*
 * agent_llm.js — LLM service layer + pack processor.
 *
 * Responsibilities:
 *   - Hold BYO API keys (never a shipped key). Obfuscate at rest with
 *     base64, and label it honestly as obfuscation, not encryption.
 *   - Call a provider with an OpenAI-compatible chat-completions shape.
 *     Groq is primary. A second provider (OpenRouter or OpenAI) is an
 *     optional fallback. All are OpenAI-compatible so one code path
 *     serves them via different baseURLs.
 *   - Enforce >= 2s spacing between dispatched calls (Groq free tier).
 *   - Fail over to the secondary provider on 429 / network error.
 *   - Track consecutive failures for a 3-strike fallback to offline mode.
 *   - Assemble the improvement prompt from policy source + history +
 *     measured regression accuracy, asking for ONE labeled improvement.
 *
 * Network calls are injected (this.fetchImpl) so the whole thing is
 * unit-testable in Node with mocked provider responses.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.AgentLLM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PROVIDERS = {
    groq: {
      label: "Groq",
      baseURL: "https://api.groq.com/openai/v1/chat/completions",
      defaultModel: "llama-3.3-70b-versatile",
    },
    openrouter: {
      label: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    },
    openai: {
      label: "OpenAI",
      baseURL: "https://api.openai.com/v1/chat/completions",
      defaultModel: "gpt-4o-mini",
    },
  };

  // ── Key storage (obfuscation, not encryption) ──────────────────────
  const KEY_STORE = "allenlu_blackjack_keys";
  function obfuscate(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return ""; } }
  function deobfuscate(s) { try { return decodeURIComponent(escape(atob(s))); } catch (e) { return ""; } }

  function loadKeys(storage) {
    storage = storage || safeLocalStorage();
    if (!storage) return { groq: "", openrouter: "", openai: "" };
    try {
      const raw = storage.getItem(KEY_STORE);
      if (!raw) return { groq: "", openrouter: "", openai: "" };
      const obj = JSON.parse(raw);
      return {
        groq: obj.groq ? deobfuscate(obj.groq) : "",
        openrouter: obj.openrouter ? deobfuscate(obj.openrouter) : "",
        openai: obj.openai ? deobfuscate(obj.openai) : "",
      };
    } catch (e) { return { groq: "", openrouter: "", openai: "" }; }
  }
  function saveKeys(keys, storage) {
    storage = storage || safeLocalStorage();
    if (!storage) return;
    const obj = {};
    if (keys.groq) obj.groq = obfuscate(keys.groq);
    if (keys.openrouter) obj.openrouter = obfuscate(keys.openrouter);
    if (keys.openai) obj.openai = obfuscate(keys.openai);
    try { storage.setItem(KEY_STORE, JSON.stringify(obj)); } catch (e) {}
  }
  function clearKeys(storage) {
    storage = storage || safeLocalStorage();
    if (!storage) return;
    try { storage.removeItem(KEY_STORE); } catch (e) {}
  }
  function safeLocalStorage() {
    try {
      if (typeof localStorage === "undefined") return null;
      const k = "__bj_ls_test__"; localStorage.setItem(k, "1"); localStorage.removeItem(k);
      return localStorage;
    } catch (e) { return null; }
  }

  // ── Pack processor: build the improvement prompt ───────────────────
  function computeMetrics(history) {
    const n = history.length;
    if (!n) return { winRate: 0, averageNet: 0, bustCount: 0, totalRounds: 0 };
    let wins = 0, netSum = 0, busts = 0;
    for (const h of history) {
      if (h.aiBeatDealer) wins++;
      netSum += (h.aiNet || 0);
      if (h.aiBusted) busts++;
    }
    return { winRate: wins / n, averageNet: netSum / n, bustCount: busts, totalRounds: n };
  }

  function formatHistory(history, windowN) {
    const slice = history.slice(-windowN);
    if (!slice.length) return "(no rounds yet)";
    return slice.map((h, i) =>
      `#${i + 1}: AI hand ${JSON.stringify(h.aiCards)} vs dealer up ${h.dealerUp}, ` +
      `AI ${h.aiActions ? h.aiActions.join("/") : "?"}, ` +
      `AI net ${typeof h.aiNet === "number" ? h.aiNet.toFixed(1) : "?"}, ` +
      `${h.aiBusted ? "busted" : "ok"}`
    ).join("\n");
  }

  function buildPrompt(payload) {
    const m = payload.metrics;
    const acc = (typeof payload.lastAccuracy === "number")
      ? `\nLast proposal passed ${payload.lastAccuracy}/${payload.bankSize} regression scenarios.` : "";
    return [
      "You are optimizing a Blackjack strategy function through iterative code edits.",
      "This is continual learning by editing code, not by training weights.",
      "",
      `CURRENT POLICY (version ${payload.version}):`,
      "```js",
      payload.policySource,
      "```",
      "",
      `RECENT HISTORY (last ${payload.historyWindow} rounds):`,
      payload.formattedHistory,
      "",
      `PERFORMANCE: win rate ${(m.winRate * 100).toFixed(0)}%, avg net ${m.averageNet.toFixed(2)}, busts ${m.bustCount}/${m.totalRounds}.` + acc,
      "",
      "TASK: Return an improved version of the function. Make ONE clear,",
      "well-motivated improvement this iteration (for example: add correct",
      "soft-hand play, add doubling on 10/11, add pair-splitting, or add",
      "count-based deviations). Do not rewrite everything at once.",
      "",
      "HARD REQUIREMENTS:",
      "- Signature exactly: function policy(ctx) { ... }",
      "- ctx = { cards:number[], dealerUp:number, canDouble:boolean, canSplit:boolean, trueCount:number }",
      "  where Ace is 11 and all ten-value cards are 10.",
      "- Return exactly one of the strings 'H', 'S', 'D', 'P'.",
      "- Return 'D' only when ctx.canDouble is true. Return 'P' only when ctx.canSplit is true.",
      "- Pure function. No network, storage, DOM, globals, eval, loops-without-bound, or comments containing backticks.",
      "- Respond with ONLY the function in a single ```js code block. No prose.",
    ].join("\n");
  }

  function assemble(currentPolicy, version, history, historyWindow, lastAccuracy, bankSize) {
    historyWindow = historyWindow || 10;
    const metrics = computeMetrics(history);
    return {
      policySource: currentPolicy,
      version: version,
      metrics: metrics,
      historyWindow: historyWindow,
      formattedHistory: formatHistory(history, historyWindow),
      lastAccuracy: lastAccuracy,
      bankSize: bankSize,
    };
  }

  // ── LLM service ────────────────────────────────────────────────────
  function LLMService(opts) {
    opts = opts || {};
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(null) : null);
    this.minSpacingMs = opts.minSpacingMs != null ? opts.minSpacingMs : 2000;
    this.models = opts.models || {};
    this.temperature = opts.temperature != null ? opts.temperature : 0.6;
    this.maxTokens = opts.maxTokens != null ? opts.maxTokens : 1200;
    this.timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 12000;
    this._lastDispatch = 0;
    this._consecutiveFailures = 0;
    this.debugLog = [];
  }

  LLMService.prototype.getConsecutiveFailures = function () { return this._consecutiveFailures; };

  // Order providers: groq first, then any other configured key.
  LLMService.prototype._providerOrder = function (keys) {
    const order = [];
    if (keys.groq) order.push("groq");
    if (keys.openrouter) order.push("openrouter");
    if (keys.openai) order.push("openai");
    return order;
  };

  LLMService.prototype._spacingWait = function () {
    const now = Date.now();
    const wait = Math.max(0, this.minSpacingMs - (now - this._lastDispatch));
    return new Promise((res) => setTimeout(res, wait));
  };

  LLMService.prototype._callProvider = async function (providerId, keys, prompt) {
    const prov = PROVIDERS[providerId];
    const model = this.models[providerId] || prov.defaultModel;
    const body = {
      model: model,
      messages: [{ role: "user", content: prompt }],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + keys[providerId],
    };
    const t0 = Date.now();
    let resp, ctrl, timer;
    try {
      ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
      resp = await this.fetchImpl(prov.baseURL, {
        method: "POST", headers: headers, body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { success: false, provider: providerId, error: "network: " + (err && err.message), latencyMs: Date.now() - t0, status: 0 };
    }
    if (timer) clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      let bodyText = "";
      try { bodyText = await resp.text(); } catch (e) {}
      return { success: false, provider: providerId, error: "http " + resp.status, status: resp.status, latencyMs, bodyText };
    }
    let data;
    try { data = await resp.json(); }
    catch (e) { return { success: false, provider: providerId, error: "bad json", status: resp.status, latencyMs }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== "string") {
      return { success: false, provider: providerId, error: "no content", status: resp.status, latencyMs };
    }
    return { success: true, provider: providerId, content: content, latencyMs, status: resp.status };
  };

  // Try providers in order; fail over on 429 / network. Auth errors on a
  // provider skip to the next rather than retrying.
  LLMService.prototype.improve = async function (keys, prompt) {
    const order = this._providerOrder(keys);
    if (!order.length) {
      return { success: false, error: "no api key configured" };
    }
    await this._spacingWait();
    this._lastDispatch = Date.now();

    let lastErr = null;
    for (const pid of order) {
      const r = await this._callProvider(pid, keys, prompt);
      this.debugLog.push({ t: Date.now(), provider: pid, ok: r.success, status: r.status, error: r.error, latencyMs: r.latencyMs });
      if (this.debugLog.length > 200) this.debugLog.shift();
      if (r.success) { this._consecutiveFailures = 0; return r; }
      lastErr = r;
      // Fail over on rate limit or network/timeout; stop on hard auth errors only after trying others.
      const failoverWorthy = (r.status === 429 || r.status === 0 || r.status >= 500);
      if (!failoverWorthy && (r.status === 401 || r.status === 403)) {
        // try next provider anyway (key may be set for another)
        continue;
      }
    }
    this._consecutiveFailures++;
    return { success: false, error: (lastErr && lastErr.error) || "all providers failed", provider: lastErr && lastErr.provider, status: lastErr && lastErr.status };
  };

  return {
    PROVIDERS,
    loadKeys, saveKeys, clearKeys, obfuscate, deobfuscate,
    computeMetrics, formatHistory, buildPrompt, assemble,
    LLMService,
  };
});
