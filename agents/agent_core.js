/*
 * agent_core.js — security-critical layer for the live policy agent.
 *
 * Threat model: the untrusted input is LLM-generated text that becomes
 * Allen's Policy decision function. The visitor is the potential victim.
 * The function must do nothing but read a context object and return one
 * of 'H' | 'S' | 'D' | 'P'. Three independent gates enforce that:
 *
 *   1. extractPolicyCode  — pull exactly one function body out of the
 *                           model response, reject anything malformed.
 *   2. staticScreen       — regex denylist for obviously dangerous source
 *                           (network, codegen, prototype climbing, loops).
 *                           Hygiene + honest reject reasons, NOT the
 *                           security boundary.
 *   3. runtime sandbox    — a Web Worker whose dangerous globals are
 *                           deleted before any model code is built with
 *                           new Function. Hard 2s timeout via terminate().
 *                           THIS is the security boundary.
 *
 * Plus a regression bank: 50+ fixed hands the proposal must answer with
 * only legal actions, respecting canDouble / canSplit, or it is rejected
 * and the previous policy stays live.
 *
 * This file is written to run in BOTH Node (for testing, via a worker
 * shim) and the browser. The worker SOURCE is a string so it is identical
 * in both environments and can be unit-tested without a real Worker.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.AgentCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── 1. Code extraction ────────────────────────────────────────────
  // Accept a model response that contains a function. We want the body
  // of a single function with signature policy(ctx) (or an arrow). We
  // normalise to a plain function expression string the worker can build.
  function extractPolicyCode(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, reason: "empty response" };
    }
    let text = raw.trim();

    // Prefer fenced code blocks if present.
    const fence = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    // Find a function declaration/expression named policy, or an assignment.
    // We capture the full function text starting at the first 'function'
    // or arrow assignment and balance braces from there.
    let startIdx = -1;
    const declMatch = text.match(/function\s+policy\s*\(/);
    const exprMatch = text.match(/(?:const|let|var)\s+policy\s*=\s*(?:function)?\s*\(/);
    const arrowMatch = text.match(/(?:const|let|var)\s+policy\s*=\s*\([^)]*\)\s*=>/);

    if (declMatch) startIdx = declMatch.index;
    else if (arrowMatch) startIdx = arrowMatch.index;
    else if (exprMatch) startIdx = exprMatch.index;
    else {
      // last resort: any standalone function(...) { ... }
      const anyFn = text.match(/function\s*\(/);
      if (anyFn) startIdx = anyFn.index;
    }
    if (startIdx === -1) return { ok: false, reason: "no function found in response" };

    // Balance braces to capture the whole function.
    const sub = text.slice(startIdx);
    const firstBrace = sub.indexOf("{");
    if (firstBrace === -1) return { ok: false, reason: "function has no body" };
    let depth = 0, endIdx = -1;
    for (let i = firstBrace; i < sub.length; i++) {
      const ch = sub[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) return { ok: false, reason: "unbalanced braces in function body" };

    let fnText = sub.slice(0, endIdx + 1).trim();

    // Normalise: we want to end up with a callable expression. If it is a
    // named declaration 'function policy(ctx){...}', wrap to expression.
    // If it is 'const policy = ...', strip the binding.
    fnText = fnText.replace(/^(?:const|let|var)\s+policy\s*=\s*/, "");
    if (/^function\s+policy\s*\(/.test(fnText)) {
      fnText = fnText.replace(/^function\s+policy/, "function");
    }
    // Strip trailing semicolon.
    fnText = fnText.replace(/;+\s*$/, "");

    if (fnText.length > 8000) return { ok: false, reason: "function too large" };
    return { ok: true, code: fnText };
  }

  // ── 2. Static screen (hygiene denylist, not the boundary) ──────────
  const FORBIDDEN = [
    { re: /\bfetch\b/, label: "network access (fetch)" },
    { re: /\bXMLHttpRequest\b/, label: "network access (XHR)" },
    { re: /\bWebSocket\b/, label: "network access (WebSocket)" },
    { re: /\bimportScripts\b/, label: "dynamic code loading" },
    { re: /\bimport\s*[\(\s]/, label: "dynamic import" },
    { re: /\beval\b/, label: "eval" },
    { re: /\bFunction\s*\(/, label: "Function constructor" },
    { re: /\bconstructor\b/, label: "constructor access" },
    { re: /\b__proto__\b/, label: "prototype access" },
    { re: /\bprototype\b/, label: "prototype access" },
    { re: /\bglobalThis\b/, label: "global scope access" },
    { re: /\bwindow\b/, label: "window access" },
    { re: /\bdocument\b/, label: "DOM access" },
    { re: /\blocalStorage\b/, label: "storage access" },
    { re: /\bindexedDB\b/, label: "storage access" },
    { re: /\bpostMessage\b/, label: "messaging access" },
    { re: /\bself\b/, label: "worker-global access" },
    { re: /\bprocess\b/, label: "process access" },
    { re: /\brequire\s*\(/, label: "module require" },
    { re: /`/, label: "template literal (injection risk)" },
    { re: /while\s*\(\s*true\s*\)/, label: "infinite loop" },
    { re: /for\s*\(\s*;\s*;\s*\)/, label: "infinite loop" },
  ];
  function staticScreen(code) {
    for (const f of FORBIDDEN) {
      if (f.re.test(code)) return { ok: false, reason: "blocked: " + f.label };
    }
    return { ok: true };
  }

  // ── 3. Worker source (string; identical in browser and test) ───────
  // The worker deletes dangerous globals FIRST, then builds the policy
  // with new Function INSIDE the worker, runs the supplied scenarios,
  // and posts back results. It never has DOM/cookies/localStorage (no
  // Worker does) and we additionally strip network + codegen + storage.
  const WORKER_SOURCE = `
    // Monotonic epoch gate for persisted policies. The orchestrator tags
    // every persisting 'load' message with the epoch of the operation that
    // produced it (bumped on every init()/reset). Messages are delivered to
    // this worker in post order, which is not necessarily the order their
    // owning operations were logically superseded in — an in-flight
    // improve() can finish and post its commit AFTER a reset has already
    // posted its seed reload. Without this gate that stale commit would
    // silently win and leave gameplay running old policy code even though
    // the UI shows the reset seed. Only accept a persist if its epoch is
    // >= the highest epoch already applied.
    var __epoch = 0;

    // Defense in depth: remove capabilities before running model code.
    // In a real Worker these live on the WorkerGlobalScope prototype, so
    // assigning self.x = undefined is not enough (the inherited prop shows
    // through). We override with an own non-configurable accessor that
    // throws, after deleting any own copies up the prototype chain.
    (function () {
      var kill = ['fetch','XMLHttpRequest','WebSocket','importScripts',
                  'indexedDB','caches','Worker','SharedWorker',
                  'createImageBitmap','navigator','location','Notification',
                  'BroadcastChannel','EventSource'];
      function poison(obj, name) {
        try {
          Object.defineProperty(obj, name, {
            configurable: false, enumerable: false,
            get: function () { throw new Error('blocked: ' + name); },
            set: function () { throw new Error('blocked: ' + name); }
          });
        } catch (e) {}
      }
      for (var i = 0; i < kill.length; i++) {
        var o = self;
        while (o) {
          if (Object.prototype.hasOwnProperty.call(o, kill[i])) {
            try { delete o[kill[i]]; } catch (e) {}
          }
          o = Object.getPrototypeOf(o);
        }
        poison(self, kill[i]);
      }
    })();

    onmessage = function (e) {
      var msg = e.data || {};

      // Mode 'load': build+validate a candidate against scenarios, and if
      // asked (persist:true) keep it as the active function for later
      // single-decision calls. Mode 'decide': call the active function on
      // one context. Mode 'batch': one-off validation without persisting.
      if (msg.mode === 'decide') {
        if (typeof self.__activeFn !== 'function') {
          postMessage({ id: msg.id, ok: false, reason: 'no active policy' });
          return;
        }
        var out;
        try {
          out = self.__activeFn({
            cards: msg.ctx.cards.slice(),
            dealerUp: msg.ctx.dealerUp,
            canDouble: msg.ctx.canDouble,
            canSplit: msg.ctx.canSplit,
            trueCount: msg.ctx.trueCount
          });
        } catch (err) {
          postMessage({ id: msg.id, ok: false, reason: 'decide error: ' + (err && err.message) });
          return;
        }
        postMessage({ id: msg.id, ok: true, action: out });
        return;
      }

      // 'load' or 'batch': build and run scenarios.
      var code = msg.code;
      var scenarios = msg.scenarios || [];
      var fn;
      try {
        fn = (new Function('"use strict"; return (' + code + ');'))();
        if (typeof fn !== 'function') {
          postMessage({ id: msg.id, ok: false, reason: 'not a function' });
          return;
        }
      } catch (err) {
        postMessage({ id: msg.id, ok: false, reason: 'build error: ' + (err && err.message) });
        return;
      }
      var results = [];
      for (var i = 0; i < scenarios.length; i++) {
        var s = scenarios[i];
        var r;
        try {
          r = fn({
            cards: s.cards.slice(),
            dealerUp: s.dealerUp,
            canDouble: s.canDouble,
            canSplit: s.canSplit,
            trueCount: s.trueCount
          });
        } catch (err) {
          postMessage({ id: msg.id, ok: false, reason: 'runtime error on scenario ' + i + ': ' + (err && err.message) });
          return;
        }
        results.push(r);
      }
      if (msg.mode === 'load' && msg.persist) {
        var msgEpoch = typeof msg.epoch === 'number' ? msg.epoch : 0;
        if (msgEpoch >= __epoch) {
          self.__activeFn = fn;
          __epoch = msgEpoch;
        }
      }
      postMessage({ id: msg.id, ok: true, results: results });
    };
  `;

  // ── Regression bank: 50+ fixed scenarios ───────────────────────────
  // Deterministic coverage of hard totals, soft hands, pairs, and dealer
  // up-cards. Each entry: cards (rank ints, 11=Ace), dealerUp, flags.
  function buildRegressionBank() {
    const bank = [];
    const up = [2,3,4,5,6,7,8,9,10,11];
    // hard totals 5..20 as two/three card combos vs a sample of up-cards
    const hardCombos = [
      [2,3],[2,4],[2,5],[2,6],[3,5],[4,5],[5,5],[6,5],[7,5],[8,5],
      [10,2],[10,3],[10,4],[10,5],[10,6],[10,7],[10,8],[10,9],
      [7,7,2],[10,5,3]
    ];
    hardCombos.forEach((cards, i) => {
      bank.push({ cards, dealerUp: up[i % up.length],
        canDouble: cards.length === 2, canSplit: false, trueCount: 0 });
    });
    // soft hands A,2..A,9
    for (let x = 2; x <= 9; x++) {
      bank.push({ cards: [11, x], dealerUp: up[x % up.length],
        canDouble: true, canSplit: false, trueCount: 0 });
    }
    // pairs 2..10 and A,A vs varied up-cards, split allowed
    const pairRanks = [2,3,4,5,6,7,8,9,10,11];
    pairRanks.forEach((r, i) => {
      bank.push({ cards: [r, r], dealerUp: up[i % up.length],
        canDouble: true, canSplit: true, trueCount: 0 });
    });
    // double-eligible 9/10/11 vs each up-card
    for (const u of up) {
      bank.push({ cards: [4,5], dealerUp: u, canDouble: true, canSplit: false, trueCount: 0 }); // hard 9
      bank.push({ cards: [5,6], dealerUp: u, canDouble: true, canSplit: false, trueCount: 0 }); // hard 11
    }
    // a few high true-count contexts to exercise counting logic
    for (const u of [10, 11, 6]) {
      bank.push({ cards: [10, 6], dealerUp: u, canDouble: false, canSplit: false, trueCount: 5 });
      bank.push({ cards: [10, 6], dealerUp: u, canDouble: false, canSplit: false, trueCount: -3 });
    }
    return bank;
  }
  const REGRESSION_BANK = buildRegressionBank();

  // Validate the array of returned actions against the bank constraints.
  function validateResults(results, bank) {
    if (!Array.isArray(results) || results.length !== bank.length) {
      return { ok: false, reason: "result count mismatch" };
    }
    const legal = { H: 1, S: 1, D: 1, P: 1 };
    let violations = 0;
    const detail = [];
    for (let i = 0; i < results.length; i++) {
      const a = results[i];
      if (!legal[a]) { violations++; detail.push("illegal action '" + a + "'"); continue; }
      if (a === "D" && !bank[i].canDouble) { violations++; detail.push("double when not allowed"); }
      if (a === "P" && !bank[i].canSplit) { violations++; detail.push("split when not allowed"); }
    }
    if (violations > 0) {
      return { ok: false, reason: violations + " rule violation(s): " + detail.slice(0, 3).join("; ") };
    }
    return { ok: true };
  }

  return {
    extractPolicyCode,
    staticScreen,
    WORKER_SOURCE,
    REGRESSION_BANK,
    buildRegressionBank,
    validateResults,
  };
});
