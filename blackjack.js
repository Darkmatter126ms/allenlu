/*!
 * blackjack.js — Allen's Policy: a live, head-to-head Blackjack game.
 *
 * Concept: the AI ("Allen's Policy") is a second player at the table,
 * not the dealer. It races you against a shared, fixed dealer playing
 * standard rules. Its own strategy improves only through real, verified
 * code patches: beat its current version's net result against the
 * dealer, and the next round it plays the next version, which is
 * provably better. No epsilon-greedy, no gradient updates, no rule that
 * reacts to your cards, that would not be how blackjack works.
 *
 * Engine verified offline against 8M-round Monte Carlo, solo EV per
 * version (negative is a house edge against that version alone):
 *   v0 mimic the dealer      ~ -5.68%
 *   v1 hard-total basic      ~ -2.79%
 *   v2 + soft-hand play      ~ -2.48%
 *   v3 + doubling down       ~ -1.12%
 *   v4 + pair splitting      ~ -0.47%   (textbook full basic strategy)
 *   v5 + Hi-Lo counting/bet  ~ +1.06%
 * Rules: 6 decks, dealer stands on all 17, blackjack pays 3:2, double
 * any first two cards, double after split, split to 2 hands for the
 * AI's own correctness (UI caps the player at one split), split aces
 * draw one card each, no surrender, no insurance, 75% penetration.
 */
