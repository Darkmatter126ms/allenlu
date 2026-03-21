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

    // English is already rendered in the HTML — only fetch if non-English
    if (lang === 'en') {
      currentLang = 'en';
      updateSwitcherUI('en');
      setDirection('en');
    } else {
      loadAndApply(lang);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
