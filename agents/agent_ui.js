/*
 * agent_ui.js — optional live-agent layer for the Blackjack game.
 *
 * Loads AFTER agent_core/llm/orchestrator and blackjack.js. If the
 * required globals or DOM are absent, it does nothing and the game runs
 * as the verified static-progression version.
 *
 * Responsibilities:
 *   - Own the AgentOrchestrator + LLMService.
 *   - Provide BJ.agent.resolveAiHand(): async, drives the AI hand through
 *     the sandbox worker, returning the SAME {hands, steps} shape the
 *     game animation consumes. Mirrors the verified resolveWithPolicy loop.
 *   - Settings modal: BYO keys (groq/openrouter/openai), honest labels.
 *   - Code card: current source, version badge, line diff on accept,
 *     history, thinking + reject states.
 *   - onRoundResolved(): record round, run improvement on cadence.
 *
 * Test seam: if window.__mockLLM is set, it is used instead of the real
 * LLMService, so end-to-end runs spend no API quota.
 */
(function () {
  "use strict";

  // ── i18n bridge ───────────────────────────────────────────────────────
  // Every player-facing string in this file comes from locales/<lang>.json.
  // If i18n.js has not loaded, t() returns the key, which fails loudly in the
  // UI instead of quietly printing "undefined".
  function t(key, vars) {
    return (window.I18N && window.I18N.t) ? window.I18N.t(key, vars) : key;
  }

  if (typeof window === "undefined") return;
  var BJ = (window.BlackjackGame = window.BlackjackGame || {});

  // Require the agent modules; degrade silently to static game if absent.
  if (!window.AgentCore || !window.AgentLLM || !window.AgentOrchestrator) return;

  var AgentCore = window.AgentCore;
  var AgentLLM = window.AgentLLM;
  var AgentOrchestrator = window.AgentOrchestrator;

  var MAX_AI_HANDS = 4; // matches verified engine

  // Self-contained v0 seed: "mimic the dealer" with inline totalling, so it
  // runs inside the sandbox worker with no external helpers. This is also
  // the honest starting source shown in the code card.
  var SEED_POLICY =
    "function policy(ctx) {\n" +
    "  var t = 0, aces = 0;\n" +
    "  for (var i = 0; i < ctx.cards.length; i++) {\n" +
    "    t += ctx.cards[i];\n" +
    "    if (ctx.cards[i] === 11) aces++;\n" +
    "  }\n" +
    "  while (t > 21 && aces > 0) { t -= 10; aces--; }\n" +
    "  return t < 17 ? 'H' : 'S';\n" +
    "}";

  // ── Hand helpers (independent copies; engine stays the source of truth
  //    for gameplay via the shoe passed in). These only shape AI steps.
  function total(cards) {
    var t = 0, a = 0;
    for (var i = 0; i < cards.length; i++) { t += cards[i]; if (cards[i] === 11) a++; }
    while (t > 21 && a > 0) { t -= 10; a--; }
    return t;
  }
  function isBlackjack(cards) { return cards.length === 2 && total(cards) === 21; }
  function isPair(cards) { return cards.length === 2 && cards[0] === cards[1]; }

  // ── Worker factory (real browser Worker from the shipped source) ────
  function makeWorker() {
    var blob = new Blob([AgentCore.WORKER_SOURCE], { type: "application/javascript" });
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);
    return {
      postMessage: function (m) { w.postMessage(m); },
      terminate: function () { try { w.terminate(); } catch (e) {} URL.revokeObjectURL(url); },
      set onmessage(fn) { w.onmessage = function (e) { fn({ data: e.data }); }; },
      set onerror(fn) { w.onerror = fn; }
    };
  }

  // ── LLM service (real or mocked) ────────────────────────────────────
  function makeLLM() {
    if (window.__mockLLM) return window.__mockLLM;
    return new AgentLLM.LLMService({
      models: (BJ.agentConfig && BJ.agentConfig.models) || {},
    });
  }

  // ── Orchestrator singleton ──────────────────────────────────────────
  var orch = null;
  var llm = null;
  var codeCard = null; // set after DOM wiring
  var gameApi = null;

  // Generation counter: incremented every time the game resets or a key is
  // saved. Any in-flight orch.improve() that started before the latest
  // increment is considered stale and its result is silently discarded.
  var _resetGen = 0;
  var _improveStartGen = -1; // set just before each orch.improve() call

  function keysProvider() { return AgentLLM.loadKeys(); }
  function haveAnyKey() {
    var k = keysProvider();
    return !!(k.groq || k.openrouter || k.openai);
  }

  function ensureOrchestrator() {
    if (orch) return orch;
    llm = makeLLM();
    orch = new AgentOrchestrator({
      core: AgentCore,
      llm: llm,
      buildPrompt: AgentLLM.buildPrompt,
      assemble: AgentLLM.assemble,
      keysProvider: keysProvider,
      workerFactory: makeWorker,
      improveEveryRounds: (BJ.agentConfig && BJ.agentConfig.improveEveryRounds) || 1,
      hooks: {
        onThinking: function (on) { if (codeCard) codeCard.setThinking(on); },
        // Guard against stale LLM responses landing after a reset or re-key.
        // _improveStartGen is set synchronously before each orch.improve() call;
        // if _resetGen has changed since then a reset happened mid-flight.
        onImprove: function (res) {
          if (_improveStartGen !== _resetGen) return;
          if (codeCard) codeCard.onAccepted(res);
        },
        onReject: function (reason) { if (codeCard) codeCard.onRejected(reason); }
      }
    });
    return orch;
  }

  // ── Async AI-hand resolver: mirrors verified resolveWithPolicy but
  //    each decision comes from the sandbox worker via orch.decide(). ──
  async function resolveAiHand(ctx) {
    var shoe = ctx.shoe;
    var dealerUp = ctx.dealerUp;
    var tc = ctx.tcAtDeal;
    var dealerHasBJ = ctx.dealerHasBJ;
    var steps = [];
    var bet = 1;

    if (dealerHasBJ) {
      return {
        hands: [{ cards: ctx.startCards.slice(), bet: bet, busted: false, blackjack: isBlackjack(ctx.startCards) }],
        steps: []
      };
    }

    var hands = [{ cards: ctx.startCards.slice(), labels: (ctx.startLabels || [null, null]).slice(), bet: bet, doneSplitAce: false }];
    var i = 0;
    while (i < hands.length) {
      var h = hands[i];
      var acting = true;
      while (acting) {
        if (h.doneSplitAce) { acting = false; break; }
        if (total(h.cards) >= 21) { acting = false; break; }
        var canDouble = h.cards.length === 2;
        var canSplit = h.cards.length === 2 && isPair(h.cards) && hands.length < MAX_AI_HANDS;
        var move = await orch.decide({
          cards: h.cards.slice(), dealerUp: dealerUp,
          canDouble: canDouble, canSplit: canSplit, trueCount: tc
        });
        if (move === "P" && canSplit) {
          var c = h.cards[0], origLabel = h.labels[0], isA = c === 11;
          var nc1 = shoe.draw(), nl1 = shoe.drawLabel();
          var nc2 = shoe.draw(), nl2 = shoe.drawLabel();
          h.cards = [c, nc1]; h.labels = [origLabel, nl1]; h.doneSplitAce = isA;
          var nh = { cards: [c, nc2], labels: [origLabel, nl2], bet: bet, doneSplitAce: isA };
          hands.splice(i + 1, 0, nh);
          steps.push({ handIndex: i, type: "split", cards: h.cards.slice(), labels: h.labels.slice(), newHandIndex: i + 1, newHandCards: nh.cards.slice(), newHandLabels: nh.labels.slice() });
          if (isA) { acting = false; break; }
          continue;
        }
        if (move === "D" && canDouble) {
          h.bet *= 2; h.cards.push(shoe.draw()); h.labels.push(shoe.drawLabel());
          steps.push({ handIndex: i, type: "double", cards: h.cards.slice(), labels: h.labels.slice() });
          acting = false; break;
        }
        if (move === "D") move = "H";
        if (move === "P") move = "H"; // split not allowed here; treat as hit
        if (move === "H") {
          h.cards.push(shoe.draw()); h.labels.push(shoe.drawLabel());
          steps.push({ handIndex: i, type: "hit", cards: h.cards.slice(), labels: h.labels.slice() });
          continue;
        }
        steps.push({ handIndex: i, type: "stand", cards: h.cards.slice(), labels: h.labels.slice() });
        acting = false;
      }
      i++;
    }
    var out = hands.map(function (h) {
      return { cards: h.cards, bet: h.bet, busted: total(h.cards) > 21, blackjack: isBlackjack(h.cards) && hands.length === 1 };
    });
    return { hands: out, steps: steps };
  }

  // ── Round resolved hook: record + maybe improve ─────────────────────
  function onRoundResolved(info) {
    if (!orch) return;
    orch.recordRound({
      aiCards: info.aiCards, dealerUp: info.dealerUp,
      aiActions: null, aiNet: info.aiNet,
      aiBusted: info.aiBusted, aiBeatDealer: info.aiBeatDealer
    });
    // persist current policy into game state
    if (info.state && info.saveState) {
      info.state.policySource = orch.source;
      info.state.policyVersion = orch.version;
      info.saveState(info.state);
    }
    var playerBeatAI = info.playerNet > info.aiNet;
    if (orch.shouldImprove() && playerBeatAI) {
      // Capture generation synchronously before the async LLM call starts.
      // The onImprove hook reads _improveStartGen and _resetGen to detect staleness.
      _improveStartGen = _resetGen;
      orch.improve().then(function (res) {
        // Skip state persistence if a reset happened while the LLM was running.
        if (_resetGen !== _improveStartGen) return;
        if (res && res.status === "accepted" && info.state && info.saveState) {
          info.state.policySource = orch.source;
          info.state.policyVersion = orch.version;
          info.saveState(info.state);
        }
      }).catch(function () {});
    }
  }

  function onReset() {
    if (!orch) return;
    _resetGen++; // invalidate any in-flight improve so it can't land after the reset
    orch.history = [];
    orch._roundsSinceImprove = 0;
    orch.init(SEED_POLICY).then(function () {
      if (codeCard) codeCard.init(SEED_POLICY, 0);
    }).catch(function () {});
  }

  // ── Code card DOM ───────────────────────────────────────────────────
  function buildCodeCard() {
    var el = {
      version: document.getElementById("bjCodeVersion"),
      source: document.getElementById("bjCodeSource"),
      status: document.getElementById("bjCodeStatus"),
      history: document.getElementById("bjCodeHistory"),
      historyToggle: document.getElementById("bjCodeHistoryToggle"),
      histClear: document.getElementById("bjCodeHistClear"),
      toggle: document.getElementById("bjCodeToggle"),
      panel: document.getElementById("bjCodePanel"),
    };
    if (!el.source) return null;

    var versionsSeen = []; // {label, source, headerLabel}

    function renderHistoryList() {
      if (!el.history) return;
      el.history.innerHTML = "";
      versionsSeen.slice().reverse().forEach(function (v) {
        var b = document.createElement("button");
        b.className = "bj-code-hist-item";
        b.textContent = v.label;
        b.addEventListener("click", function () { setSource(v.source, v.headerLabel); });
        el.history.appendChild(b);
      });
      // show/hide the clear button based on whether there is anything to clear
      if (el.histClear) el.histClear.style.display = versionsSeen.length > 1 ? "" : "none";
    }

    function renderDiff(prev, next, headerLabel) {
      // simple line diff: mark added lines green, removed red
      var a = (prev || "").split("\n");
      var b = (next || "").split("\n");
      var bSet = {}; a.forEach(function (l) { bSet[l] = (bSet[l] || 0) + 1; });
      el.source.innerHTML = "";
      b.forEach(function (line) {
        var span = document.createElement("div");
        span.className = "bj-code-line" + (bSet[line] ? "" : " bj-code-add");
        span.textContent = line || " ";
        el.source.appendChild(span);
      });
      if (el.version && headerLabel) el.version.textContent = headerLabel;
      // fade the add highlight after 5s
      setTimeout(function () {
        Array.prototype.forEach.call(el.source.querySelectorAll(".bj-code-add"), function (n) {
          n.classList.remove("bj-code-add");
        });
      }, 5000);
    }

    function setSource(src, headerLabel) {
      if (el.version) el.version.textContent = headerLabel;
      el.source.innerHTML = "";
      (src || "").split("\n").forEach(function (line) {
        var d = document.createElement("div");
        d.className = "bj-code-line";
        d.textContent = line || " ";
        el.source.appendChild(d);
      });
    }

    function pushHistory(label, source, headerLabel) {
      versionsSeen.push({ label: label, source: source, headerLabel: headerLabel });
      renderHistoryList();
    }

    if (el.historyToggle && el.history) {
      el.historyToggle.addEventListener("click", function () {
        var open = el.history.classList.toggle("open");
        el.historyToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    if (el.histClear) {
      el.histClear.addEventListener("click", function () {
        // Keep only the current (most recent) entry; mutate in place so
        // pushHistory and renderHistoryList closures all see the change.
        if (versionsSeen.length > 1) {
          versionsSeen.splice(0, versionsSeen.length - 1);
        }
        renderHistoryList();
      });
    }
    if (el.toggle && el.panel) {
      el.toggle.addEventListener("click", function () {
        var open = el.panel.classList.toggle("open");
        el.toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    return {
      init: function (source, version) {
        versionsSeen.length = 0; // reset on every fresh start
        var headerLabel = t("heuristics.game.code_version", { v: "v" + version });
        setSource(source, headerLabel);
        pushHistory("v" + version + "  \u00b7  " + new Date().toLocaleTimeString(), source, headerLabel);
        if (el.status) el.status.textContent = "";
      },
      setThinking: function (on) { if (el.status) el.status.textContent = on ? t("heuristics.agent.thinking") : ""; },
      onAccepted: function (res) {
        var headerLabel = t("heuristics.game.code_version", { v: "v" + res.version });
        renderDiff(res.prevSource, res.source, headerLabel);
        if (el.status) el.status.textContent = t("heuristics.agent.patch_accepted", { provider: res.provider || "model" });
        pushHistory("v" + res.version + "  \u00b7  " + new Date().toLocaleTimeString(), res.source, headerLabel);
      },
      onRejected: function (reason) {
        if (el.status) el.status.textContent = t("heuristics.agent.patch_rejected", { reason: reason });
      },
      setNotice: function (msg) { if (el.status) el.status.textContent = msg; },
      // Fallback (no LLM key) mode: show the real, Monte-Carlo-verified
      // static policy function for the current level, with every version up
      // to it browsable in history \u2014 so technical viewers can see the actual
      // code evolve, not just the plain-English rules list.
      showStatic: function (versionObj, historyVersions) {
        //var headerLabel = versionObj.short + "  \u2014  " + versionObj.name;
        var headerLabel = t("heuristics.game.code_version", { v: versionObj.short });
        setSource(versionObj.fn.toString(), headerLabel);
        if (el.status) {
          el.status.textContent = t("heuristics.agent.builtin_notice", { v: versionObj.short });
        }
        versionsSeen.length = 0;
        historyVersions.forEach(function (v) {
          versionsSeen.push({
            label: v.short + "  \u00b7  " + v.name,
            source: v.fn.toString(),
            headerLabel: v.short + "  \u2014  " + v.name
          });
        });
        renderHistoryList();
      }
    };
  }

  // ── Settings modal DOM ──────────────────────────────────────────────
  function wireSettings(onEnabled) {
    var openBtn = document.getElementById("bjSettingsBtn");
    var modal = document.getElementById("bjSettingsModal");
    if (!openBtn || !modal) return;
    var groq = document.getElementById("bjKeyGroq");
    var openrouter = document.getElementById("bjKeyOpenRouter");
    var openai = document.getElementById("bjKeyOpenAI");
    var saveBtn = document.getElementById("bjKeysSave");
    var clearBtn = document.getElementById("bjKeysClear");
    var closeBtn = document.getElementById("bjSettingsClose");

    function open() {
      var k = AgentLLM.loadKeys();
      if (groq) groq.value = k.groq || "";
      if (openrouter) openrouter.value = k.openrouter || "";
      if (openai) openai.value = k.openai || "";
      modal.classList.add("show");
    }
    function close() { modal.classList.remove("show"); }

    openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });

    if (saveBtn) saveBtn.addEventListener("click", function () {
      AgentLLM.saveKeys({
        groq: groq ? groq.value.trim() : "",
        openrouter: openrouter ? openrouter.value.trim() : "",
        openai: openai ? openai.value.trim() : ""
      });
      close();
      // Fire the same reset as the Reset Game button before activating.
      // This guarantees a clean playing field and avoids every async race
      // condition around in-flight improve() calls: after a full game reset
      // there is nothing stale in memory or on screen.
      var resetBtn = document.getElementById("bjReset");
      if (resetBtn) resetBtn.click();
      onEnabled();
    });
    if (clearBtn) clearBtn.addEventListener("click", function () {
      AgentLLM.clearKeys();
      if (groq) groq.value = ""; if (openrouter) openrouter.value = ""; if (openai) openai.value = "";
      onEnabled(); // re-evaluate mode (will drop to fallback)
    });
  }

  // ── Panel visibility: the code card is always visible now (it shows the
  // real static policy source in fallback mode, and the live LLM-authored
  // source once the agent activates). Only the plain-English rules card
  // toggles, since it doesn't apply once the policy is model-authored.
  function setPanelMode(live) {
    var rulesPanel = document.getElementById("bjHeuristicsPanel");
    var rulesToggle = document.getElementById("bjHeuristicsToggle"); // mobile toggle
    if (!rulesPanel) return;
    if (live) {
      rulesPanel.style.display = "none";
      if (rulesToggle) rulesToggle.style.display = "none";
    } else {
      rulesPanel.style.display = "";
      if (rulesToggle) rulesToggle.style.display = "";
    }
  }

  // ── Fallback code display: render the real source of the currently
  // unlocked static policy version, with every version up to it in history.
  function renderStaticCode(level) {
    if (!codeCard || !gameApi || !gameApi.staticVersions) return;
    var versions = gameApi.staticVersions;
    var v = versions[level] || versions[0];
    codeCard.showStatic(v, versions.slice(0, level + 1));
  }

  // Called by blackjack.js whenever the static policy level changes
  // (initial paint, after a round, on reset). No-op while the live agent
  // owns the code card, so it can't clobber model-authored content.
  function onStaticLevelChange(level) {
    if (BJ.agent.active) return;
    renderStaticCode(level);
  }

  // ── Activation ──────────────────────────────────────────────────────
  async function activateLive() {
    ensureOrchestrator();
    _resetGen++; // invalidate any in-flight improve from a previous session
    try {
      await orch.init(SEED_POLICY);
      // A stale in-flight improve() can complete during the await above and
      // overwrite orch.source / orch.version in memory (the worker itself is
      // correctly reset by init, but JS in-memory state is not protected).
      // Force them back to v0 so we always display and evolve from the seed.
      orch.source = SEED_POLICY;
      orch.version = 0;
      orch.history = [];
      orch._roundsSinceImprove = 0;
      BJ.agent.active = true;
      setPanelMode(true);
      if (codeCard) codeCard.init(SEED_POLICY, 0);
      if (codeCard) codeCard.setNotice(t("heuristics.agent.live_notice"));
      if (gameApi) gameApi.announce(t("heuristics.agent.live_enabled"));
      if (gameApi && gameApi.updateLiveStats) gameApi.updateLiveStats();
    } catch (e) {
      BJ.agent.active = false;
      setPanelMode(false);
      var level = (gameApi && gameApi.state && gameApi.state.policyLevel) || 0;
      renderStaticCode(level);
      if (codeCard) codeCard.setNotice(t("heuristics.agent.live_failed"));
      if (gameApi && gameApi.updateLiveStats) gameApi.updateLiveStats();
    }
  }

  function refreshMode() {
    if (haveAnyKey()) {
      activateLive();
    } else {
      BJ.agent.active = false;
      setPanelMode(false);
      var level = (gameApi && gameApi.state && gameApi.state.policyLevel) || 0;
      renderStaticCode(level);
    }
  }

  // Called by blackjack.js when the language changes. The history button is
  // declarative now (data-i18n in index.html), so i18n.js repaints it for us.
  // What is left is the code card header and status line, which are written
  // from JS. The source listing itself is deliberately untouched: it is
  // JavaScript, not prose. The status line is only repainted in built-in mode,
  // because in live mode it may be holding a transient message (a patch result,
  // a rejection reason) that belongs to a moment that has passed.
  function onLanguageChange() {
    if (BJ.agent.active) return;
    var level = (gameApi && gameApi.state && gameApi.state.policyLevel) || 0;
    renderStaticCode(level);
  }

  // ── Public surface consumed by blackjack.js ─────────────────────────
  BJ.agent = {
    active: false,
    resolveAiHand: resolveAiHand,
    onRoundResolved: onRoundResolved,
    onReset: onReset,
    onStaticLevelChange: onStaticLevelChange,
    onLanguageChange: onLanguageChange
  };

  BJ.onGameReady = function (api) {
    gameApi = api;
    codeCard = buildCodeCard();
    wireSettings(refreshMode);
    refreshMode();
  };
})();