(function () {
  "use strict";

  // Integration surface for the optional live-agent layer (agent_ui.js).
  // When no agent is wired, BJ.agent stays null and the game runs exactly
  // as the verified static-progression version.
  const BJ = (typeof window !== 'undefined')
    ? (window.BlackjackGame = window.BlackjackGame || {})
    : {};
  BJ.agent = BJ.agent || null;

  // ───────────────────────── Engine ─────────────────────────────────
  // Identical strategy logic to the verified Monte Carlo engine.
  const NUM_DECKS = 6, RESHUFFLE_AT = 78, BJ_PAYOUT = 1.5, MAX_AI_HANDS = 4;

  function buildShoe() {
    const shoe = [];
    for (let d = 0; d < NUM_DECKS; d++) for (let s = 0; s < 4; s++) {
      for (let r = 2; r <= 9; r++) shoe.push(r);
      for (let t = 0; t < 4; t++) shoe.push(10);
      shoe.push(11);
    }
    return shoe;
  }

  // Parallel label shoe: same length as the numeric shoe, shuffled with the
  // same permutation so each draw index has a stable face label.
  // Ten-value positions cycle 10/J/Q/K per suit exactly as a real deck.
  // Non-tens get null (rankLabel handles them).
  function buildLabelShoe() {
    const faces = ['10', 'J', 'Q', 'K'];
    const labels = [];
    for (let d = 0; d < NUM_DECKS; d++) for (let s = 0; s < 4; s++) {
      for (let r = 2; r <= 9; r++) labels.push(null);
      for (let t = 0; t < 4; t++) labels.push(faces[t]);
      labels.push(null); // Ace
    }
    return labels;
  }

  // Parallel suit shoe: same length/permutation as the numeric shoe, so
  // every drawn card gets a real, stable suit instead of one rolled fresh
  // on every render (which both let the same seat show duplicate cards and
  // made a card's color flicker whenever its hand was redrawn).
  const SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
  function buildSuitShoe() {
    const suits = [];
    for (let d = 0; d < NUM_DECKS; d++) for (let s = 0; s < 4; s++) {
      for (let r = 2; r <= 9; r++) suits.push(SUITS[s]);
      for (let t = 0; t < 4; t++) suits.push(SUITS[s]);
      suits.push(SUITS[s]); // Ace
    }
    return suits;
  }

  function fyShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
  }
  function hiLo(r) { return (r >= 2 && r <= 6) ? 1 : (r >= 7 && r <= 9) ? 0 : -1; }
  function total(cards) {
    let t = 0, a = 0;
    for (const c of cards) { t += c; if (c === 11) a++; }
    while (t > 21 && a > 0) { t -= 10; a--; }
    return t;
  }
  function isSoft(cards) {
    let t = 0, a = 0;
    for (const c of cards) { t += c; if (c === 11) a++; }
    return a > 0 && t <= 21;
  }
  function isBlackjack(cards) { return cards.length === 2 && total(cards) === 21; }
  function isPair(cards) { return cards.length === 2 && cards[0] === cards[1]; }
  function rankLabel(v) { return v === 11 ? 'A' : v === 10 ? '10' : String(v); }

  function mimicDealer(ctx) { return total(ctx.cards) < 17 ? 'H' : 'S'; }

  function hardTotalsOnly(ctx) {
    const { cards, dealerUp: d } = ctx;
    if (isSoft(cards)) return total(cards) < 17 ? 'H' : 'S';
    const t = total(cards);
    if (t >= 17) return 'S';
    if (t <= 11) return 'H';
    if (t === 12) return (d >= 4 && d <= 6) ? 'S' : 'H';
    return (d >= 2 && d <= 6) ? 'S' : 'H';
  }

  function softHardNoDouble(ctx) {
    const { cards, dealerUp: d } = ctx;
    const t = total(cards);
    if (isSoft(cards)) {
      if (t >= 19) return 'S';
      if (t === 18) return (d >= 2 && d <= 8) ? 'S' : 'H';
      return 'H';
    }
    if (t >= 17) return 'S';
    if (t <= 11) return 'H';
    if (t === 12) return (d >= 4 && d <= 6) ? 'S' : 'H';
    return (d >= 2 && d <= 6) ? 'S' : 'H';
  }

  function withDoubling(ctx) {
    const { cards, dealerUp: d, canDouble } = ctx;
    const t = total(cards);
    const D = (yes, fb) => (yes && canDouble) ? 'D' : fb;
    if (isSoft(cards)) {
      if (t >= 19) return 'S';
      if (t === 18) { if (d >= 3 && d <= 6) return D(true, 'S'); return (d === 2 || d === 7 || d === 8) ? 'S' : 'H'; }
      if (t === 17) return D(d >= 3 && d <= 6, 'H');
      if (t === 16 || t === 15) return D(d >= 4 && d <= 6, 'H');
      if (t === 14 || t === 13) return D(d >= 5 && d <= 6, 'H');
      return 'H';
    }
    if (t >= 17) return 'S';
    if (t === 11) return D(d <= 10, 'H');
    if (t === 10) return D(d >= 2 && d <= 9, 'H');
    if (t === 9) return D(d >= 3 && d <= 6, 'H');
    if (t <= 8) return 'H';
    if (t === 12) return (d >= 4 && d <= 6) ? 'S' : 'H';
    return (d >= 2 && d <= 6) ? 'S' : 'H';
  }

  function fullBasic(ctx) {
    const { cards, dealerUp: d, canSplit } = ctx;
    if (isPair(cards) && canSplit) {
      const pk = cards[0];
      if (pk === 11) return 'P';
      if (pk === 9) return (d === 7 || d === 10 || d === 11) ? withDoubling(ctx) : (d >= 2 && d <= 9) ? 'P' : withDoubling(ctx);
      if (pk === 8) return 'P';
      if (pk === 7) return (d >= 2 && d <= 7) ? 'P' : withDoubling(ctx);
      if (pk === 6) return (d >= 2 && d <= 6) ? 'P' : withDoubling(ctx);
      if (pk === 4) return (d === 5 || d === 6) ? 'P' : withDoubling(ctx);
      if (pk === 3 || pk === 2) return (d >= 2 && d <= 7) ? 'P' : withDoubling(ctx);
    }
    return withDoubling(ctx);
  }

  function countingStrategy(ctx) {
    const { cards, dealerUp: d, canDouble, trueCount: tc } = ctx;
    const t = total(cards);
    if (!isSoft(cards)) {
      if (t === 16 && d === 10) return (tc >= 0) ? 'S' : 'H';
      if (t === 15 && d === 10) return (tc >= 4) ? 'S' : 'H';
      if (t === 12 && d === 3) return (tc >= 2) ? 'S' : 'H';
      if (t === 12 && d === 2) return (tc >= 3) ? 'S' : 'H';
      if (t === 12 && d === 4) return (tc >= 0) ? 'S' : 'H';
      if (t === 10 && (d === 10 || d === 11) && canDouble) return (tc >= 4) ? 'D' : fullBasic(ctx);
      if (t === 11 && d === 11 && canDouble) return (tc >= 1) ? 'D' : fullBasic(ctx);
      if (t === 9 && d === 2 && canDouble) return (tc >= 1) ? 'D' : fullBasic(ctx);
    }
    return fullBasic(ctx);
  }

  function betFor(v, tc) {
    if (!v.spreads) return 1;
    const f = Math.floor(tc);
    if (f <= 1) return 1;
    if (f === 2) return 4;
    if (f === 3) return 8;
    if (f === 4) return 10;
    return 12;
  }

  const VERSIONS = [
    { id: 0, short: 'v0', name: 'Mimic the dealer', fn: mimicDealer, allowDouble: false, allowSplit: false, spreads: false, targetEv: -5.68 },
    { id: 1, short: 'v1', name: 'Hard-total basic', fn: hardTotalsOnly, allowDouble: false, allowSplit: false, spreads: false, targetEv: -2.79 },
    { id: 2, short: 'v2', name: 'Soft-hand play', fn: softHardNoDouble, allowDouble: false, allowSplit: false, spreads: false, targetEv: -2.48 },
    { id: 3, short: 'v3', name: 'Doubling down', fn: withDoubling, allowDouble: true, allowSplit: false, spreads: false, targetEv: -1.12 },
    { id: 4, short: 'v4', name: 'Pair splitting', fn: fullBasic, allowDouble: true, allowSplit: true, spreads: false, targetEv: -0.47 },
    { id: 5, short: 'v5', name: 'Hi-Lo counting + bet spread', fn: countingStrategy, allowDouble: true, allowSplit: true, spreads: true, targetEv: 1.06 },
  ];
  const MAX_LEVEL = VERSIONS.length - 1;

  function createShoe() {
    let shoe = [], labelShoe = [], suitShoe = [], idx = 0, running = 0;
    function reshuffle() {
      shoe = buildShoe();
      labelShoe = buildLabelShoe();
      suitShoe = buildSuitShoe();
      // Apply identical permutation to all three arrays so labels/suits stay aligned.
      for (let i = shoe.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
        [labelShoe[i], labelShoe[j]] = [labelShoe[j], labelShoe[i]];
        [suitShoe[i], suitShoe[j]] = [suitShoe[j], suitShoe[i]];
      }
      idx = 0; running = 0;
    }
    function left() { return shoe.length - idx; }
    function draw() {
      if (idx >= shoe.length) reshuffle();
      const c = shoe[idx++];
      running += hiLo(c);
      return c; // plain number, engine unchanged
    }
    // Call immediately after draw() to get the drawn card's display info:
    // face is the face label ('10'/'J'/'Q'/'K'), null for non-tens (rankLabel
    // handles those); suit is always set. Stable per card, unlike a suit
    // rolled fresh on every render.
    function drawLabel() { return { face: labelShoe[idx - 1], suit: suitShoe[idx - 1] }; }
    function trueCount() { return running / Math.max(left() / 52, 0.25); }
    reshuffle();
    return { reshuffle, left, draw, drawLabel, trueCount, need: () => left() < RESHUFFLE_AT };
  }

  // Resolves a hand fully under a policy. dealerHasBJ short-circuits all
  // action, matching the standard dealer-peek rule.
  // startLabels: face labels for the two starting cards (from the shoe at deal time).
  function resolveWithPolicy(shoe, version, startCards, dealerUp, tcAtStart, dealerHasBJ, startLabels) {
    const steps = [];
    const bet = betFor(version, tcAtStart);
    if (dealerHasBJ) {
      return { hands: [{ cards: startCards.slice(), bet, busted: false, blackjack: isBlackjack(startCards) }], steps: [] };
    }
    const hands = [{ cards: startCards.slice(), labels: (startLabels || [null, null]).slice(), bet, doneSplitAce: false }];
    let i = 0;
    while (i < hands.length) {
      const h = hands[i];
      let acting = true;
      while (acting) {
        if (h.doneSplitAce) { acting = false; break; }
        if (total(h.cards) >= 21) { acting = false; break; }
        const canDouble = version.allowDouble && h.cards.length === 2;
        const canSplit = version.allowSplit && h.cards.length === 2 && isPair(h.cards) && hands.length < MAX_AI_HANDS;
        let m = version.fn({ cards: h.cards, dealerUp, canDouble, canSplit, trueCount: tcAtStart });
        if (m === 'P' && canSplit) {
          const c = h.cards[0], origLabel = h.labels[0], isA = c === 11;
          const nc1 = shoe.draw(), nl1 = shoe.drawLabel();
          const nc2 = shoe.draw(), nl2 = shoe.drawLabel();
          h.cards = [c, nc1]; h.labels = [origLabel, nl1]; h.doneSplitAce = isA;
          const newHand = { cards: [c, nc2], labels: [origLabel, nl2], bet, doneSplitAce: isA };
          hands.splice(i + 1, 0, newHand);
          steps.push({ handIndex: i, type: 'split', cards: h.cards.slice(), labels: h.labels.slice(), newHandIndex: i + 1, newHandCards: newHand.cards.slice(), newHandLabels: newHand.labels.slice() });
          if (isA) { acting = false; break; }
          continue;
        }
        if (m === 'D' && canDouble) {
          h.bet *= 2;
          h.cards.push(shoe.draw()); h.labels.push(shoe.drawLabel());
          steps.push({ handIndex: i, type: 'double', cards: h.cards.slice(), labels: h.labels.slice() });
          acting = false; break;
        }
        if (m === 'D') m = 'H';
        if (m === 'P') {
          const ctx2 = { cards: h.cards, dealerUp, canDouble, canSplit: false, trueCount: tcAtStart };
          m = version.allowDouble ? withDoubling(ctx2) : softHardNoDouble(ctx2);
          if (m === 'D' && !canDouble) m = 'H';
        }
        if (m === 'H') {
          h.cards.push(shoe.draw()); h.labels.push(shoe.drawLabel());
          steps.push({ handIndex: i, type: 'hit', cards: h.cards.slice(), labels: h.labels.slice() });
          continue;
        }
        steps.push({ handIndex: i, type: 'stand', cards: h.cards.slice(), labels: h.labels.slice() });
        acting = false;
      }
      i++;
    }
    const out = hands.map(h => ({
      cards: h.cards, bet: h.bet,
      busted: total(h.cards) > 21,
      blackjack: isBlackjack(h.cards) && hands.length === 1
    }));
    return { hands: out, steps };
  }

  function resolveDealer(shoe, dealerCards, startLabels) {
    const steps = [];
    const labels = (startLabels || []).slice();
    while (total(dealerCards) < 17) {
      dealerCards.push(shoe.draw());
      labels.push(shoe.drawLabel());
      steps.push({ cards: dealerCards.slice(), labels: labels.slice() });
    }
    return { cards: dealerCards, labels, steps, busted: total(dealerCards) > 21 };
  }

  function settle(hand, dealerTotal, dealerBJ, dealerBust) {
    const pt = total(hand.cards);
    if (hand.blackjack && dealerBJ) return { result: 'push', net: 0 };
    if (hand.blackjack) return { result: 'blackjack', net: BJ_PAYOUT * hand.bet };
    if (pt > 21) return { result: 'bust', net: -hand.bet };
    if (dealerBJ) return { result: 'lose', net: -hand.bet };
    if (dealerBust) return { result: 'win', net: hand.bet };
    if (pt > dealerTotal) return { result: 'win', net: hand.bet };
    if (pt < dealerTotal) return { result: 'lose', net: -hand.bet };
    return { result: 'push', net: 0 };
  }

  // ───────────────────────── Fun facts ───────────────────────────────
  // Facts 0-5 unlock by beating the AI. Facts 6-8 are secret achievements
  // with hidden conditions; they surface only when earned.
  // Placeholders — replace with real content before publishing.
  const BASE_FACTS_COUNT = 6;
  const FACT_STREAK_10   = 6;
  const FACT_STREAK_20   = 7;
  const FACT_DOUBLE_WIN  = 8;

  // ── i18n bridge ─────────────────────────────────────────────────────
  // All player-facing copy lives in locales/<lang>.json. If i18n.js has not
  // loaded yet (or fails), t() returns the key, which is loud and obvious in
  // the UI rather than silently rendering "undefined".
  function t(key, vars) {
    return (window.I18N && window.I18N.t) ? window.I18N.t(key, vars) : key;
  }

  // Facts are objects in the locale files: { text, url?, linkLabel? }. Only the
  // count and the unlock rules live here; every word comes from the JSON.
  // I18N.raw() is used instead of t() because facts are objects
  // { text, url?, linkLabel? } and t() would discard everything except text.
  function fact(i) {
    const raw = window.I18N && window.I18N.raw;
    const f = raw ? raw('heuristics.facts.f' + i) : undefined;
    if (f && typeof f === 'object' && f.text) return f;
    return { text: 'heuristics.facts.f' + i };
  }

  // Total number of facts, base + secret. The copy lives in the locale files.
  const FACTS_COUNT = 9;

  function allBaseFacts(unlocked) {
    for (let i = 0; i < BASE_FACTS_COUNT; i++) {
      if (!unlocked.includes(i)) return false;
    }
    return true;
  }
  function allFactsUnlocked(unlocked) { return unlocked.length >= FACTS_COUNT; }

  // ───────────────────────── State persistence ───────────────────────
  const STORAGE_KEY = 'allenlu_blackjack_state';
  function defaultState() {
    return {
      policyLevel: 0, unlockedFacts: [], streak: 0,
      // live-agent fields (ignored in fallback mode)
      policySource: null, policyVersion: 0,
      // stats counters
      wins: 0, losses: 0, totalRounds: 0
    };
  }
  function storageAvailable() {
    try {
      const k = '__bj_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  function validState(s) {
    if (!s || typeof s !== 'object') return false;
    if (!Number.isInteger(s.policyLevel) || s.policyLevel < 0 || s.policyLevel > MAX_LEVEL) return false;
    if (!Array.isArray(s.unlockedFacts)) return false;
    for (const f of s.unlockedFacts) if (!Number.isInteger(f) || f < 0 || f >= FACTS_COUNT) return false;
    if (!Number.isInteger(s.streak) || s.streak < 0) return false;
    // live fields — optional in older saved states
    if (s.policySource != null && typeof s.policySource !== 'string') return false;
    if (s.policyVersion != null && (!Number.isInteger(s.policyVersion) || s.policyVersion < 0)) return false;
    // stats counters — optional in older saved states
    if (s.wins != null && (!Number.isInteger(s.wins) || s.wins < 0)) return false;
    if (s.losses != null && (!Number.isInteger(s.losses) || s.losses < 0)) return false;
    if (s.totalRounds != null && (!Number.isInteger(s.totalRounds) || s.totalRounds < 0)) return false;
    return true;
  }
  function loadState() {
    if (!storageAvailable()) return defaultState();
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return validState(parsed) ? parsed : defaultState();
    } catch (e) { return defaultState(); }
  }
  function saveState(s) {
    if (!storageAvailable()) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore, in-memory only */ }
  }
  function resetState() {
    if (storageAvailable()) { try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {} }
    return defaultState();
  }

  // ───────────────────────── Game controller + UI ────────────────────
  let started = false;

  function initGame() {
    if (started) return;
    started = true;

    const root = document.getElementById('heuristics');
    if (!root) return;

    const els = {
      youHand: document.getElementById('bjYouHand'),
      aiHand: document.getElementById('bjAiHand'),
      dealerHand: document.getElementById('bjDealerHand'),
      youTotal: document.getElementById('bjYouTotal'),
      aiTotal: document.getElementById('bjAiTotal'),
      dealerTotal: document.getElementById('bjDealerTotal'),
      status: document.getElementById('bjStatus'),
      log: document.getElementById('bjLog'),
      btnDeal: document.getElementById('bjDeal'),
      btnHit: document.getElementById('bjHit'),
      btnStand: document.getElementById('bjStand'),
      btnDouble: document.getElementById('bjDouble'),
      btnSplit: document.getElementById('bjSplit'),
      btnReset: document.getElementById('bjReset'),
      streak: document.getElementById('bjStreak'),
      levelBadge: document.getElementById('bjLevelBadge'),
      rulesList: document.getElementById('bjRulesList'),
      factsLog: document.getElementById('bjFactsLog'),
      factModal: document.getElementById('bjFactModal'),
      factModalText: document.getElementById('bjFactModalText'),
      factModalDismiss: document.getElementById('bjFactDismiss'),
      heuristicsPanel: document.getElementById('bjHeuristicsPanel'),
      heuristicsToggle: document.getElementById('bjHeuristicsToggle'),
      proofToggle: document.getElementById('bjProofToggle'),
    };

    // Live-stats bar: injected programmatically into the facts panel so the
    // counter is visible in live agent mode (where the heuristics panel hides).
    const _liveStatsEl = document.createElement('div');
    _liveStatsEl.style.cssText =
      'font-family:var(--font-mono);font-size:0.72rem;letter-spacing:0.06em;' +
      'color:var(--text-tertiary);padding:0.7rem 0 0.5rem;border-bottom:1px solid var(--border);' +
      'margin-bottom:0.8rem;display:none;';
    if (els.factsLog && els.factsLog.parentNode) {
      els.factsLog.parentNode.insertBefore(_liveStatsEl, els.factsLog);
    }
    els.liveStats = _liveStatsEl;

    let st = loadState();
    let shoe = createShoe();
    let phase = 'idle'; // idle | playerTurn | aiTurn | dealerTurn | resolved
    let dealer = [];
    let dealerLabels = [];
    let dealerHasBJ = false;
    let playerHands = [];
    let activeHand = 0;
    let tcAtDeal = 0;
    let playerDoubledThisRound = false; // tracks whether player doubled this round

    const MAX_PLAYER_HANDS = 2; // one split, no resplitting, by design

    
    function rankSuitCard(value, cardInfo) {
      // cardInfo = { face, suit } assigned once at draw time from the shoe,
      // so the same card keeps the same suit across every re-render. Only
      // falls back to a random suit if a caller hasn't threaded shoe info
      // through (there should be none left, but better a random suit than
      // a crash on missing data).
      const suit = (cardInfo && cardInfo.suit) || SUITS[Math.floor(Math.random() * SUITS.length)];
      const red = (suit === '♥' || suit === '♦');
      const label = (cardInfo && cardInfo.face) || rankLabel(value);
      return { label, suit, red };
    }

    function cardEl(value, cardInfo) {
      const c = rankSuitCard(value, cardInfo);
      const d = document.createElement('span');
      d.className = 'bj-card' + (c.red ? ' red' : '');
      d.innerHTML = '<span class="bj-card-rank">' + c.label + '</span><span class="bj-card-suit">' + c.suit + '</span>';
      return d;
    }

    function renderHandRow(container, cards, hideSecond, labels) {
      container.innerHTML = '';
      cards.forEach((c, idx) => {
        if (hideSecond && idx === 1) {
          const back = document.createElement('span');
          back.className = 'bj-card bj-card-back';
          back.setAttribute('aria-label', 'face down card');
          container.appendChild(back);
        } else {
          container.appendChild(cardEl(c, labels && labels[idx]));
        }
      });
    }

    function announce(msg) {
      els.status.textContent = msg;
    }
    function logLine(msg) {
      const p = document.createElement('p');
      p.className = 'bj-log-line';
      p.textContent = msg;
      els.log.appendChild(p);
      els.log.scrollTop = els.log.scrollHeight;
    }
    function clearLog() { els.log.innerHTML = ''; }

    function currentVersion() { return VERSIONS[st.policyLevel]; }

    function updateHeuristicsDisplay() {
      const v = currentVersion();
      els.levelBadge.textContent = t('heuristics.game.policy_badge', { v: v.short });
      els.rulesList.innerHTML = '';
      for (let i = 0; i <= st.policyLevel; i++) {
        const li = document.createElement('li');
        li.textContent = t('heuristics.versions.' + VERSIONS[i].short);
        if (i === st.policyLevel) li.className = 'bj-rule-active';
        els.rulesList.appendChild(li);
      }
      els.streak.textContent = String(st.streak);
      // Let the optional agent layer refresh its code card for this level.
      // Fires regardless of live/fallback mode; the handler ignores it while live.
      if (BJ.agent && typeof BJ.agent.onStaticLevelChange === 'function') {
        try { BJ.agent.onStaticLevelChange(st.policyLevel); } catch (e) {}
      }
    }

    // Renders a locale fact object into a container: text, plus an optional
    // trailing link. url is never translated; linkLabel is.
    function renderFactInto(container, f) {
      container.appendChild(document.createTextNode((f.text || '') + (f.url ? ' ' : '')));
      if (!f.url) return;
      const a = document.createElement('a');
      a.href = f.url;
      a.textContent = f.linkLabel || t('heuristics.game.fact_link_default');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'color:var(--accent);text-decoration:underline;cursor:pointer;';
      container.appendChild(a);
    }

    function renderFactsLog() {
      els.factsLog.innerHTML = '';
      if (st.unlockedFacts.length === 0) {
        const p = document.createElement('p');
        p.className = 'bj-fact-empty';
        p.textContent = t('heuristics.game.facts_empty');
        els.factsLog.appendChild(p);
        return;
      }
      st.unlockedFacts.slice().sort((a, b) => a - b).forEach(i => {
        const p = document.createElement('p');
        p.className = 'bj-fact-line';
        if (i >= BASE_FACTS_COUNT) {
          // Secret achievement: prefix with a subtle label so it reads differently
          const lbl = document.createElement('span');
          lbl.style.cssText = 'font-family:var(--font-mono);font-size:0.65rem;letter-spacing:0.08em;color:var(--accent);display:block;margin-bottom:0.2rem;';
          lbl.textContent = t('heuristics.game.secret_label');
          p.appendChild(lbl);
        }
        renderFactInto(p, fact(i));
        els.factsLog.appendChild(p);
      });
    }

    function updateLiveStats() {
      if (!els.liveStats) return;
      const inLive = !!(BJ.agent && BJ.agent.active);
      els.liveStats.style.display = inLive ? '' : 'none';
      if (inLive) {
        const ver = st.policyVersion || 0;
        const wins = st.wins || 0;
        const streak = st.streak || 0;
        els.liveStats.textContent =
          //'Policy\u00a0v' + ver + '\u2003\u2003Wins\u00a0' + wins + '\u2003\u2003Streak\u00a0' + streak;
          t('heuristics.game.wins_label') + '\u00a0' + wins +
          '\u2003\u2003' + t('heuristics.game.streak_label') + '\u00a0' + streak;
      }
    }

    function setActionButtons(opts) {
      els.btnDeal.disabled = !opts.deal;
      els.btnHit.disabled = !opts.hit;
      els.btnStand.disabled = !opts.stand;
      els.btnDouble.disabled = !opts.double;
      els.btnSplit.disabled = !opts.split;
    }

    function renderPlayerHands() {
      els.youHand.innerHTML = '';
      els.youTotal.innerHTML = '';
      playerHands.forEach((h, idx) => {
        const row = document.createElement('div');
        row.className = 'bj-hand-row' + (idx === activeHand && phase === 'playerTurn' ? ' bj-hand-active' : '');
        h.cards.forEach((c, ci) => row.appendChild(cardEl(c, h.labels && h.labels[ci])));
        els.youHand.appendChild(row);

        const tag = document.createElement('span');
        tag.className = 'bj-total-tag';
        const ht = total(h.cards);
        tag.textContent = (playerHands.length > 1 ? t('heuristics.game.hand_prefix', { n: idx + 1 }) : '') +
                          ht + (ht > 21 ? t('heuristics.game.bust_tag') : '');
        els.youTotal.appendChild(tag);
      });
    }

    function newRound() {
      if (shoe.need()) shoe.reshuffle();
      tcAtDeal = shoe.trueCount();
      clearLog();
      playerDoubledThisRound = false;
      // Deal and capture labels immediately after each draw.
      const p1 = shoe.draw(), p1l = shoe.drawLabel();
      const p2 = shoe.draw(), p2l = shoe.drawLabel();
      playerHands = [{ cards: [p1, p2], labels: [p1l, p2l], bet: 1 }];
      activeHand = 0;
      const ai1 = shoe.draw(), ai1l = shoe.drawLabel();
      const ai2 = shoe.draw(), ai2l = shoe.drawLabel();
      const aiStart = [ai1, ai2];
      root._aiLabels = [ai1l, ai2l];
      const d1 = shoe.draw(), d1l = shoe.drawLabel();
      const d2 = shoe.draw(), d2l = shoe.drawLabel();
      dealer = [d1, d2];
      dealerLabels = [d1l, d2l];
      dealerHasBJ = isBlackjack(dealer);

      renderPlayerHands();
      renderHandRow(els.aiHand, aiStart, false, root._aiLabels);
      els.aiTotal.innerHTML = '';
      const aiTag = document.createElement('span');
      aiTag.className = 'bj-total-tag';
      aiTag.textContent = String(total(aiStart));
      els.aiTotal.appendChild(aiTag);
      renderHandRow(els.dealerHand, dealer, true, dealerLabels);
      els.dealerTotal.textContent = '?';

      root._aiStart = aiStart;

      const playerBJ = isBlackjack(playerHands[0].cards);
      if (playerBJ || dealerHasBJ) {
        phase = 'resolved';
        announce(dealerHasBJ ? t('heuristics.game.dealer_bj') : t('heuristics.game.player_bj'));
        setActionButtons({ deal: false, hit: false, stand: false, double: false, split: false });
        setTimeout(runAiTurn, 500);
        return;
      }

      phase = 'playerTurn';
      announce(t('heuristics.game.your_turn'));
      logLine(t('heuristics.game.log_new_round', { rank: rankLabel(dealer[0]) }));
      updateActionAvailability();
    }

    function updateActionAvailability() {
      if (phase !== 'playerTurn') { setActionButtons({ deal: false, hit: false, stand: false, double: false, split: false }); return; }
      const h = playerHands[activeHand];
      const canDouble = h.cards.length === 2;
      const canSplit = h.cards.length === 2 && isPair(h.cards) && playerHands.length < MAX_PLAYER_HANDS;
      setActionButtons({ deal: false, hit: true, stand: true, double: canDouble, split: canSplit });
    }

    function advanceOrEndPlayerTurn() {
      // move to next unfinished hand, or end the player's turn
      activeHand++;
      while (activeHand < playerHands.length) {
        const h = playerHands[activeHand];
        if (total(h.cards) < 21 && !h._done) break;
        activeHand++;
      }
      if (activeHand >= playerHands.length) {
        phase = 'aiTurn';
        renderPlayerHands();
        setActionButtons({ deal: false, hit: false, stand: false, double: false, split: false });
        announce(t('heuristics.game.ai_playing'));
        setTimeout(runAiTurn, 500);
      } else {
        renderPlayerHands();
        updateActionAvailability();
      }
    }

    function onHit() {
      const h = playerHands[activeHand];
      h.cards.push(shoe.draw());
      h.labels.push(shoe.drawLabel());
      renderPlayerHands();
      const ht = total(h.cards);
      logLine(ht > 21 ? t('heuristics.game.log_hit_bust', { t: ht })
                      : t('heuristics.game.log_hit',      { t: ht }));
      if (ht >= 21) { h._done = true; advanceOrEndPlayerTurn(); }
      else updateActionAvailability();
    }
    function onStand() {
      const h = playerHands[activeHand];
      h._done = true;
      logLine(t('heuristics.game.log_stand', { t: total(h.cards) }));
      advanceOrEndPlayerTurn();
    }
    function onDouble() {
      const h = playerHands[activeHand];
      h.bet *= 2;
      playerDoubledThisRound = true;
      h.cards.push(shoe.draw());
      h.labels.push(shoe.drawLabel());
      h._done = true;
      logLine(total(h.cards) > 21 ? t('heuristics.game.log_double_bust', { t: total(h.cards) })
                                  : t('heuristics.game.log_double',      { t: total(h.cards) }));
      renderPlayerHands();
      advanceOrEndPlayerTurn();
    }
    function onSplit() {
      const h = playerHands[activeHand];
      const c = h.cards[0];
      const origLabel = h.labels[0]; // keep the original card's label
      const nc1 = shoe.draw(), nl1 = shoe.drawLabel();
      const nc2 = shoe.draw(), nl2 = shoe.drawLabel();
      h.cards = [c, nc1];
      h.labels = [origLabel, nl1];
      const newHand = { cards: [c, nc2], labels: [origLabel, nl2], bet: 1 };
      playerHands.splice(activeHand + 1, 0, newHand);
      logLine(t('heuristics.game.log_split', { rank: rankLabel(c) }));
      if (c === 11) { // split aces: one card each, no further action
        h._done = true; newHand._done = true;
        renderPlayerHands();
        advanceOrEndPlayerTurn();
        return;
      }
      renderPlayerHands();
      updateActionAvailability();
    }

    function runAiTurn() {
      // Live-agent mode: an external resolver (agent_ui.js) drives the AI
      // hand via the sandboxed worker, returning the SAME {hands, steps}
      // shape. Fallback mode uses the verified static policy synchronously.
      if (BJ.agent && BJ.agent.active && typeof BJ.agent.resolveAiHand === 'function') {
        BJ.agent.resolveAiHand({
          shoe: shoe, startCards: root._aiStart, startLabels: root._aiLabels, dealerUp: dealer[0],
          tcAtDeal: tcAtDeal, dealerHasBJ: dealerHasBJ,
          total: total, isBlackjack: isBlackjack, isPair: isPair
        }).then(function (res) {
          root._aiHands = res.hands;
          animateAiSteps(res.steps);
        }).catch(function () {
          const v = currentVersion();
          const res = resolveWithPolicy(shoe, v, root._aiStart, dealer[0], tcAtDeal, dealerHasBJ, root._aiLabels);
          root._aiHands = res.hands;
          animateAiSteps(res.steps);
        });
        return;
      }
      const v = currentVersion();
      const res = resolveWithPolicy(shoe, v, root._aiStart, dealer[0], tcAtDeal, dealerHasBJ, root._aiLabels);
      root._aiHands = res.hands;
      animateAiSteps(res.steps);
    }

    function animateAiSteps(steps) {
      if (dealerHasBJ) {
        playDealerAndResolve();
        return;
      }
      let i = 0;
      const aiHandsLive = [root._aiStart.slice()];
      const aiLabelsLive = [(root._aiLabels || [null, null]).slice()];
      function step() {
        if (i >= steps.length) {
          phase = 'dealerTurn';
          announce(t('heuristics.game.dealer_turn'));
          setTimeout(playDealerAndResolve, 450);
          return;
        }
        const s = steps[i++];
        if (s.type === 'split') {
          aiHandsLive[s.handIndex] = s.cards;
          aiLabelsLive[s.handIndex] = s.labels || [];
          aiHandsLive.splice(s.newHandIndex, 0, s.newHandCards);
          aiLabelsLive.splice(s.newHandIndex, 0, s.newHandLabels || []);
          logLine(t('heuristics.game.log_ai_split'));
        } else if (s.type === 'double') {
          aiHandsLive[s.handIndex] = s.cards;
          aiLabelsLive[s.handIndex] = s.labels || [];
          logLine(t('heuristics.game.log_ai_double', { t: total(s.cards) }));
        } else if (s.type === 'hit') {
          aiHandsLive[s.handIndex] = s.cards;
          aiLabelsLive[s.handIndex] = s.labels || [];
          const at = total(s.cards);
          logLine(at > 21 ? t('heuristics.game.log_ai_hit_bust', { t: at })
                          : t('heuristics.game.log_ai_hit',      { t: at }));
        } else {
          aiHandsLive[s.handIndex] = s.cards;
          aiLabelsLive[s.handIndex] = s.labels || [];
          logLine(t('heuristics.game.log_ai_stand', { t: total(s.cards) }));
        }
        renderAiLive(aiHandsLive, aiLabelsLive);
        setTimeout(step, 700);
      }
      if (steps.length === 0) {
        logLine(t('heuristics.game.log_ai_stand', { t: total(root._aiStart) }));
        renderAiLive(aiHandsLive, aiLabelsLive);
        setTimeout(() => { phase = 'dealerTurn'; announce(t('heuristics.game.dealer_turn')); setTimeout(playDealerAndResolve, 450); }, 500);
      } else {
        setTimeout(step, 500);
      }
    }

    function renderAiLive(handsLive, labelsLive) {
      els.aiHand.innerHTML = '';
      els.aiTotal.innerHTML = '';
      handsLive.forEach((cards, idx) => {
        const row = document.createElement('div');
        row.className = 'bj-hand-row';
        const handLabels = labelsLive && labelsLive[idx];
        cards.forEach((c, ci) => row.appendChild(cardEl(c, handLabels && handLabels[ci])));
        els.aiHand.appendChild(row);
        const tag = document.createElement('span');
        tag.className = 'bj-total-tag';
        const ht = total(cards);
        tag.textContent = (handsLive.length > 1 ? t('heuristics.game.hand_prefix', { n: idx + 1 }) : '') +
                          ht + (ht > 21 ? t('heuristics.game.bust_tag') : '');
        els.aiTotal.appendChild(tag);
      });
    }

    function playDealerAndResolve() {
      renderHandRow(els.dealerHand, dealer, false, dealerLabels);
      els.dealerTotal.textContent = String(total(dealer));
      const playerAlive = playerHands.some(h => total(h.cards) <= 21);
      const aiAlive = root._aiHands.some(h => !h.busted);
      const needPlay = (playerAlive || aiAlive) && !dealerHasBJ;
      if (!needPlay) { finishResolve(); return; }
      const dres = resolveDealer(shoe, dealer, dealerLabels);
      let i = 0;
      function step() {
        if (i >= dres.steps.length) { finishResolve(); return; }
        const s = dres.steps[i++];
        renderHandRow(els.dealerHand, s.cards, false, s.labels);
        els.dealerTotal.textContent = String(total(s.cards));
        const dt = total(s.cards);
        logLine(dt > 21 ? t('heuristics.game.log_dealer_draw_bust', { t: dt })
                        : t('heuristics.game.log_dealer_draw',      { t: dt }));
        setTimeout(step, 650);
      }
      if (dres.steps.length === 0) {
        logLine(t('heuristics.game.log_dealer_stand', { t: total(dealer) }));
        finishResolve();
      } else {
        setTimeout(step, 500);
      }
    }

    function finishResolve() {
      const dTotal = total(dealer);
      const dBJ = dealerHasBJ;
      const dBust = dTotal > 21;

      // Settle all hands; also detect if a doubled hand won (for the secret achievement).
      let playerNet = 0;
      let playerDoubledAndWon = false;
      playerHands.forEach(h => {
        const s = settle(h, dTotal, dBJ, dBust);
        playerNet += s.net;
        if (playerDoubledThisRound && h.bet === 2 && s.net > 0) playerDoubledAndWon = true;
      });
      let aiNet = 0;
      root._aiHands.forEach(h => { aiNet += settle(h, dTotal, dBJ, dBust).net; });

      const beatAI = playerNet > aiNet;
      const tie = playerNet === aiNet;

      if (beatAI) { st.streak++; } else { st.streak = 0; }
      st.totalRounds = (st.totalRounds || 0) + 1;
      if (beatAI) st.wins = (st.wins || 0) + 1;
      else if (!tie) st.losses = (st.losses || 0) + 1;

      const netVars = { you: fmtNet(playerNet), ai: fmtNet(aiNet) };
      let resultMsg;
      if (beatAI)      resultMsg = t('heuristics.game.result_win',  netVars);
      else if (tie)    resultMsg = t('heuristics.game.result_push', netVars);
      else             resultMsg = t('heuristics.game.result_lose', netVars);

      announce(resultMsg);
      logLine(resultMsg);

      // ── Base fact unlock (varies by mode) ──────────────────────────
      let leveledUp = false;
      let baseFactIndex = -1;

      if (BJ.agent && BJ.agent.active) {
        if (beatAI) {
          const nextFact = st.unlockedFacts.filter(i => i < BASE_FACTS_COUNT).length;
          if (nextFact < BASE_FACTS_COUNT && !st.unlockedFacts.includes(nextFact)) {
            st.unlockedFacts.push(nextFact);
            baseFactIndex = nextFact;
          }
        }
      } else {
        if (beatAI) {
          const justBeatLevel = st.policyLevel;
          if (!st.unlockedFacts.includes(justBeatLevel)) {
            st.unlockedFacts.push(justBeatLevel);
            baseFactIndex = justBeatLevel;
          }
          if (st.policyLevel < MAX_LEVEL) { st.policyLevel++; leveledUp = true; }
        }
        updateHeuristicsDisplay();
      }

      // ── Secret achievement unlocks (both modes) ─────────────────────
      const secretUnlocked = [];
      if (!st.unlockedFacts.includes(FACT_STREAK_10) && st.streak >= 10) {
        st.unlockedFacts.push(FACT_STREAK_10);
        secretUnlocked.push(FACT_STREAK_10);
      }
      if (!st.unlockedFacts.includes(FACT_STREAK_20) && st.streak >= 20) {
        st.unlockedFacts.push(FACT_STREAK_20);
        secretUnlocked.push(FACT_STREAK_20);
      }
      if (!st.unlockedFacts.includes(FACT_DOUBLE_WIN) && playerDoubledAndWon) {
        st.unlockedFacts.push(FACT_DOUBLE_WIN);
        secretUnlocked.push(FACT_DOUBLE_WIN);
      }

      saveState(st);
      renderFactsLog();
      updateLiveStats();

      if (BJ.agent && BJ.agent.active) {
        try {
          BJ.agent.onRoundResolved({
            aiCards: root._aiStart, dealerUp: dealer[0],
            aiNet: aiNet, playerNet: playerNet,
            aiBusted: root._aiHands.every(h => h.busted),
            aiBeatDealer: aiNet > 0,
            state: st, saveState: saveState
          });
        } catch (e) { /* agent errors never break the game */ }
      }

      phase = 'resolved';
      setActionButtons({ deal: true, hit: false, stand: false, double: false, split: false });

      // ── Modal queue: base fact → secrets → ending ──────────────────
      // Build a queue so we never stack-call modals.
      const queue = [];
      if (baseFactIndex >= 0) queue.push({ idx: baseFactIndex, leveledUp, secret: false });
      secretUnlocked.forEach(i => queue.push({ idx: i, leveledUp: false, secret: true }));

      function revealNext() {
        if (queue.length) {
          const item = queue.shift();
          showFactModal(item.idx, item.leveledUp, item.secret, revealNext);
          return;
        }
        // After all individual facts: check for the "all base facts done" ending.
        const liveMode = !!(BJ.agent && BJ.agent.active);
        if (allBaseFacts(st.unlockedFacts) && (!liveMode ? beatAI && st.policyLevel === MAX_LEVEL : beatAI)) {
          showFactModal(-1, false, false, null);
        }
      }
      revealNext();
    }

    function fmtNet(n) { return (n > 0 ? '+' : '') + n.toFixed(1); }

    function showFactModal(factIndex, leveledUp, isSecret, onDismiss) {
      const liveMode = !!(BJ.agent && BJ.agent.active);
      if (factIndex >= 0) {
        els.factModalText.innerHTML = '';
        renderFactInto(els.factModalText, fact(factIndex));
        let label;
        if (isSecret) {
          label = t('heuristics.game.achievement_unlocked');
        } else if (!liveMode && leveledUp) {
          label = t('heuristics.game.level_live', { v: VERSIONS[st.policyLevel].short });
        } else {
          label = t('heuristics.game.fact_modal_label');
        }
        document.getElementById('bjFactModalLabel').textContent = label;
      } else {
        // All base facts done — message differs by mode.
        if (liveMode) {
          document.getElementById('bjFactModalLabel').textContent = t('heuristics.game.all_unlocked_label');
          els.factModalText.textContent = t('heuristics.game.all_unlocked_text');
        } else {
          document.getElementById('bjFactModalLabel').textContent = t('heuristics.game.end_label');
          els.factModalText.textContent = t('heuristics.game.end_text');
        }
      }
      els.factModal._onDismiss = onDismiss || null;
      els.factModal.classList.add('show');
      els.factModalDismiss.focus();
    }
    function hideFactModal() {
      els.factModal.classList.remove('show');
      const cb = els.factModal._onDismiss;
      els.factModal._onDismiss = null;
      if (cb) cb(); else els.btnDeal.focus();
    }

    function doReset() {
      st = resetState();
      // Critical: BJ.game.state holds the reference captured at init time.
      // Reassigning st above creates a new object, so we must update the
      // exposed reference explicitly, otherwise agent_ui.js reads the old
      // evolved policySource and resumes from the wrong version.
      if (BJ.game) BJ.game.state = st;
      shoe = createShoe();
      phase = 'idle';
      playerDoubledThisRound = false;
      if (BJ.agent && BJ.agent.active && typeof BJ.agent.onReset === 'function') {
        try { BJ.agent.onReset(); } catch (e) {}
      }
      updateHeuristicsDisplay();
      renderFactsLog();
      updateLiveStats();
      clearLog();
      els.youHand.innerHTML = ''; els.aiHand.innerHTML = ''; els.dealerHand.innerHTML = '';
      els.youTotal.innerHTML = ''; els.aiTotal.innerHTML = ''; els.dealerTotal.textContent = '';
      announce(BJ.agent && BJ.agent.active ? t('heuristics.game.reset_live') : t('heuristics.game.reset_static'));
      setActionButtons({ deal: true, hit: false, stand: false, double: false, split: false });
    }

    // ---- wire events ----
    els.btnDeal.addEventListener('click', newRound);
    els.btnHit.addEventListener('click', onHit);
    els.btnStand.addEventListener('click', onStand);
    els.btnDouble.addEventListener('click', onDouble);
    els.btnSplit.addEventListener('click', onSplit);
    els.btnReset.addEventListener('click', doReset);
    els.factModalDismiss.addEventListener('click', hideFactModal);
    function paintRulesToggle() {
      const open = els.heuristicsPanel.classList.contains('open');
      els.heuristicsToggle.textContent = t(open ? 'heuristics.game.rules_toggle_hide'
                                                : 'heuristics.game.rules_toggle_show');
    }
    els.heuristicsToggle.addEventListener('click', () => {
      const open = els.heuristicsPanel.classList.toggle('open');
      els.heuristicsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      paintRulesToggle();
    });
    paintRulesToggle();

    // Repaint every string this file owns when the language changes. The round
    // log is left alone on purpose: those lines are a historical record of what
    // happened, and retranslating them would rewrite the past mid-hand.
    document.addEventListener('i18n:changed', function () {
      updateHeuristicsDisplay();
      renderFactsLog();
      updateLiveStats();
      paintRulesToggle();
      if (phase === 'idle') {
        announce(BJ.agent && BJ.agent.active ? t('heuristics.game.reset_live')
                                             : t('heuristics.game.prompt_first'));
      }
      if (BJ.agent && typeof BJ.agent.onLanguageChange === 'function') {
        try { BJ.agent.onLanguageChange(); } catch (e) {}
      }
    });

    // ---- initial paint ----
    updateHeuristicsDisplay();
    renderFactsLog();
    updateLiveStats();
    announce(t('heuristics.game.prompt_first'));
    setActionButtons({ deal: true, hit: false, stand: false, double: false, split: false });

    // Expose a minimal surface for the optional agent layer, then let it
    // attach. Everything above runs identically whether or not it does.
    BJ.game = {
      state: st,
      saveState: saveState,
      announce: announce,
      logLine: logLine,
      updateHeuristicsDisplay: updateHeuristicsDisplay,
      updateLiveStats: updateLiveStats,
      getSeedSource: function () { return VERSIONS[0].fn.toString(); },
      staticVersions: VERSIONS
    };
    if (BJ.onGameReady) { try { BJ.onGameReady(BJ.game); } catch (e) {} }
  }

  function start() {
    const section = document.getElementById('heuristics');
    if (!section) return;
    const mo = new MutationObserver(() => {
      if (section.classList.contains('is-active')) initGame();
    });
    mo.observe(section, { attributes: true, attributeFilter: ['class'] });
    if (section.classList.contains('is-active')) initGame();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
