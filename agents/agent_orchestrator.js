/*
 * agent_orchestrator.js — ties sandbox + LLM + regression into a live
 * improvement loop, and serves in-play AI decisions from the SAME worker
 * so LLM-generated code never runs on the main thread.
 *
 * Public surface (browser):
 *   const orch = new AgentOrchestrator({ core, llm, keysProvider, hooks });
 *   await orch.init(seedSource)          // load seed policy into worker
 *   const action = await orch.decide(ctx) // one AI decision (worker)
 *   await orch.maybeImprove(history)      // run cycle on cadence
 *   orch.getState() -> { version, source, lastResult }
 *
 * Worker protocol messages carry an incrementing id; decide() and load()
 * register a pending resolver keyed by id, with a timeout guard.
 *
 * For Node tests we inject a WorkerFactory that speaks the same
 * postMessage/onmessage protocol via worker_threads.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.AgentOrchestrator = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function AgentOrchestrator(opts) {
    this.core = opts.core;                 // AgentCore
    this.llm = opts.llm;                   // AgentLLM.LLMService instance
    this.buildPrompt = opts.buildPrompt;   // AgentLLM.buildPrompt
    this.assemble = opts.assemble;         // AgentLLM.assemble
    this.keysProvider = opts.keysProvider || (() => ({}));
    this.hooks = opts.hooks || {};         // onImprove, onReject, onThinking
    this.workerFactory = opts.workerFactory; // () => workerLike
    this.decideTimeoutMs = opts.decideTimeoutMs || 2000;
    this.loadTimeoutMs = opts.loadTimeoutMs || 3000;
    this.improveEveryRounds = opts.improveEveryRounds || 3;

    this.version = 0;
    this.source = "";
    this._epoch = 0; // bumped on every init(); invalidates in-flight improves
    this.history = [];
    this.lastAccuracy = null;
    this.bankSize = this.core.REGRESSION_BANK.length;
    this._roundsSinceImprove = 0;
    this._msgId = 1;
    this._pending = {};
    this._worker = null;
    this._busyImproving = false;
  }

  AgentOrchestrator.prototype._ensureWorker = function () {
    if (this._worker) return;
    const w = this.workerFactory();
    const self_ = this;
    w.onmessage = function (e) {
      const m = e.data || {};
      const p = self_._pending[m.id];
      if (!p) return;
      delete self_._pending[m.id];
      clearTimeout(p.timer);
      p.resolve(m);
    };
    if (w.onerror !== undefined) {
      w.onerror = function (err) {
        // fail all pending on worker crash
        Object.keys(self_._pending).forEach((id) => {
          const p = self_._pending[id];
          delete self_._pending[id];
          clearTimeout(p.timer);
          p.resolve({ id: Number(id), ok: false, reason: "worker error" });
        });
      };
    }
    this._worker = w;
  };

  AgentOrchestrator.prototype._post = function (msg, timeoutMs) {
    this._ensureWorker();
    const id = this._msgId++;
    msg.id = id;
    const self_ = this;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (self_._pending[id]) {
          delete self_._pending[id];
          resolve({ id: id, ok: false, reason: "timeout" });
          // On timeout we must assume the worker is wedged (e.g. infinite
          // loop). Recycle it so subsequent calls are not all stuck.
          self_._recycleWorker();
        }
      }, timeoutMs);
      self_._pending[id] = { resolve: resolve, timer: timer };
      self_._worker.postMessage(msg);
    });
  };

  AgentOrchestrator.prototype._recycleWorker = function () {
    try { if (this._worker && this._worker.terminate) this._worker.terminate(); } catch (e) {}
    this._worker = null;
    // reload current good policy into a fresh worker so gameplay continues
    if (this.source) {
      const src = this.source;
      // fire and forget; decisions will re-load lazily if needed
      this._loadIntoWorker(src, false, this._epoch).catch(function () {});
    }
  };

  // Load a policy into the worker as the active fn, optionally validating.
  // `epoch` ties this persist to the operation that produced it (init vs.
  // improve); it defaults to the live epoch but callers that span an await
  // (init, improve's commit) must pass the epoch they captured at the start
  // of their own operation, not the live one, or a reset that bumps the
  // epoch mid-flight would make their stale commit look fresh again. See
  // the epoch-gate comment in agent_core.js's WORKER_SOURCE.
  AgentOrchestrator.prototype._loadIntoWorker = function (source, validate, epoch) {
    const scenarios = validate ? this.core.REGRESSION_BANK : [];
    const ep = epoch != null ? epoch : this._epoch;
    return this._post({ mode: "load", persist: true, code: source, scenarios: scenarios, epoch: ep }, this.loadTimeoutMs);
  };

  // Initialize with a seed policy (v0). Validates and persists it.
  AgentOrchestrator.prototype.init = async function (seedSource) {
    // Bump epoch FIRST: any improve() already in flight is now stale and
    // will refuse to commit when it finishes.
    this._epoch++;
    const myEpoch = this._epoch;
    this.source = seedSource;
    this.version = 0;
    this.history = [];
    this._roundsSinceImprove = 0;
    const res = await this._loadIntoWorker(seedSource, true, myEpoch);
    if (!res.ok) throw new Error("seed policy failed to load: " + res.reason);
    const v = this.core.validateResults(res.results, this.core.REGRESSION_BANK);
    if (!v.ok) throw new Error("seed policy invalid: " + v.reason);
    // Re-assert after the await in case anything mutated state mid-flight.
    if (this._epoch === myEpoch) {
      this.source = seedSource;
      this.version = 0;
    }
    this.lastAccuracy = this.core.REGRESSION_BANK.length;
    return true;
  };

  // One in-play AI decision, executed in the worker.
  AgentOrchestrator.prototype.decide = async function (ctx) {
    const res = await this._post({ mode: "decide", ctx: ctx }, this.decideTimeoutMs);
    if (res.ok && (res.action === "H" || res.action === "S" || res.action === "D" || res.action === "P")) {
      // enforce legality defensively even though policy was regression-tested
      if (res.action === "D" && !ctx.canDouble) return "H";
      if (res.action === "P" && !ctx.canSplit) return "S";
      return res.action;
    }
    // Fallback to a safe default if the worker failed: stand is always legal.
    return "S";
  };

  AgentOrchestrator.prototype.recordRound = function (entry) {
    this.history.push(entry);
    if (this.history.length > 40) this.history.shift();
    this._roundsSinceImprove++;
  };

  AgentOrchestrator.prototype.shouldImprove = function () {
    return this._roundsSinceImprove >= this.improveEveryRounds && !this._busyImproving;
  };

  // Run the full improvement cycle. Returns a result object describing the
  // outcome for UI. Non-throwing.
  AgentOrchestrator.prototype.improve = async function () {
    if (this._busyImproving) return { status: "busy" };
    const keys = this.keysProvider();
    const haveKey = keys && (keys.groq || keys.openrouter || keys.openai);
    if (!haveKey) return { status: "no_key" };

    this._busyImproving = true;
    if (this.hooks.onThinking) this.hooks.onThinking(true);
    // Snapshot the epoch. If init() runs while we are awaiting (reset or
    // key re-save), the epoch changes and this whole cycle is abandoned.
    const myEpoch = this._epoch;
    const stale = () => this._epoch !== myEpoch;
    try {
      const payload = this.assemble(this.source, this.version, this.history, 10, this.lastAccuracy, this.bankSize);
      const prompt = this.buildPrompt(payload);
      const resp = await this.llm.improve(keys, prompt);
      if (stale()) return { status: "stale" };
      if (!resp.success) {
        return { status: "llm_failed", reason: resp.error, consecutiveFailures: this.llm.getConsecutiveFailures() };
      }
      // Extract
      const ex = this.core.extractPolicyCode(resp.content);
      if (!ex.ok) { this._reject("extract: " + ex.reason); return { status: "rejected", reason: "extract: " + ex.reason }; }
      // Static screen
      const sc = this.core.staticScreen(ex.code);
      if (!sc.ok) { this._reject(sc.reason); return { status: "rejected", reason: sc.reason }; }
      // Sandbox + regression (validate WITHOUT persisting yet)
      const run = await this._post({ mode: "load", persist: false, code: ex.code, scenarios: this.core.REGRESSION_BANK }, this.loadTimeoutMs);
      if (stale()) return { status: "stale" };
      if (!run.ok) { this._reject(run.reason); return { status: "rejected", reason: run.reason }; }
      const val = this.core.validateResults(run.results, this.core.REGRESSION_BANK);
      if (!val.ok) { this._reject(val.reason); return { status: "rejected", reason: val.reason }; }

      // Accepted: persist into worker as active, bump version. Tag with
      // myEpoch (captured at the top of this improve() call), NOT the live
      // epoch — by the time this send happens a concurrent reset may already
      // have bumped this._epoch, and tagging with the live value would let
      // this stale commit slip past the worker's epoch gate and clobber the
      // reset's freshly-loaded seed.
      const commit = await this._loadIntoWorker(ex.code, false, myEpoch);
      // FINAL gate: never commit a policy from a session that has been reset.
      if (stale()) return { status: "stale" };
      if (!commit.ok) { this._reject("commit: " + commit.reason); return { status: "rejected", reason: "commit: " + commit.reason }; }

      const prevSource = this.source;
      this.source = ex.code;
      this.version++;
      this.lastAccuracy = this.core.REGRESSION_BANK.length;
      this._roundsSinceImprove = 0;
      const result = { status: "accepted", version: this.version, source: ex.code, prevSource: prevSource, provider: resp.provider, latencyMs: resp.latencyMs };
      if (this.hooks.onImprove) this.hooks.onImprove(result);
      return result;
    } catch (err) {
      return { status: "error", reason: err && err.message };
    } finally {
      this._busyImproving = false;
      if (this.hooks.onThinking) this.hooks.onThinking(false);
    }
  };

  AgentOrchestrator.prototype._reject = function (reason) {
    this._roundsSinceImprove = 0; // don't hammer the API on every round after a reject
    if (this.hooks.onReject) this.hooks.onReject(reason);
  };

  AgentOrchestrator.prototype.getState = function () {
    return { version: this.version, source: this.source, busy: this._busyImproving };
  };

  return AgentOrchestrator;
});
