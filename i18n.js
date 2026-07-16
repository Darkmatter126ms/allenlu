/**
 * i18n.js — Lightweight internationalisation engine for Allen Lu's portfolio
 * Supports: en, zh, hi, es, fr, ar (RTL)
 * Works on GitHub Pages (same-origin fetch, no CORS issues)
 */

(function () {
  'use strict';

  const SUPPORTED_LANGS  = ['en', 'zh', 'hi', 'es', 'fr', 'ar'];
  const RTL_LANGS        = ['ar'];
  const ARABIC_FONT_URL  = 'https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@400;500;600;700&display=swap';

  const LANG_LABELS = {
    en: 'EN',
    zh: '中文',
    hi: 'हि',
    es: 'ES',
    fr: 'FR',
    ar: 'عر'
  };

  let currentLang  = 'en';
  let translations = {};
  let fallback     = {};   // en.json, always loaded, used when a key is missing
  let arabicFontLoaded = false;

  /* ─── Helpers ─────────────────────────────────────────────────────── */

  function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
  }

  function detectBrowserLang() {
    const lang = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
    return SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  }

  function loadArabicFont() {
    if (arabicFontLoaded) return;
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = ARABIC_FONT_URL;
    document.head.appendChild(link);
    arabicFontLoaded = true;
  }

  /* ─── Apply translations ──────────────────────────────────────────── */

  function applyTranslations() {
    // textContent keys
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = getNestedValue(translations, key);
      if (val !== undefined) el.textContent = val;
    });

    // innerHTML keys (for elements with nested tags like <em>)
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const val = getNestedValue(translations, key);
      if (val !== undefined) el.innerHTML = val;
    });
  }

  /* ─── RTL / LTR ──────────────────────────────────────────────────── */

  function setDirection(lang) {
    const isRTL = RTL_LANGS.includes(lang);
    document.documentElement.setAttribute('dir',  isRTL ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', lang);

    if (isRTL) {
      loadArabicFont();
      document.body.classList.add('lang-ar');
    } else {
      document.body.classList.remove('lang-ar');
    }
  }

  /* ─── Switcher UI ────────────────────────────────────────────────── */

  function updateSwitcherUI(lang) {
    const labelEl = document.getElementById('langCurrent');
    if (labelEl) labelEl.textContent = LANG_LABELS[lang] || lang.toUpperCase();

    document.querySelectorAll('.lang-dropdown li[data-lang]').forEach(li => {
      li.classList.toggle('active', li.dataset.lang === lang);
    });
  }

  /* ─── Public lookup API (used by blackjack.js / agent_ui.js) ─────── */

  // t('heuristics.game.log_hit', { t: 18 }) -> 'You hit, drawing to 18.'
  // Falls back to the key itself if the string is missing, so a gap in a
  // locale shows up loudly instead of rendering "undefined".
  function t(key, vars) {
    let s = getNestedValue(translations, key);
    if (typeof s !== 'string') s = getNestedValue(fallback, key);
    if (typeof s !== 'string') return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
  }

  /* ─── Load & apply ───────────────────────────────────────────────── */

  async function loadAndApply(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';

    try {
      const res = await fetch('./locales/' + lang + '.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      translations = await res.json();
    } catch (err) {
      console.warn('[i18n] Failed to load "' + lang + '", falling back to "en".', err);
      if (lang !== 'en') { loadAndApply('en'); return; }
      return;
    }

    currentLang = lang;
    applyTranslations();
    setDirection(lang);
    updateSwitcherUI(lang);

    try { localStorage.setItem('allen-portfolio-lang', lang); } catch (_) {}

    // Tell the game to re-render its own strings. blackjack.js and agent_ui.js
    // listen for this and repaint labels, rules list, facts and status text.
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: lang } }));
  }

  /* ─── Switcher init ──────────────────────────────────────────────── */

  function initSwitcher() {
    const btn      = document.getElementById('langBtn');
    const dropdown = document.getElementById('langDropdown');
    if (!btn || !dropdown) return;

    // Toggle dropdown
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('open');
      dropdown.classList.toggle('open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });

    // Language selection
    dropdown.querySelectorAll('li[data-lang]').forEach(li => {
      li.addEventListener('click', function () {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        const lang = this.dataset.lang;
        if (lang !== currentLang) loadAndApply(lang);
      });
    });

    // Close on outside click
    document.addEventListener('click', function () {
      dropdown.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ─── Bootstrap ──────────────────────────────────────────────────── */

  function init() {
    let savedLang = null;
    try { savedLang = localStorage.getItem('allen-portfolio-lang'); } catch (_) {}

    const lang = (savedLang && SUPPORTED_LANGS.includes(savedLang))
      ? savedLang
      : detectBrowserLang();

    initSwitcher();

    // en.json is always fetched: the HTML carries the static English copy, but
    // the game strings (heuristics.game / versions / agent / facts) live only
    // in JSON, so English needs them too, and every other locale needs en as a
    // fallback for any key it is missing.
    fetch('./locales/en.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { fallback = j; })
      .catch(function () { fallback = {}; })
      .then(function () { loadAndApply(lang); });
  }

  window.I18N = {
    t: t,
    // raw() returns the value as-is (object or string). Used by blackjack.js
    // to retrieve fact objects { text, url?, linkLabel? } without t() coercing
    // them to a string.
    raw: function (key) {
      var v = getNestedValue(translations, key);
      if (v !== undefined) return v;
      return getNestedValue(fallback, key);
    },
    lang: function () { return currentLang; },
    isRTL: function () { return RTL_LANGS.includes(currentLang); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
