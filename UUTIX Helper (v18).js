// ==UserScript==
// @name         UUTIX Helper (v18)
// @namespace    http://tampermonkey.net/
// @version      2026-06-28.18
// @description  分步复查：适配新版 detail/ticket/cart/trade-confirmation/cashier DOM；进入支付页后按预设付款方法确认支付，卡号等敏感信息不写入本地存储。
// @author       yuuuiv
// @license      MIT
// @match        https://www.uutix.com/detail?pId=*
// @match        https://www.uutix.com/ticket?pId=*
// @match        https://www.uutix.com/shopping-cart*
// @match        https://www.uutix.com/trade-confirmation*
// @match        https://www.uutix.com/*
// @match        https://mcashier.uutix.com/oversea/cashier*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=uutix.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  let submitIntervalId = null;
  let entryObserver = null;
  let entryClockTimer = null;
  let entryClockLastSample = null;
  let entryClockLastFetchAt = 0;
  let domSignalObserver = null;
  let domSignalVersion = 0;
  const domSignalWaiters = new Set();

  let isRunning = false;
  let runToken = 0;

  const PANEL_POS_KEY = 'uutix-helper-panel-position';
  const PANEL_HIDDEN_KEY = 'uutix-helper-panel-hidden';
  const AUTO_RUN_KEY = 'uutix-helper-auto-run-ticket';
  const TARGETS_KEY = 'uutix-helper-last-targets';
  const CART_SUBMIT_KEY = 'uutix-helper-auto-submit-cart';
  const PAY_NOW_KEY = 'uutix-helper-auto-pay-now';
  const CROWD_RETRY_KEY = 'uutix-helper-crowd-retry-v18';
  const PAYMENT_HANDOFF_MARK = 'uutix-helper-payment-handoff-v18';
  const PAYMENT_METHOD_STORE_KEY = 'uutix-helper-payment-method-v18';
  const CASHIER_AUTO_KEY = 'uutix-helper-auto-cashier-v18';
  const ENTRY_CLICK_INTERVAL_MS = 35;
  const SUBMIT_CLICK_INTERVAL_MS = 12;
  const SUBMIT_BURST_CLICKS = 4;
  const CART_SUBMIT_INTERVAL_MS = 18;
  const CART_SUBMIT_BURST_CLICKS = 2;
  const PAY_NOW_INTERVAL_MS = 18;
  const PAY_NOW_BURST_CLICKS = 2;
  const CASHIER_CONFIRM_INTERVAL_MS = 18;
  const CASHIER_CONFIRM_BURST_CLICKS = 2;
  const RUSH_RETURN_DEFAULT = false;
  const RUSH_RETURN_INTERVAL_DEFAULT_MS = 180;
  const RUSH_RETURN_INTERVAL_MIN_MS = 80;
  const RUSH_RETURN_INTERVAL_MAX_MS = 1500;
  const RUSH_RETURN_BURST_CLICKS = 1;
  const CLICK_READY_WINDOW_MS = 1200;
  const PAY_NOW_CLICK_WINDOW_MS = 1500;
  const CASHIER_CONFIRM_CLICK_WINDOW_MS = 2000;
  const CASHIER_AUTO_START_DELAY_MS = 0;
  const AUTO_START_FALLBACK_MS = 1200;
  const CASHIER_SELECT_RETRY_MS = 5000;
  const CASHIER_SELECT_RETRY_INTERVAL_MS = 120;
  const CROWD_RETRY_MAX_ATTEMPTS = 8;
  const CROWD_RETRY_BASE_COOLDOWN_MS = 4200;
  const CROWD_RETRY_JITTER_MS = 1600;
  const networkRecorder = {
    installed: false,
    recording: false,
    records: [],
    maxRecords: 800,
    originalFetch: null,
    originalXhrOpen: null,
    originalXhrSetRequestHeader: null,
    originalXhrSend: null
  };

  const addStyle = (typeof GM_addStyle === 'function')
    ? GM_addStyle
    : (css) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };

  addStyle(`
    #uutix-helper-panel * { transition:none !important; animation:none !important; }
    #uutix-helper-panel{
      all: initial; position: fixed; top: 120px; right: 20px; z-index: 99999;
      background:#fff; border:1px solid #e0e0e0; border-radius:12px; padding:18px;
      font-family:sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.15);
      display:flex; flex-direction:column; gap:12px; width:360px; max-height:calc(100vh - 24px);
      overflow-y:auto; overscroll-behavior:contain; box-sizing:border-box;
    }
    #uutix-helper-panel button{ cursor:pointer; padding:8px; border-radius:6px; border:none; font-weight:bold; }
    #uutix-helper-panel label, #uutix-helper-panel span, #uutix-helper-panel div{ box-sizing:border-box; font-family:sans-serif; }
    #uutix-helper-header{ display:flex; align-items:center; justify-content:space-between; cursor:move; user-select:none; touch-action:none; }
    #uutix-helper-title{ font-weight:bold; font-size:16px; line-height:24px; }
    #uutix-helper-hide{ width:52px; background:#6c757d; color:#fff; padding:6px 8px !important; font-size:12px; }
    #uutix-helper-dock{
      all: initial; position:fixed; right:18px; bottom:128px; z-index:99999;
      background:#007bff; color:#fff; border-radius:999px; padding:8px 12px;
      font:700 13px sans-serif; box-shadow:0 3px 10px rgba(0,0,0,.2);
      cursor:pointer; display:none; user-select:none;
    }
    #status-display{ font-size:13px; padding:8px; text-align:center; border-radius:8px; background:#f5f5f5; }
    #clock-display{ font-size:12px; line-height:1.45; padding:7px 8px; text-align:left; border-radius:8px; background:#f8f9fa; color:#6c757d; white-space:pre-line; }
    #calibrate-clock-btn{ background:#6c757d; color:#fff; font-size:12px; padding:6px 8px !important; font-weight:600 !important; }
    #uutix-helper-panel .uutix-row{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
    #uutix-helper-panel .uutix-row span{ font-size:13px; white-space:nowrap; }
    #uutix-helper-panel .uutix-control{ width:140px; border:1px solid #ccc; }
    #uutix-helper-panel .uutix-actions{ display:flex; gap:10px; }
    #uutix-helper-panel .uutix-actions button{ flex:1; }
    #uutix-helper-panel .uutix-details{
      border:1px solid #eee; border-radius:8px; background:#fafafa; padding:0 9px;
    }
    #uutix-helper-panel .uutix-details > summary{
      cursor:pointer; font:700 12px sans-serif; padding:8px 0; color:#495057; user-select:none;
    }
    #uutix-helper-panel .uutix-details[open]{ padding-bottom:9px; }
    #uutix-helper-panel .uutix-details .uutix-row{ margin-top:8px; }
    #uutix-helper-panel input, #uutix-helper-panel select{
      font-size:13px; padding:2px 6px; border-radius:4px; outline:none;
      border:1px solid #ccc; background:#fff; box-sizing:border-box;
    }
    #uutix-card-fields{
      display:flex; flex-direction:column; gap:8px; padding:10px;
      border:1px solid #eee; border-radius:8px; background:#fafafa;
    }
    #uutix-card-fields .uutix-row{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
    #uutix-card-fields .uutix-row span{ font-size:12px; white-space:nowrap; }
    #uutix-card-fields input{ width:190px; }
    #uutix-card-privacy{ font-size:11px; line-height:1.45; color:#6c757d; }
    @media (max-width: 520px), (max-height: 720px) {
      #uutix-helper-panel{
        top:8px !important; left:8px !important; right:8px !important; bottom:auto !important;
        width:calc(100vw - 16px) !important; max-height:58vh !important;
        padding:10px !important; gap:8px !important; border-radius:10px !important;
        -webkit-overflow-scrolling:touch;
      }
      #uutix-helper-header{
        position:sticky; top:-10px; z-index:1; background:#fff; padding-bottom:4px;
      }
      #uutix-helper-title{ font-size:15px; }
      #uutix-helper-title::after{ content:" · 紧凑"; color:#6c757d; font-size:12px; font-weight:400; }
      #uutix-helper-hide{ width:46px; padding:5px 7px !important; }
      #uutix-helper-panel .uutix-row{ min-height:28px; }
      #uutix-helper-panel .uutix-row span{ font-size:12px; }
      #uutix-helper-panel .uutix-control{ width:122px !important; }
      #uutix-helper-panel input, #uutix-helper-panel select{ height:28px; font-size:12px; }
      #uutix-helper-panel button{ padding:7px !important; }
      #uutix-helper-panel .uutix-actions{
        position:sticky; bottom:-10px; z-index:1; background:#fff; padding-top:4px;
      }
      #status-display{ font-size:12px; padding:6px; }
      #clock-display{ font-size:11px; line-height:1.35; max-height:86px; overflow:auto; }
      #calibrate-clock-btn{ font-size:11px; }
      #uutix-card-fields{ gap:6px; padding:8px; }
      #uutix-card-fields input{ width:160px !important; }
      #uutix-helper-dock{ right:10px; bottom:92px; }
    }
  `);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function logDebug(msg, data) {
    try {
      if (data === undefined) console.log('[UUTIX Helper]', msg);
      else console.log('[UUTIX Helper]', msg, data);
    } catch (_) {}
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  function getText(el) {
    return normalizeText(el?.textContent || '');
  }

  const PAYMENT_METHODS = {
    visa: { label: 'VISA卡', match: /visa|VISA卡/i, card: true },
    mastercard: { label: '萬事達卡', match: /萬事達|万事达|mastercard|master/i, card: true },
    amex: { label: '美國運通卡', match: /美國運通|美国运通|americanexpress|amex/i, card: true },
    unionpay: { label: '銀聯支付', match: /銀聯|银联|unionpay/i, card: true },
    wechat: { label: '微信支付', match: /微信|wechat/i, card: false },
    alipayhk: { label: 'AlipayHK', match: /alipayhk|alipay|支付寶|支付宝/i, card: false }
  };

  function normalizePaymentMethod(method) {
    const key = String(method || '').toLowerCase();
    return PAYMENT_METHODS[key] ? key : 'wechat';
  }

  function normalizeRushReturnIntervalMs(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return RUSH_RETURN_INTERVAL_DEFAULT_MS;
    return Math.min(RUSH_RETURN_INTERVAL_MAX_MS, Math.max(RUSH_RETURN_INTERVAL_MIN_MS, n));
  }

  function isCardPaymentMethod(method) {
    return !!PAYMENT_METHODS[normalizePaymentMethod(method)]?.card;
  }

  function getPaymentMethodLabel(method) {
    return PAYMENT_METHODS[normalizePaymentMethod(method)]?.label || PAYMENT_METHODS.wechat.label;
  }

  function gmSetValueSafe(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
    } catch (_) {}
  }

  function gmGetValueSafe(key, fallback = null) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (_) {}
    return fallback;
  }

  function gmDeleteValueSafe(key) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
    } catch (_) {}
  }

  function setStoredPaymentMethod(method) {
    gmSetValueSafe(PAYMENT_METHOD_STORE_KEY, normalizePaymentMethod(method));
  }

  function getStoredPaymentMethod(fallback = 'wechat') {
    const stored = gmGetValueSafe(PAYMENT_METHOD_STORE_KEY, null);
    return normalizePaymentMethod(stored || fallback);
  }

  function setCashierAutoFlag(enabled) {
    if (enabled) gmSetValueSafe(CASHIER_AUTO_KEY, String(Date.now()));
    else gmDeleteValueSafe(CASHIER_AUTO_KEY);
  }

  function shouldAutoContinueToCashier() {
    const ts = Number(gmGetValueSafe(CASHIER_AUTO_KEY, 0));
    return Number.isFinite(ts) && ts > 0 && Date.now() - ts < 15 * 60 * 1000;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const op = parseFloat(cs.opacity || '1');
    if (!Number.isNaN(op) && op <= 0.01) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryFirstVisible(selectors, root = document) {
    for (const selector of selectors) {
      const list = Array.from(root.querySelectorAll(selector));
      const visible = list.find(isVisible);
      if (visible) return visible;
      if (list[0]) return list[0];
    }
    return null;
  }

  function findByText(selectors, textRe, root = document) {
    for (const selector of selectors) {
      const found = Array.from(root.querySelectorAll(selector)).find((el) => textRe.test(getText(el)));
      if (found) return found;
    }
    return null;
  }

  function updateStatus(msg, color = '#333') {
    logDebug(msg);
    const s = document.getElementById('status-display');
    if (s) {
      s.textContent = `状态: ${msg}`;
      s.style.color = color;
    }
  }

  function updateClockDisplay(msg, color = '#6c757d') {
    const s = document.getElementById('clock-display');
    if (s) {
      s.textContent = `${msg}`;
      s.style.color = color;
    }
  }

  function formatSignedMs(ms) {
    if (!Number.isFinite(ms)) return '未知';
    const sign = ms >= 0 ? '+' : '-';
    const abs = Math.abs(ms);
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10000 ? 1 : 3)}s`;
    return `${sign}${Math.round(abs)}ms`;
  }

  function formatDurationShort(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '未知';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  }

  function getClockSkewColor(ms) {
    const abs = Math.abs(Number(ms) || 0);
    if (abs <= 500) return '#28a745';
    if (abs <= 2000) return '#ff9800';
    return '#dc3545';
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function redactSensitiveText(value) {
    if (value == null) return value;
    let text = String(value);
    text = text.replace(/(authorization|cookie|set-cookie|payToken|paytoken|token|sign|mygsig|m-traceid|nonce|fingerprint|uuid|iuuid|cardNo|cardNumber|pan|cvv|cvc)["']?\s*[:=]\s*["']?([^"',&\s}]+)/gi, '$1:<redacted>');
    text = text.replace(/([?&](?:payToken|paytoken|token|tradeNo|tradeno|orderId|orderid|sign|mygsig|m-traceid|nonce|s|uuid|iuuid)=)[^&#]+/gi, '$1<redacted>');
    text = text.replace(/\b[A-Fa-f0-9]{24,}\b/g, '<hex-redacted>');
    text = text.replace(/\b\d{12,19}\b/g, '<number-redacted>');
    return text;
  }

  function redactUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      ['payToken', 'paytoken', 'token', 'tradeNo', 'tradeno', 'orderId', 'orderid', 'sign', 'nonce', 's', 'uuid'].forEach((key) => {
        if (u.searchParams.has(key)) u.searchParams.set(key, '<redacted>');
      });
      return u.toString();
    } catch (_) {
      return redactSensitiveText(url);
    }
  }

  function isUutixRelatedUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      return /uutix\.com|wxmovie\.com|wepayez\.com/i.test(u.hostname);
    } catch (_) {
      return /uutix|wxmovie|wepayez/i.test(String(url || ''));
    }
  }

  function summarizeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      const trimmed = body.length > 3000 ? `${body.slice(0, 3000)}...<truncated>` : body;
      const parsed = safeJsonParse(trimmed);
      return parsed ? redactSensitiveObject(parsed) : redactSensitiveText(trimmed);
    }
    if (body instanceof URLSearchParams) return redactSensitiveText(body.toString());
    if (body instanceof FormData) {
      const out = {};
      try {
        body.forEach((value, key) => {
          out[key] = value instanceof File ? `[File:${value.name || 'blob'}]` : redactSensitiveText(value);
        });
      } catch (_) {}
      return out;
    }
    if (body instanceof Blob) return `[Blob:${body.type || 'unknown'},${body.size || 0}]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer:${body.byteLength}]`;
    try { return redactSensitiveObject(body); } catch (_) { return `[${Object.prototype.toString.call(body)}]`; }
  }

  function summarizeHeaders(headers) {
    if (!headers) return null;
    const out = {};
    try {
      if (headers instanceof Headers) {
        headers.forEach((value, key) => { out[key] = redactSensitiveText(value); });
        return out;
      }
      if (Array.isArray(headers)) {
        headers.forEach((pair) => {
          if (Array.isArray(pair) && pair.length >= 2) out[pair[0]] = redactSensitiveText(pair[1]);
        });
        return out;
      }
      Object.keys(headers).forEach((key) => {
        out[key] = redactSensitiveText(headers[key]);
      });
      return out;
    } catch (_) {
      return '[unreadable-headers]';
    }
  }

  function redactSensitiveObject(input, depth = 0) {
    if (input == null) return input;
    if (depth > 5) return '[depth-limit]';
    if (typeof input !== 'object') return redactSensitiveText(input);
    if (Array.isArray(input)) return input.slice(0, 80).map((item) => redactSensitiveObject(item, depth + 1));
    const out = {};
    Object.keys(input).slice(0, 120).forEach((key) => {
      const lower = key.toLowerCase();
      if (/authorization|cookie|token|sign|mygsig|m-traceid|nonce|fingerprint|uuid|iuuid|card|cvv|cvc|pan/.test(lower)) {
        out[key] = '<redacted>';
      } else {
        out[key] = redactSensitiveObject(input[key], depth + 1);
      }
    });
    return out;
  }

  function recordNetworkEntry(entry) {
    if (!networkRecorder.recording || !isUutixRelatedUrl(entry.url)) return;
    const safeEntry = {
      ts: new Date().toISOString(),
      type: entry.type || 'request',
      method: entry.method || 'GET',
      url: redactUrl(entry.url),
      status: entry.status ?? null,
      durationMs: entry.durationMs ?? null,
      requestHeaders: summarizeHeaders(entry.requestHeaders),
      requestBody: summarizeBody(entry.requestBody),
      responseBody: summarizeBody(entry.responseBody)
    };
    networkRecorder.records.push(safeEntry);
    if (networkRecorder.records.length > networkRecorder.maxRecords) {
      networkRecorder.records.splice(0, networkRecorder.records.length - networkRecorder.maxRecords);
    }
    logDebug(`记录请求 ${safeEntry.method} ${safeEntry.url}`, { status: safeEntry.status });
  }

  function installNetworkInterceptor() {
    if (networkRecorder.installed) return;
    networkRecorder.installed = true;

    if (typeof window.fetch === 'function') {
      networkRecorder.originalFetch = window.fetch.bind(window);
      window.fetch = async function uutixFetchWrapper(input, init = {}) {
        const started = Date.now();
        const url = typeof input === 'string' ? input : input?.url;
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        const requestBody = init?.body;
        const requestHeaders = init?.headers || input?.headers;
        try {
          const response = await networkRecorder.originalFetch(input, init);
          if (networkRecorder.recording && isUutixRelatedUrl(url)) {
            const cloned = response.clone();
            cloned.text().then((text) => {
              recordNetworkEntry({
                type: 'fetch',
                method,
                url,
                status: response.status,
                durationMs: Date.now() - started,
                requestHeaders,
                requestBody,
                responseBody: text
              });
            }).catch(() => {
              recordNetworkEntry({
                type: 'fetch',
                method,
                url,
                status: response.status,
                durationMs: Date.now() - started,
                requestHeaders,
                requestBody,
                responseBody: '[unreadable]'
              });
            });
          }
          return response;
        } catch (e) {
          recordNetworkEntry({
            type: 'fetch',
            method,
            url,
            status: 'ERROR',
            durationMs: Date.now() - started,
            requestHeaders,
            requestBody,
            responseBody: e?.message || String(e)
          });
          throw e;
        }
      };
    }

    if (window.XMLHttpRequest?.prototype) {
      networkRecorder.originalXhrOpen = XMLHttpRequest.prototype.open;
      networkRecorder.originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      networkRecorder.originalXhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function uutixXhrOpen(method, url) {
        this.__uutixRecorderMeta = {
          method: String(method || 'GET').toUpperCase(),
          url: String(url || ''),
          headers: {}
        };
        return networkRecorder.originalXhrOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function uutixXhrSetRequestHeader(name, value) {
        try {
          if (!this.__uutixRecorderMeta) this.__uutixRecorderMeta = { headers: {} };
          this.__uutixRecorderMeta.headers[String(name || '')] = String(value || '');
        } catch (_) {}
        return networkRecorder.originalXhrSetRequestHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function uutixXhrSend(body) {
        const meta = this.__uutixRecorderMeta || {};
        const started = Date.now();
        const xhr = this;
        try {
          xhr.addEventListener('loadend', () => {
            if (!networkRecorder.recording || !isUutixRelatedUrl(meta.url)) return;
            let responseBody = '[unreadable]';
            try {
              if (!xhr.responseType || xhr.responseType === 'text' || xhr.responseType === 'json') {
                responseBody = xhr.responseText || xhr.response;
              } else {
                responseBody = `[${xhr.responseType}]`;
              }
            } catch (_) {}
            recordNetworkEntry({
              type: 'xhr',
              method: meta.method,
              url: meta.url,
              status: xhr.status,
              durationMs: Date.now() - started,
              requestHeaders: meta.headers,
              requestBody: body,
              responseBody
            });
          });
        } catch (_) {}
        return networkRecorder.originalXhrSend.apply(this, arguments);
      };
    }
  }

  function interceptNetworkRequests() {
    installNetworkInterceptor();
    return networkRecorder;
  }

  function startNetworkRecording() {
    interceptNetworkRequests();
    networkRecorder.records = [];
    networkRecorder.recording = true;
    updateStatus('已开始记录 UUTIX 相关请求（仅监听，不发送请求）', '#17a2b8');
  }

  function stopNetworkRecording() {
    networkRecorder.recording = false;
    updateStatus(`已停止记录，共 ${networkRecorder.records.length} 条`, '#6c757d');
  }

  function exportNetworkRecords() {
    const payload = {
      exportedAt: new Date().toISOString(),
      page: redactUrl(location.href),
      count: networkRecorder.records.length,
      records: networkRecorder.records
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uutix-network-redacted-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    updateStatus(`已导出脱敏请求日志：${networkRecorder.records.length} 条`, '#28a745');
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    const aria = el.getAttribute('aria-disabled');
    if (aria && aria.toLowerCase() === 'true') return true;
    if (el.getAttribute('disabled') != null) return true;
    if (el.classList && el.classList.contains('disabled')) return true;
    if (el.classList && el.classList.contains('disable')) return true;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none') return true;
    return false;
  }

  function clearSubmitInterval() {
    if (submitIntervalId) clearInterval(submitIntervalId);
    submitIntervalId = null;
  }

  function clearEntryObserver() {
    if (entryObserver) {
      try { entryObserver.disconnect(); } catch (_) {}
      entryObserver = null;
    }
  }

  function clearEntryClockMonitor() {
    if (entryClockTimer) clearInterval(entryClockTimer);
    entryClockTimer = null;
  }

  function signalDomChanged() {
    domSignalVersion++;
    const waiters = Array.from(domSignalWaiters);
    domSignalWaiters.clear();
    waiters.forEach((resolve) => {
      try { resolve(); } catch (_) {}
    });
  }

  function shouldIgnoreDomMutations(mutations) {
    return mutations.length > 0 && mutations.every((mutation) => {
      const target = mutation.target;
      const el = target instanceof Element ? target : target?.parentElement;
      return !!el?.closest?.('#uutix-helper-panel, #uutix-helper-dock');
    });
  }

  function ensureDomSignalObserver() {
    if (domSignalObserver || !document.documentElement || typeof MutationObserver !== 'function') return;
    try {
      domSignalObserver = new MutationObserver((mutations) => {
        if (shouldIgnoreDomMutations(mutations)) return;
        signalDomChanged();
      });
      domSignalObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
    } catch (_) {}
  }

  async function waitForDomOrTimeout(ms) {
    if (!ms || ms <= 0) return;
    ensureDomSignalObserver();
    const seen = domSignalVersion;
    if (!domSignalObserver) {
      await sleep(ms);
      return;
    }
    if (domSignalVersion !== seen) return;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        domSignalWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      domSignalWaiters.add(finish);
    });
  }

  async function ensureNotStopped(token) {
    if (!isRunning || token !== runToken) throw new Error('已停止');
  }

  async function waitFor(fn, token, timeoutMs = 12000, intervalMs = 20, errMsg = '等待超时') {
    const t0 = Date.now();
    while (true) {
      await ensureNotStopped(token);
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(errMsg);
      await waitForDomOrTimeout(intervalMs);
    }
  }

  async function waitUntil(condFn, token, timeoutMs = 8000, intervalMs = 20, errMsg = '等待条件超时') {
    const t0 = Date.now();
    while (true) {
      await ensureNotStopped(token);
      if (condFn()) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(errMsg);
      await waitForDomOrTimeout(intervalMs);
    }
  }

  // --------------------------
  // Loading（仅切换非默认场次时严格等待）
  // --------------------------
  function getLoadingEl() { return document.getElementById('loading-modal'); }

  function isLoadingVisible() {
    const m = getLoadingEl();
    if (!m) return false;
    const cs = getComputedStyle(m);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    const op = parseFloat(cs.opacity || '1');
    if (!Number.isNaN(op) && op <= 0.01) return false;
    return true;
  }

  async function waitLoadingStableGone(token, {
    appearWindowMs = 1600,
    disappearTimeoutMs = 25000,
    stableGoneMs = 180
  } = {}) {
    if (!getLoadingEl()) return;

    const t0 = Date.now();
    let appeared = false;
    while (Date.now() - t0 < appearWindowMs) {
      await ensureNotStopped(token);
      if (isLoadingVisible()) { appeared = true; break; }
      await sleep(20);
    }

    if (appeared) {
      const t1 = Date.now();
      while (true) {
        await ensureNotStopped(token);
        if (!isLoadingVisible()) break;
        if (Date.now() - t1 > disappearTimeoutMs) throw new Error('等待 loading 消失超时');
        await sleep(30);
      }
    }

    let goneStart = null;
    const t2 = Date.now();
    while (true) {
      await ensureNotStopped(token);

      if (!isLoadingVisible()) {
        if (goneStart == null) goneStart = Date.now();
        if (Date.now() - goneStart >= stableGoneMs) return;
      } else {
        goneStart = null;
      }

      if (Date.now() - t2 > disappearTimeoutMs) throw new Error('等待 loading 稳定结束超时');
      await sleep(20);
    }
  }

  // --------------------------
  // 超快点击 & 稳定确认
  // --------------------------
  async function fastClick(element, times, token, gapMs = 12) {
    for (let i = 0; i < times; i++) {
      await ensureNotStopped(token);
      element.click();
      if (gapMs) await sleep(gapMs);
    }
  }

  function prepareClickTarget(element) {
    if (!element) return;
    try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { element.focus({ preventScroll: true }); } catch (_) {}
  }

  function burstClick(element, times = 1) {
    if (!element) return 0;
    let clicked = 0;
    prepareClickTarget(element);
    for (let i = 0; i < times; i++) {
      if (isDisabled(element)) break;
      try {
        element.click();
        clicked++;
      } catch (e) {
        logDebug('点击失败，将等待下一轮重试', e?.message || e);
        break;
      }
    }
    return clicked;
  }

  async function clickReadyButtonForWindow({
    token,
    getButton,
    isReady,
    intervalMs,
    burstClicks,
    windowMs = CLICK_READY_WINDOW_MS,
    loadingAware = true,
    label = '按钮'
  }) {
    let clicked = 0;
    let lastReadyAt = 0;
    const t0 = Date.now();

    while (Date.now() - t0 <= windowMs) {
      await ensureNotStopped(token);

      if (loadingAware && isLoadingVisible()) {
        await sleep(intervalMs);
        continue;
      }

      const cur = getButton();
      if (!cur || !isReady(cur)) {
        await sleep(intervalMs);
        continue;
      }

      lastReadyAt = Date.now();
      clicked += burstClick(cur, burstClicks);
      await sleep(intervalMs);
    }

    logDebug(`${label}点击窗口结束`, { clicked, lastReadyAt });
    return clicked;
  }

  async function waitCondStable(condFn, token, stableMs = 120, timeoutMs = 3500, pollMs = 16, errMsg = '状态稳定确认超时') {
    const t0 = Date.now();
    let okStart = null;

    while (true) {
      await ensureNotStopped(token);

      if (isLoadingVisible()) {
        okStart = null;
        await waitForDomOrTimeout(pollMs);
        continue;
      }

      if (condFn()) {
        if (okStart == null) okStart = Date.now();
        if (Date.now() - okStart >= stableMs) return true;
      } else {
        okStart = null;
      }

      if (Date.now() - t0 > timeoutMs) throw new Error(errMsg);
      await waitForDomOrTimeout(pollMs);
    }
  }

  async function retryStep(stepName, token, actionFn, stableCheckFn, { maxRetry = 60, betweenMs = 35 } = {}) {
    for (let i = 1; i <= maxRetry; i++) {
      await ensureNotStopped(token);
      updateStatus(`${stepName}：尝试 ${i}/${maxRetry}...`, '#ff9800');

      while (isLoadingVisible()) {
        await ensureNotStopped(token);
        await sleep(25);
      }

      await actionFn(i);

      const ok = await stableCheckFn();
      if (ok) {
        updateStatus(`${stepName}：完成 ✅`, '#28a745');
        return true;
      }

      await sleep(betweenMs);
    }
    throw new Error(`${stepName}：超过重试次数仍未完成（已阻止继续）`);
  }

  // --------------------------
  // DOM helpers
  // --------------------------
  function getSessionDropdown() {
    return queryFirstVisible([
      '.ticket-container .show-area .show-dropdown-select',
      '.show-area .show-dropdown-select',
      '.show-dropdown-select',
      '[class*="show-dropdown-select"]'
    ]);
  }
  function getSessionChecked(dd = getSessionDropdown()) {
    if (!dd) return null;
    return queryFirstVisible(['.checked-content', '[class*="checked-content"]'], dd) ||
      findByText(['div', 'button', '[role="button"]'], /\d{4}\/\d{2}\/\d{2}|場次|场次/, dd);
  }
  function getSessionContainerVisible() {
    const dd = getSessionDropdown();
    if (!dd) return null;
    const c = dd.querySelector('.select-item-container, [class*="select-item-container"]');
    if (!c) return null;
    return isVisible(c) ? c : null;
  }
  function getSessionItems(container) {
    if (!container) return [];
    const direct = Array.from(container.querySelectorAll('.item-wrap .item'));
    if (direct.length) return direct;
    const wraps = Array.from(container.querySelectorAll('.item-wrap'));
    if (wraps.length) return wraps;
    return Array.from(container.querySelectorAll('[role="option"], .item'));
  }
  function getSelectedSessionWrap() {
    const dd = getSessionDropdown();
    if (!dd) return null;
    const selItem = dd.querySelector('.select-item-container .item.selected, [class*="select-item-container"] .item.selected');
    return selItem ? selItem.closest('.item-wrap') : null;
  }
  function parseShowIdFromWrap(wrap) {
    const lxMv = wrap?.getAttribute('lx-mv') || wrap?.dataset?.showId || '';
    const m = lxMv.match(/"show_id"\s*:\s*(\d+)/);
    return m ? m[1] : (wrap?.dataset?.showId || null);
  }

  function getPriceList() {
    return queryFirstVisible([
      '.ticket-container .multiple-ticket-area .ticket-multiple-list .select-item-list-pc',
      '.multiple-ticket-area .ticket-multiple-list .select-item-list-pc',
      '.multiple-ticket-area .select-item-list-pc',
      '.ticket-multiple-list .select-item-list-pc',
      '.multiple-ticket-area [class*="ticket-multiple-list"]',
      '.select-item-list-pc'
    ]);
  }
  function getPriceWraps(priceList) {
    if (!priceList) return [];
    const wraps = Array.from(priceList.querySelectorAll(':scope > .item-wrap'));
    const allWraps = wraps.length ? wraps : Array.from(priceList.querySelectorAll('.item-wrap'));
    return allWraps.filter((wrap) => parseTicketIdFromWrap(wrap) || wrap.querySelector('.first-floor, .second-floor, .floor-wrapper'));
  }
  async function waitForPriceWraps(requiredPosition, token, {
    timeoutMs = 45000,
    pollMs = 30,
    stableMissingMs = 6500
  } = {}) {
    const t0 = Date.now();
    let lastCount = -1;
    let countStableSince = Date.now();

    while (true) {
      await ensureNotStopped(token);

      if (isLoadingVisible()) {
        countStableSince = Date.now();
        await waitForDomOrTimeout(pollMs);
        continue;
      }

      const priceList = getPriceList();
      const wraps = getPriceWraps(priceList);

      if (wraps.length !== lastCount) {
        lastCount = wraps.length;
        countStableSince = Date.now();
        logDebug(`票价列表数量=${wraps.length}`);
      }

      if (wraps.length >= requiredPosition) {
        return { priceList, wraps };
      }

      if (wraps.length > 0 && Date.now() - countStableSince >= stableMissingMs) {
        throw new Error(`无效票价位置：${requiredPosition}（当前只有 ${wraps.length} 个票价）`);
      }

      if (Date.now() - t0 > timeoutMs) {
        if (wraps.length > 0) throw new Error(`等待目标票价#${requiredPosition}超时（当前只有 ${wraps.length} 个票价）`);
        throw new Error('等待票价列表加载超时（列表仍为空）');
      }

      await waitForDomOrTimeout(pollMs);
    }
  }
  function getSelectedTicketWrap() {
    const priceList = getPriceList();
    if (!priceList) return null;
    const selItem = priceList.querySelector('.item.selected');
    return selItem ? selItem.closest('.item-wrap') : null;
  }
  function parseTicketIdFromWrap(wrap) {
    const lxMv = wrap?.getAttribute('lx-mv') || wrap?.dataset?.ticketId || '';
    const m = lxMv.match(/"ticket_id"\s*:\s*(\d+)/);
    return m ? m[1] : (wrap?.dataset?.ticketId || null);
  }
  function hasTicketUnavailableClass(wrap) {
    const nodes = [wrap, wrap?.querySelector('.item')].filter(Boolean);
    return nodes.some((node) => {
      const classes = Array.from(node.classList || []).map((c) => c.toLowerCase());
      return classes.some((c) => c === 'disabled' || c === 'disable' || c.includes('stockout') || c.includes('soldout') || c.includes('sold-out') || c.includes('stock-out'));
    });
  }
  function getTicketStateText(wrap) {
    if (!wrap) return '';
    const tags = Array.from(wrap.querySelectorAll('.disable-tag, [class*="disable-tag"], [class*="sold"], [class*="stockOut"], [class*="stock-out"]'))
      .map(getText)
      .filter(Boolean);
    return tags.length ? tags.join('|') : getText(wrap);
  }
  function isTicketTemporaryNoTicket(wrap) {
    if (!wrap) return false;
    const stateText = getTicketStateText(wrap);
    return /暫時無票|暂时无票|暫無票|暂无票/.test(stateText);
  }
  function isTicketUnavailable(wrap) {
    const item = wrap?.querySelector('.item') || wrap;
    if (!item) return true;
    if (isDisabled(item) || hasTicketUnavailableClass(wrap)) return true;
    const stateText = getTicketStateText(wrap);
    return /缺貨|缺货|售罄|售完|無票|无票|暫無|暂无|不可售|未開售|未开售|登記|登记|stockout|soldout/i.test(stateText);
  }

  function getQuantityNumber() {
    const el = document.querySelector('.number-select .middle.number') || document.querySelector('.number-select .middle');
    const t = (el?.textContent || '').trim();
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  function getIncreaseBtn() {
    const root = document.querySelector('.number-select');
    if (!root) return null;
    return root.querySelector('.wrapper.right.active') ||
      root.querySelector('.wrapper.right:not(.disabled)') ||
      root.querySelector('.increase') ||
      root.querySelector('.wrapper.right .increase');
  }
  function getTicketLimit() {
    const el = document.querySelector('.buy-wrapper .limit-number, .limit-number');
    const n = parseInt((el?.textContent || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  function getFinalBuyButton() {
    const root = document.querySelector('.price-wrapper');
    if (!root) {
      return findByText([
        '.ticket-container button',
        '.ticket-container [role="button"]',
        '.ticket-container .right'
      ], /^(購買|购买|立即購買|立即购买|提交|下一步|確認|确认|結算|结算)$/i);
    }
    return findByText(['button', '[role="button"]', '.right'], /^(購買|购买|立即購買|立即购买|提交|下一步|確認|确认|結算|结算)$/i, root) ||
      root.querySelector('button.right') ||
      root.querySelector('.right[type="button"]') ||
      root.querySelector('button') ||
      root.querySelector('.right');
  }
  function getCartRoot() {
    return document.querySelector('.shopping-carts-wrapper') ||
      document.querySelector('[class*="shopping-carts-wrapper"]') ||
      document.querySelector('.submit-wrapper') ||
      document.querySelector('[class*="submit-wrapper"]');
  }
  function getCartSubmitButton() {
    const root = getCartRoot();
    if (!root) return null;

    const selectors = [
      '.submit-wrapper .button.submit.active',
      '.submit-wrapper .button.submit',
      '.button.submit.active',
      '.button.submit',
      'button.submit',
      '[role="button"]',
      '.button'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector))
        .filter((el) => /提交訂單|提交订单/.test(getText(el)))
        .filter((el) => !/取消訂單|取消订单/.test(getText(el)));
      const visible = candidates.find(isVisible);
      if (visible) return visible;
      if (candidates[0]) return candidates[0];
    }

    return findByText(['button', '[role="button"]', '.button', 'div'], /^(提交訂單|提交订单)$/, root);
  }
  function isCartSubmitReady(btn) {
    if (!btn) return false;
    if (!isVisible(btn)) return false;
    if (isDisabled(btn)) return false;
    const txt = getText(btn);
    if (!/提交訂單|提交订单/.test(txt)) return false;
    if (/取消訂單|取消订单/.test(txt)) return false;
    return true;
  }

  function getTradePreviewRoot() {
    return document.querySelector('.trade-confirmation-page') ||
      document.querySelector('[class*="trade-confirmation-page"]') ||
      document.querySelector('.trade-confirmation-content') ||
      document.querySelector('[class*="trade-confirmation-content"]');
  }

  function getAgreementBox() {
    const root = getTradePreviewRoot() || document;
    const agreementRe = /本人接受|接受及會遵守|接受及会遵守|購票條款|购票条款|保安及隱私|保安及隐私/;
    const textEl = Array.from(root.querySelectorAll('.agree-text, [class*="agree-text"]'))
      .find((el) => agreementRe.test(getText(el)));
    if (textEl) {
      const box = textEl.closest('.agree-check-box, [class*="agree-check-box"], label, [role="checkbox"]') || textEl.parentElement;
      if (box) return box;
    }

    const candidates = Array.from(root.querySelectorAll('.agree-check-box, [class*="agree-check-box"], label, [role="checkbox"]'));
    const matched = candidates.filter((el) => agreementRe.test(getText(el)));
    const list = matched.length ? matched : candidates;
    return list.find(isVisible) || list[0] || null;
  }

  function isAgreementAccepted(box) {
    if (!box) return false;
    const input = box.querySelector('input[type="checkbox"]');
    if (input) return !!input.checked;

    const aria = box.getAttribute('aria-checked') ||
      box.querySelector('[aria-checked]')?.getAttribute('aria-checked');
    if (aria && aria.toLowerCase() === 'true') return true;

    const classes = Array.from(box.classList || []).map((c) => c.toLowerCase());
    if (classes.some((c) => c === 'checked' || c === 'active' || c === 'selected' || c.includes('is-checked'))) return true;
    if (box.querySelector('.checked, .active, .selected, [aria-checked="true"], input[type="checkbox"]:checked')) return true;

    return box.dataset?.uutixHelperAccepted === '1';
  }

  async function ensureTradeAgreementAccepted(token) {
    const box = await waitFor(
      () => getAgreementBox(),
      token,
      15000,
      20,
      '找不到交易預覽页购票条款勾选框'
    );

    if (isAgreementAccepted(box)) return true;

    updateStatus('交易預覽：勾选购票条款...', '#17a2b8');
    try { box.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    burstClick(box, 1);
    if (box.dataset) box.dataset.uutixHelperAccepted = '1';
    logDebug('已尝试勾选交易預覽页购票条款');
    await sleep(80);
    return true;
  }

  function getPayNowButton() {
    const root = getTradePreviewRoot() || document;
    const selectors = [
      '.button-list .button.submit',
      '.button.submit',
      'button.submit',
      '[role="button"]',
      'button',
      '.button',
      'div'
    ];
    const payRe = /^(立即支付|立即付款|支付訂單|支付订单|PayNow)$/i;

    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector))
        .filter((el) => payRe.test(getText(el)))
        .filter((el) => !/取消|返回|修改/.test(getText(el)));
      const visible = candidates.find(isVisible);
      if (visible) return visible;
      if (candidates[0]) return candidates[0];
    }

    return findByText(['button', '[role="button"]', '.button', 'div'], payRe, root);
  }

  function isPayNowReady(btn) {
    if (!btn) return false;
    if (!isVisible(btn)) return false;
    if (isDisabled(btn)) return false;
    return /立即支付|立即付款|支付訂單|支付订单|PayNow/i.test(getText(btn));
  }

  function isTradePreviewPage() {
    const title = document.title || '';
    if (/\/trade-confirmation/i.test(location.pathname) || /trade-confirmation/i.test(location.href)) return true;
    if (title.includes('交易預覽') || title.includes('交易预览')) return true;
    if (getTradePreviewRoot()) return true;
    return !!(getAgreementBox() && getPayNowButton());
  }

  async function waitTradePreviewPage(token, {
    waitMs = 18000,
    pollMs = 25
  } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 <= waitMs) {
      await ensureNotStopped(token);
      if (isTradePreviewPage()) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async function clickPayNow(token, {
    waitButtonMs = 15000,
    burstWindowMs = PAY_NOW_CLICK_WINDOW_MS
  } = {}) {
    await waitFor(
      () => isTradePreviewPage(),
      token,
      waitButtonMs,
      20,
      '等待交易預覽页超时'
    );

    await ensureTradeAgreementAccepted(token);

    const btn = await waitFor(
      () => {
        const cur = getPayNowButton();
        return isPayNowReady(cur) ? cur : null;
      },
      token,
      waitButtonMs,
      18,
      '找不到可点击的立即支付按钮'
    );

    const handoffSettings = getPaymentSettingsForHandoff();
    setStoredPaymentMethod(handoffSettings.paymentMethod);
    setCashierAutoFlag(true);
    writePaymentHandoff(handoffSettings);
    updateStatus('交易預覽：点击立即支付...', '#007bff');

    const clicked = await clickReadyButtonForWindow({
      token,
      getButton: () => getPayNowButton() || btn,
      isReady: isPayNowReady,
      intervalMs: PAY_NOW_INTERVAL_MS,
      burstClicks: PAY_NOW_BURST_CLICKS,
      windowMs: burstWindowMs,
      label: '立即支付'
    });

    if (clicked > 0) {
      setPayNowFlag(false);
      updateStatus(`已点击立即支付 ✅（${clicked}次）`, '#28a745');
      return true;
    }

    throw new Error('立即支付按钮存在但未能点击');
  }

  async function maybeHandleTradePreview(token, waitMs = 30000) {
    const entered = isTradePreviewPage() || await waitTradePreviewPage(token, { waitMs });
    if (!entered) return false;

    updateStatus('已进入交易預覽页：准备勾选并支付...', '#28a745');
    await clickPayNow(token);
    return true;
  }

  function getCashierRoot() {
    return document.querySelector('#cashier') ||
      document.querySelector('.cashier-body') ||
      document.querySelector('.cashier-container') ||
      document.querySelector('.cashier-box');
  }

  function getCashierConfirmButton() {
    const root = getCashierRoot() || document;
    return queryFirstVisible(['.confirm-btn', '.submit-btn', 'button', '[role="button"]'], root) ||
      findByText(['.confirm-btn', '.submit-btn', 'button', '[role="button"]', 'div'], /^(確認支付|确认支付|立即支付|Pay)$/i, root);
  }

  function isCashierConfirmReady(btn) {
    if (!btn) return false;
    if (!isVisible(btn)) return false;
    if (isDisabled(btn)) return false;
    return /確認支付|确认支付|立即支付|Pay/i.test(getText(btn)) || btn.classList?.contains('confirm-btn');
  }

  function isCashierPaymentPage() {
    const title = document.title || '';
    if (/mcashier\.uutix\.com/i.test(location.host)) return true;
    if (/uutix\s*pay/i.test(title)) return true;
    return !!(getCashierRoot() && getCashierConfirmButton());
  }

  function getCashierPaymentItem(method) {
    const root = getCashierRoot() || document;
    const target = PAYMENT_METHODS[normalizePaymentMethod(method)];
    const items = getCashierPaymentItems(root);

    const matched = items.filter((item) => {
      const title = item.querySelector('.pay-type-title, [class*="pay-type-title"]');
      return target.match.test(getText(title) || getText(item));
    });

    return matched.find(isVisible) || matched[0] || null;
  }

  function getCashierPaymentItems(root = getCashierRoot() || document) {
    return Array.from(root.querySelectorAll('.pay-type-item, [class~="pay-type-item"], [role="radio"], [role="button"]'))
      .filter((item) => {
        const className = String(item.className || '');
        if (/pay-type-item-container/.test(className)) return false;
        const txt = getText(item.querySelector('.pay-type-title, [class*="pay-type-title"]') || item);
        return /VISA|萬事達|万事达|美國運通|美国运通|銀聯|银联|微信|AlipayHK|支付寶|支付宝|master|amex|unionpay|wechat|alipay/i.test(txt);
      });
  }

  function getCashierActivePaymentItem() {
    const root = getCashierRoot() || document;
    const items = getCashierPaymentItems(root);
    return items.find((item) =>
      item.classList?.contains('active') ||
      item.classList?.contains('selected') ||
      item.getAttribute('aria-checked') === 'true' ||
      item.getAttribute('data-selected') === 'true'
    ) || null;
  }

  function isCashierPaymentItemSelected(item) {
    if (!item) return false;
    return item.classList?.contains('active') ||
      item.classList?.contains('selected') ||
      item.getAttribute('aria-checked') === 'true' ||
      item.getAttribute('data-selected') === 'true';
  }

  function isCashierPaymentMethodSelected(method) {
    const active = getCashierActivePaymentItem();
    if (!active) return false;
    const target = PAYMENT_METHODS[normalizePaymentMethod(method)];
    return target.match.test(getText(active.querySelector('.pay-type-title, [class*="pay-type-title"]') || active));
  }

  function dispatchPointerTap(element) {
    if (!element) return 0;
    prepareClickTarget(element);
    const eventTypes = ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click'];
    let sent = 0;
    for (const type of eventTypes) {
      try {
        const event = type.startsWith('touch')
          ? new Event(type, { bubbles: true, cancelable: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        element.dispatchEvent(event);
        sent++;
      } catch (_) {}
    }
    return sent;
  }

  async function selectCashierPaymentMethod(token, method) {
    const normalized = normalizePaymentMethod(method);
    const item = await waitFor(
      () => getCashierPaymentItem(normalized),
      token,
      15000,
      20,
      `找不到支付方式：${getPaymentMethodLabel(normalized)}`
    );

    const t0 = Date.now();
    let clicked = 0;

    while (Date.now() - t0 <= CASHIER_SELECT_RETRY_MS) {
      await ensureNotStopped(token);

      const cur = getCashierPaymentItem(normalized) || item;
      if (isCashierPaymentItemSelected(cur) || isCashierPaymentMethodSelected(normalized)) {
        updateStatus(`支付页：已选择 ${getPaymentMethodLabel(normalized)} ✅`, '#28a745');
        logDebug('支付方式已选中', { method: normalized, clicked });
        return true;
      }

      updateStatus(`支付页：选择 ${getPaymentMethodLabel(normalized)}...`, '#17a2b8');
      clicked += burstClick(cur, 1);
      dispatchPointerTap(cur);
      await sleep(CASHIER_SELECT_RETRY_INTERVAL_MS);
    }

    if (isCashierPaymentMethodSelected(normalized)) return true;
    const activeText = getText(getCashierActivePaymentItem());
    throw new Error(`支付方式未切换到 ${getPaymentMethodLabel(normalized)}（当前：${activeText || '未知'}）`);
  }

  async function clickCashierConfirmPay(token, {
    waitButtonMs = 15000,
    burstWindowMs = CASHIER_CONFIRM_CLICK_WINDOW_MS
  } = {}) {
    const btn = await waitFor(
      () => {
        const cur = getCashierConfirmButton();
        return isCashierConfirmReady(cur) ? cur : null;
      },
      token,
      waitButtonMs,
      18,
      '找不到可点击的確認支付按钮'
    );

    updateStatus('支付页：点击確認支付...', '#007bff');

    const clicked = await clickReadyButtonForWindow({
      token,
      getButton: () => getCashierConfirmButton() || btn,
      isReady: isCashierConfirmReady,
      intervalMs: CASHIER_CONFIRM_INTERVAL_MS,
      burstClicks: CASHIER_CONFIRM_BURST_CLICKS,
      windowMs: burstWindowMs,
      label: '確認支付'
    });

    if (clicked > 0) {
      updateStatus(`已点击確認支付 ✅（${clicked}次）`, '#28a745');
      return true;
    }

    throw new Error('確認支付按钮存在但未能点击');
  }

  function getInputMeta(input) {
    if (!input) return '';
    const parts = [
      input.id,
      input.name,
      input.type,
      input.placeholder,
      input.autocomplete,
      input.getAttribute('aria-label'),
      input.getAttribute('data-testid'),
      input.getAttribute('data-field')
    ];

    if (input.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) parts.push(label.textContent);
      } catch (_) {}
    }

    const parent = input.closest('label, .form-item, .input-item, .field, .adm-list-item, div');
    if (parent) parts.push(parent.textContent);
    return String(parts.filter(Boolean).join(' ')).toLowerCase();
  }

  function getPaymentFormInputs() {
    return Array.from(document.querySelectorAll('input, textarea'))
      .filter((input) => !input.closest('#uutix-helper-panel'))
      .filter(isVisible)
      .filter((input) => !/hidden|submit|button|checkbox|radio/i.test(input.type || ''));
  }

  function getCardFormRoot() {
    const roots = Array.from(document.querySelectorAll('.form-container, [class*="form-container"], form, .cashier-box'));
    return roots.find((root) => /付款資料|付款资料|信用卡|安全碼|安全码|有效期|card/i.test(getText(root))) || document;
  }

  function getPaymentFormItem(titleRe) {
    const root = getCardFormRoot();
    const items = Array.from(root.querySelectorAll('.form-item, [class*="form-item"]'))
      .filter((item) => !item.closest('#uutix-helper-panel'));

    return items.find((item) => {
      const title = item.querySelector('.form-item-title, [class*="form-item-title"]');
      return titleRe.test(getText(title) || getText(item));
    }) || null;
  }

  function getInputFromPaymentFormItem(titleRe) {
    const item = getPaymentFormItem(titleRe);
    if (!item) return null;
    return Array.from(item.querySelectorAll('input, textarea'))
      .filter(isVisible)
      .find((input) => !input.closest('#uutix-helper-panel')) || null;
  }

  function findCardInput(inputs, kind) {
    const patterns = {
      number: /card.?number|cardno|card.?no|卡號|卡号|卡片號碼|卡片号码|信用卡號|信用卡号|pan/,
      holder: /card.?holder|holder.?name|name.?on.?card|持卡人|姓名|card.?name/,
      expiry: /expiry|expire|expiration|valid.?thru|validity|有效期|到期|mm.?yy|yy.?mm/,
      month: /expir.*month|expiry.*month|月份|月|mm/,
      year: /expir.*year|expiry.*year|年份|年|yy|yyyy/,
      cvv: /cvv|cvc|security.?code|安全碼|安全码|驗證碼|验证码|verification.?code/
    };
    return inputs.find((input) => patterns[kind].test(getInputMeta(input))) || null;
  }

  function setNativeInputValue(input, value) {
    if (!input || value == null || value === '') return false;
    try {
      input.focus();
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function parseExpiry(expiry) {
    const raw = String(expiry || '').trim();
    const clean = raw.replace(/\s+/g, '');
    const m = clean.match(/^(\d{1,2})[\/-]?(\d{2,4})$/);
    if (!m) return { combined: raw, month: '', year: '' };
    const month = m[1].padStart(2, '0');
    const year = m[2].length === 2 ? `20${m[2]}` : m[2];
    return { combined: `${month}/${year.slice(-2)}`, month, year };
  }

  function fillCardInputsOnce(settings) {
    const card = settings?.card || {};
    const inputs = getPaymentFormInputs();

    let filled = 0;
    const numberInput = getInputFromPaymentFormItem(/信用卡號碼|信用卡号码|卡號|卡号|card/i) || findCardInput(inputs, 'number');
    const holderInput = getInputFromPaymentFormItem(/持卡人|姓名|holder|name/i) || findCardInput(inputs, 'holder');
    const expiryInput = getInputFromPaymentFormItem(/有效期|到期|expiry|expire/i) || findCardInput(inputs, 'expiry');
    const monthInput = findCardInput(inputs, 'month');
    const yearInput = findCardInput(inputs, 'year');
    const cvvInput = getInputFromPaymentFormItem(/安全碼|安全码|cvv|cvc|驗證碼|验证码/i) || findCardInput(inputs, 'cvv');
    const expiry = parseExpiry(card.expiry);

    if (numberInput && setNativeInputValue(numberInput, card.number)) filled++;
    if (holderInput && setNativeInputValue(holderInput, card.holder)) filled++;
    if (expiryInput && setNativeInputValue(expiryInput, expiry.combined)) filled++;
    if (!expiryInput && monthInput && setNativeInputValue(monthInput, expiry.month)) filled++;
    if (!expiryInput && yearInput && setNativeInputValue(yearInput, expiry.year)) filled++;
    if (cvvInput && setNativeInputValue(cvvInput, card.cvv)) filled++;

    return filled;
  }

  function getExpiryCustomBoxes() {
    const item = getPaymentFormItem(/有效期|到期|expiry|expire/i);
    if (!item) return [];
    return Array.from(item.querySelectorAll('.form-item-input.sm, [class*="form-item-input"][class*="sm"], [role="button"]'))
      .filter((el) => !el.closest('#uutix-helper-panel'))
      .filter((el) => !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement))
      .filter(isVisible)
      .slice(0, 2);
  }

  function isBoxValueSelected(box, values) {
    const text = getText(box);
    return values.some((value) => normalizeText(value) === text || text.includes(normalizeText(value)));
  }

  function getVisibleExactTextElements(values) {
    const normalized = values.map(normalizeText).filter(Boolean);
    return Array.from(document.body.querySelectorAll('[role="option"], li, button, div, span'))
      .filter((el) => !el.closest('#uutix-helper-panel'))
      .filter(isVisible)
      .filter((el) => normalized.includes(getText(el)));
  }

  async function chooseCustomSelectValue(box, values, token) {
    if (!box || !values.length) return false;
    if (isBoxValueSelected(box, values)) return true;

    try { box.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    burstClick(box, 1);

    const t0 = Date.now();
    while (Date.now() - t0 <= 1600) {
      await ensureNotStopped(token);
      const candidates = getVisibleExactTextElements(values)
        .filter((el) => el !== box && !box.contains(el));

      if (candidates.length) {
        const target = candidates[candidates.length - 1];
        burstClick(target, 1);
        await sleep(120);
        return isBoxValueSelected(box, values) || !/MM|YYYY|YY|月份|年份/i.test(getText(box));
      }

      await sleep(40);
    }

    return false;
  }

  async function fillExpiryCustomControls(token, expiryRaw) {
    const expiry = parseExpiry(expiryRaw);
    if (!expiry.month || !expiry.year) return false;

    const boxes = getExpiryCustomBoxes();
    if (boxes.length < 2) return false;

    const shortYear = expiry.year.slice(-2);
    const monthValues = [expiry.month, String(parseInt(expiry.month, 10))];
    const yearValues = [expiry.year, shortYear];

    const monthOk = await chooseCustomSelectValue(boxes[0], monthValues, token);
    const yearOk = await chooseCustomSelectValue(boxes[1], yearValues, token);

    return monthOk && yearOk;
  }

  async function fillCardPaymentForm(token, settings, timeoutMs = 16000) {
    if (!isCardPaymentMethod(settings?.paymentMethod)) return false;
    const card = settings?.card || {};
    if (!card.number && !card.expiry && !card.cvv && !card.holder) return false;

    const t0 = Date.now();
    let expiryDone = !card.expiry;
    let bestFilled = 0;

    while (Date.now() - t0 <= timeoutMs) {
      await ensureNotStopped(token);
      const filled = fillCardInputsOnce(settings);
      if (filled > bestFilled) bestFilled = filled;

      if (!expiryDone) {
        expiryDone = await fillExpiryCustomControls(token, card.expiry);
      }

      if (filled > 0 && expiryDone) {
        updateStatus(`已填入银行卡信息字段 ✅（${filled + (card.expiry ? 1 : 0)}项）`, '#28a745');
        logDebug('已填入银行卡信息字段', { filled, expiryDone });
        return true;
      }
      await sleep(180);
    }

    if (bestFilled > 0) updateStatus('已填入部分银行卡字段，但有效期/必要字段未完成', '#ff9800');
    else updateStatus('未在当前支付页发现银行卡信息输入框', '#ff9800');
    return false;
  }

  async function handleCashierPayment(token) {
    await waitFor(
      () => isCashierPaymentPage(),
      token,
      20000,
      20,
      '等待支付页超时'
    );

    const settings = getPaymentSettingsForCurrentPage();
    clearPaymentHandoff();
    setCashierAutoFlag(false);
    const method = normalizePaymentMethod(settings.paymentMethod);

    updateStatus(`支付页：准备使用 ${getPaymentMethodLabel(method)}...`, '#17a2b8');
    await selectCashierPaymentMethod(token, method);

    if (isCardPaymentMethod(method)) {
      await fillCardPaymentForm(token, settings, 2500);
    }

    await clickCashierConfirmPay(token);

    if (isCardPaymentMethod(method)) {
      await fillCardPaymentForm(token, settings, 18000);
      updateStatus('银行卡信息已尝试填入；请核对后按页面要求继续', '#28a745');
    }

    clearPaymentHandoff();
    setCashierAutoFlag(false);
    return true;
  }

  function isTicketSelectionPage() {
    return !!(
      document.querySelector('.ticket-container') ||
      document.querySelector('.show-area') ||
      document.querySelector('.multiple-ticket-area') ||
      getPriceList() ||
      getFinalBuyButton()
    );
  }

  // --------------------------
  // ✅ 购票点击后：等待跳到购物车页再停止
  // --------------------------
  function isInShoppingCartPage() {
    if (isTradePreviewPage()) return false;

    // 1) URL 判断（最稳，最快）
    if (/\/shopping-cart/i.test(location.pathname) || /shopping-cart/i.test(location.href)) return true;

    // 2) DOM 标志
    // title: 購物車 / page wrapper: .shopping-carts-wrapper
    // 交易預覽页也有 .step-section，所以不要单独用它判断购物车。
    const title = document.title || '';
    if (title.includes('購物車') || title.includes('购物车')) return true;
    if (document.querySelector('.shopping-carts-wrapper')) return true;

    return false;
  }

  async function waitEnterCartAfterClick(token, {
    waitMs = 12000,        // 最多等 12s
    stableMs = 250,        // 连续满足 250ms 才算真正进入
    pollMs = SUBMIT_CLICK_INTERVAL_MS,
    keepClickIntervalMs = SUBMIT_CLICK_INTERVAL_MS, // 等待期间按指定节奏补点，直到跳转或超时
    keepClickBurstClicks = SUBMIT_BURST_CLICKS
  } = {}) {
    const t0 = Date.now();
    let okStart = null;
    let lastKeepClick = 0;

    while (true) {
      await ensureNotStopped(token);

      // 如果直接进了交易預覽页，交给后续支付流程处理。
      if (isTradePreviewPage()) return 'preview';
      if (isCrowdLimitPage()) return 'crowd';

      // 如果已经跳到购物车，稳定确认
      if (isInShoppingCartPage()) {
        if (okStart == null) okStart = Date.now();
        if (Date.now() - okStart >= stableMs) return 'cart';
      } else {
        okStart = null;
      }

      // 等待期间：如果还在 detail 页且按钮还能点，就间歇补点
      // （避免“点了但没触发路由/请求”这种偶发）
      if (!isInShoppingCartPage() && !isLoadingVisible()) {
        const now = Date.now();
        if (now - lastKeepClick >= keepClickIntervalMs) {
          const btn = getFinalBuyButton();
          if (btn && !isDisabled(btn)) burstClick(btn, keepClickBurstClicks);
          lastKeepClick = now;
        }
      }

      if (Date.now() - t0 > waitMs) return false;
      await sleep(pollMs);
    }
  }

  // --------------------------
  // ✅ 入口按钮：从“已订阅”变“购买”自动点击
  // --------------------------
  function getEntryButton() {
    return queryFirstVisible([
      '.detail__info-btn .button.detail-normal-button',
      '.detail__info-btn .detail-normal-button',
      '.detail-normal-button'
    ]) || findByText([
      '.detail__info-btn .button',
      '.detail__info-btn [role="button"]',
      '.detail__info-btn button',
      '.detail__info-btn div'
    ], /購買門票|购买门票|立即購買|立即购买|BuyNow|Buy/);
  }

  function isEntryBuyReady(btn) {
    if (!btn) return false;
    if (!isVisible(btn)) return false;
    if (isDisabled(btn)) return false;
    if (btn.classList.contains('detail-subscribe-button')) return false;

    const txt = (btn.textContent || '').replace(/\s+/g, '');
    if (!txt) return false;
    if (txt.includes('已訂閱') || txt.includes('已订阅') || txt.includes('訂閱') || txt.includes('订阅')) return false;
    if (/缺貨|缺货|售罄|已售|暫無|暂无|不可售|未開售|未开售/.test(txt)) return false;

    return /購買|购买|立即購買|立即购买|Buy|BuyNow|下單|下单|結算|结算|搶購|抢购/.test(txt);
  }

  async function waitEntryBecomeBuyAndClick(token) {
  const btn = await waitFor(
    () => getEntryButton(),
    token,
    30000,
    50,
    '找不到入口按钮（detail-normal-button）'
  );

  updateStatus('等待入口按钮变为购买状态...', '#17a2b8');
  startEntryClockMonitor(token);

  let clickTimer = null;

  function hasEnteredNextStep() {
    return isTicketSelectionPage();
  }

  function startClicking() {
    if (clickTimer) return;

    markCrowdRetryArmed();
    updateStatus('入口为购买状态：持续点击入口按钮...', '#007bff');

    const entryClickTick = () => {
      try {
        if (!isRunning || token !== runToken) {
          clearInterval(clickTimer);
          clickTimer = null;
          return;
        }

        if (hasEnteredNextStep()) {
          clearInterval(clickTimer);
          clickTimer = null;
          updateStatus('已进入下一步界面 ✅', '#28a745');
          return;
        }

        const cur = getEntryButton();
        if (cur && isEntryBuyReady(cur)) {
          burstClick(cur, 2);
        }
      } catch (_) {}
    };

    clickTimer = setInterval(entryClickTick, ENTRY_CLICK_INTERVAL_MS); // 入口点击频率
    entryClickTick();
  }

  // 情况 1：一开始就是购买状态
  if (isEntryBuyReady(btn)) {
    startClicking();
  }

  // 情况 2：从“已订阅”变“购买”
  const parent =
    btn.parentElement ||
    document.querySelector('.detail__info-btn') ||
    document.body;

  entryObserver = new MutationObserver(() => {
    try {
      if (!isRunning || token !== runToken) return;

      const cur = getEntryButton();
      if (cur && isEntryBuyReady(cur)) {
        startClicking();
      }
    } catch (_) {}
  });

  try {
    entryObserver.observe(parent, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'disabled', 'aria-disabled']
    });
  } catch (_) {}

  // 阻塞等待：直到真正进入下一步
  await waitUntil(
    () => hasEnteredNextStep(),
    token,
    6 * 60 * 1000,
    50,
    '等待进入下一步界面超时'
  );

  clearEntryObserver();
  clearEntryClockMonitor();
  clearCrowdRetryFlag();
  return true;
}

  // --------------------------
  // Step 1：场次（sessionPosition=1 跳过）
  // --------------------------
  async function stepSelectSession(sessionPosition, token) {
    if (sessionPosition === 1) {
      updateStatus('场次=1：跳过选择场次/Loading检查 ✅', '#28a745');
      return { targetShowId: null, skipped: true };
    }

    const dd = await waitFor(() => getSessionDropdown(), token, 12000, 20, '找不到场次下拉框');
    const checked = await waitFor(() => getSessionChecked(dd), token, 12000, 20, '找不到场次当前选中区域');

    let targetShowId = null;
    let targetSessionText = '';

    await retryStep(
      `选择场次#${sessionPosition}`,
      token,
      async () => {
        checked.click();

        const container = await waitFor(() => getSessionContainerVisible(), token, 6000, 20, '场次下拉未展开');
        const items = getSessionItems(container);
        if (!items.length) throw new Error('场次列表为空');

        const target = items[sessionPosition - 1];
        if (!target) throw new Error(`无效场次位置：${sessionPosition}（当前只有 ${items.length} 个场次）`);

        const wrap = target.closest('.item-wrap');
        targetShowId = parseShowIdFromWrap(wrap) || targetShowId;
        targetSessionText = getText(target) || targetSessionText;

        target.scrollIntoView({ block: 'center' });
        target.click();

        await sleep(20);
        const c2 = dd.querySelector('.select-item-container, [class*="select-item-container"]');
        if (c2 && isVisible(c2)) checked.click();

        updateStatus('切换场次：等待 loading 稳定结束...', '#ffc107');
        await waitLoadingStableGone(token, { stableGoneMs: 160 });
      },
      async () => {
        return await waitCondStable(() => {
          const selWrap = getSelectedSessionWrap();
          if (!selWrap) return false;
          const selId = parseShowIdFromWrap(selWrap);
          if (targetShowId) return selId === targetShowId;
          const selText = getText(selWrap);
          if (targetSessionText) return selText.includes(targetSessionText) || targetSessionText.includes(selText);
          return !!selId || !!selText;
        }, token, 80, 3500, 16, '场次稳定确认超时');
      },
      { maxRetry: 60, betweenMs: 35 }
    );

    return { targetShowId, targetSessionText, skipped: false };
  }

  // --------------------------
  // Step 2：票价
  // --------------------------
  async function stepSelectPrice(pricePosition, token, { rushReturn = RUSH_RETURN_DEFAULT } = {}) {
    let targetTicketId = null;
    let targetTicketText = '';
    let targetTemporaryNoTicket = false;

    await retryStep(
      `选择票价#${pricePosition}`,
      token,
      async () => {
        const { wraps } = await waitForPriceWraps(pricePosition, token);

        const targetWrap = wraps[pricePosition - 1];
        if (!targetWrap) throw new Error(`无效票价位置：${pricePosition}（当前只有 ${wraps.length} 个票价）`);

        const item = targetWrap.querySelector('.item') || targetWrap;
        if (!item) throw new Error('票价项结构异常');

        targetTemporaryNoTicket = isTicketTemporaryNoTicket(targetWrap);
        if (isTicketUnavailable(targetWrap) && !(rushReturn && targetTemporaryNoTicket)) {
          const stateText = getTicketStateText(targetWrap) || getText(targetWrap) || '未知状态';
          throw new Error(`目标票价#${pricePosition} 不可购买：${stateText}`);
        }

        if (rushReturn && targetTemporaryNoTicket) {
          updateStatus(`抢回流：目标票价#${pricePosition} 暂时无票，继续尝试購買`, '#ff9800');
        }

        targetTicketId = parseTicketIdFromWrap(targetWrap) || targetTicketId;
        targetTicketText = getText(item) || targetTicketText;

        item.scrollIntoView({ block: 'center' });
        item.click();
      },
      async () => {
        return await waitCondStable(() => {
          const selWrap = getSelectedTicketWrap();
          if (!selWrap) return false;
          const selId = parseTicketIdFromWrap(selWrap);
          if (targetTicketId) return selId === targetTicketId;
          const selText = getText(selWrap);
          if (targetTicketText) return selText.includes(targetTicketText) || targetTicketText.includes(selText);
          return !!selId || !!selText;
        }, token, 70, 3200, 16, '票价稳定确认超时');
      },
      { maxRetry: 80, betweenMs: 25 }
    );

    return { targetTicketId, targetTicketText, targetTemporaryNoTicket };
  }

  // --------------------------
  // Step 3：数量
  // --------------------------
  async function stepSetQuantity(quantity, token) {
    const limit = getTicketLimit();
    if (limit !== null && quantity > limit) {
      throw new Error(`目标数量 ${quantity} 超过页面限购 ${limit}`);
    }

    if (quantity <= 1) {
      await waitCondStable(() => {
        const n = getQuantityNumber();
        return n === 1 || n === null;
      }, token, 60, 2000, 20, '数量=1 确认超时');
      return { quantity };
    }

    await retryStep(
      `设置数量=${quantity}`,
      token,
      async () => {
        const inc = getIncreaseBtn();
        if (!inc) throw new Error('未找到加号按钮');
        if (isDisabled(inc)) throw new Error('加号按钮当前不可用');

        const n = getQuantityNumber();
        if (Number.isFinite(n) && n < quantity) {
          await fastClick(inc, quantity - n, token, 12);
        } else if (n === null) {
          await fastClick(inc, Math.max(0, quantity - 1), token, 12);
        }
      },
      async () => {
        return await waitCondStable(() => {
          const n = getQuantityNumber();
          if (n === null) return true;
          return n === quantity;
        }, token, 70, 3200, 16, '数量稳定确认超时');
      },
      { maxRetry: 90, betweenMs: 20 }
    );

    return { quantity };
  }

  // --------------------------
  // 主流程
  // --------------------------
  function readTargetsFromPanel() {
    const readPositiveInt = (id) => {
      const n = parseInt(document.getElementById(id)?.value, 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    };
    const sessionPosition = readPositiveInt('session-position');
    const pricePosition = readPositiveInt('price-position');
    const quantity = readPositiveInt('ticket-quantity');
    const rushReturn = document.getElementById('rush-return-toggle')?.dataset?.enabled === '1';
    const rushIntervalMs = normalizeRushReturnIntervalMs(document.getElementById('rush-return-interval')?.value);
    const paymentMethod = normalizePaymentMethod(document.getElementById('payment-method')?.value || 'wechat');
    return { sessionPosition, pricePosition, quantity, paymentMethod, rushReturn, rushIntervalMs };
  }

  function readPaymentSettingsFromPanel() {
    return {
      paymentMethod: normalizePaymentMethod(document.getElementById('payment-method')?.value || 'wechat'),
      card: {
        holder: String(document.getElementById('card-holder')?.value || '').trim(),
        number: String(document.getElementById('card-number')?.value || '').replace(/\s+/g, ''),
        expiry: String(document.getElementById('card-expiry')?.value || '').trim(),
        cvv: String(document.getElementById('card-cvv')?.value || '').trim()
      }
    };
  }

  function saveTargetsToStorage(targets) {
    try {
      setStoredPaymentMethod(targets.paymentMethod);
      localStorage.setItem(TARGETS_KEY, JSON.stringify({
        sessionPosition: targets.sessionPosition,
        pricePosition: targets.pricePosition,
        quantity: targets.quantity,
        paymentMethod: normalizePaymentMethod(targets.paymentMethod),
        rushReturn: !!targets.rushReturn,
        rushIntervalMs: normalizeRushReturnIntervalMs(targets.rushIntervalMs)
      }));
    } catch (_) {}
  }

  function loadTargetsIntoPanel() {
    try {
      const raw = localStorage.getItem(TARGETS_KEY);
      if (!raw) return;
      const targets = JSON.parse(raw);
      const map = {
        'session-position': targets.sessionPosition,
        'price-position': targets.pricePosition,
        'ticket-quantity': targets.quantity
      };
      Object.keys(map).forEach((id) => {
        const input = document.getElementById(id);
        const value = parseInt(map[id], 10);
        if (input && Number.isFinite(value) && value > 0) input.value = String(value);
      });
      const rushIntervalInput = document.getElementById('rush-return-interval');
      if (rushIntervalInput) {
        rushIntervalInput.value = String(normalizeRushReturnIntervalMs(targets.rushIntervalMs));
      }
      const paymentSelect = document.getElementById('payment-method');
      const method = normalizePaymentMethod(targets.paymentMethod || 'wechat');
      if (paymentSelect && method) {
        paymentSelect.value = normalizePaymentMethod(method);
        toggleCardFields();
      }
      setRushReturnToggle(!!targets.rushReturn, false);
    } catch (_) {}
  }

  function getSubmitClickProfile(target, priceResult) {
    const isRushMode = !!(target?.rushReturn && priceResult?.targetTemporaryNoTicket);
    if (!isRushMode) {
      return {
        isRushMode: false,
        intervalMs: SUBMIT_CLICK_INTERVAL_MS,
        burstClicks: SUBMIT_BURST_CLICKS
      };
    }

    return {
      isRushMode: true,
      intervalMs: normalizeRushReturnIntervalMs(target.rushIntervalMs),
      burstClicks: RUSH_RETURN_BURST_CLICKS
    };
  }

  function buildPaymentHandoff(settings) {
    const method = normalizePaymentMethod(settings?.paymentMethod);
    return {
      marker: PAYMENT_HANDOFF_MARK,
      ts: Date.now(),
      paymentMethod: method,
      card: isCardPaymentMethod(method) ? {
        holder: String(settings?.card?.holder || ''),
        number: String(settings?.card?.number || ''),
        expiry: String(settings?.card?.expiry || ''),
        cvv: String(settings?.card?.cvv || '')
      } : {}
    };
  }

  function writePaymentHandoff(settings) {
    try {
      window.name = JSON.stringify(buildPaymentHandoff(settings));
      logDebug('已准备支付页临时设置', {
        paymentMethod: normalizePaymentMethod(settings?.paymentMethod),
        hasCardInfo: isCardPaymentMethod(settings?.paymentMethod) && !!settings?.card?.number
      });
      return true;
    } catch (e) {
      logDebug('支付页临时设置写入失败', e?.message || e);
      return false;
    }
  }

  function readPaymentHandoff() {
    try {
      const raw = String(window.name || '');
      if (!raw || !raw.includes(PAYMENT_HANDOFF_MARK)) return null;
      const payload = JSON.parse(raw);
      if (payload?.marker !== PAYMENT_HANDOFF_MARK) return null;
      if (Date.now() - Number(payload.ts || 0) > 15 * 60 * 1000) return null;
      return {
        paymentMethod: normalizePaymentMethod(payload.paymentMethod),
        card: {
          holder: String(payload.card?.holder || ''),
          number: String(payload.card?.number || ''),
          expiry: String(payload.card?.expiry || ''),
          cvv: String(payload.card?.cvv || '')
        }
      };
    } catch (_) {
      return null;
    }
  }

  function clearPaymentHandoff() {
    try {
      const raw = String(window.name || '');
      if (raw.includes(PAYMENT_HANDOFF_MARK)) window.name = '';
    } catch (_) {}
  }

  function getPaymentSettingsForCurrentPage() {
    return readPaymentHandoff() || readPaymentSettingsFromPanel();
  }

  function hasCardInfo(settings) {
    const card = settings?.card || {};
    return !!(card.number || card.expiry || card.cvv || card.holder);
  }

  function getPaymentSettingsForHandoff() {
    const panelSettings = readPaymentSettingsFromPanel();
    const existing = readPaymentHandoff();
    const panelMethod = normalizePaymentMethod(panelSettings.paymentMethod);

    if (existing && isCashierPaymentPage()) {
      return existing;
    }

    if (
      existing &&
      normalizePaymentMethod(existing.paymentMethod) === panelMethod &&
      isCardPaymentMethod(panelMethod) &&
      !hasCardInfo(panelSettings) &&
      hasCardInfo(existing)
    ) {
      return existing;
    }

    return panelSettings;
  }

  function getUrlParamValue(names) {
    const params = new URLSearchParams(location.search || '');
    for (const name of names) {
      const value = params.get(name);
      if (value) return value;
    }
    return null;
  }

  function extractTicketWrapState(wrap, index) {
    if (!wrap) return null;
    const item = wrap.querySelector('.item') || wrap;
    return {
      position: index + 1,
      ticketId: parseTicketIdFromWrap(wrap),
      name: getText(wrap.querySelector('.first-floor, [class*="first-floor"]') || wrap),
      detail: getText(wrap.querySelector('.second-floor, [class*="second-floor"]') || wrap),
      stateText: getTicketStateText(wrap),
      unavailable: isTicketUnavailable(wrap),
      temporaryNoTicket: isTicketTemporaryNoTicket(wrap),
      selected: item?.classList?.contains('selected') || wrap.contains(getSelectedTicketWrap())
    };
  }

  function extractPageState() {
    const sessionItems = getSessionItems(getSessionContainerVisible() || getSessionDropdown())
      .filter((item) => !item.closest('#uutix-helper-panel'));
    const selectedSession = getSelectedSessionWrap();
    const priceWraps = getPriceWraps(getPriceList());
    const targets = readTargetsFromPanel();
    const cashierParams = new URLSearchParams(location.search || '');
    const cashierQueryKeys = Array.from(cashierParams.keys()).filter(Boolean);

    return {
      capturedAt: new Date().toISOString(),
      page: {
        host: location.host,
        path: location.pathname,
        url: redactUrl(location.href),
        title: document.title || ''
      },
      ids: {
        projectId: getUrlParamValue(['pId', 'projectId']),
        performanceId: getUrlParamValue(['performance_id', 'performanceId']),
        selectedShowId: parseShowIdFromWrap(selectedSession),
        selectedTicketId: parseTicketIdFromWrap(getSelectedTicketWrap()),
        orderIdInUrl: getUrlParamValue(['orderId', 'orderid'])
      },
      target: {
        sessionPosition: targets.sessionPosition,
        pricePosition: targets.pricePosition,
        quantity: targets.quantity,
        paymentMethod: targets.paymentMethod,
        rushReturn: targets.rushReturn,
        rushIntervalMs: targets.rushIntervalMs
      },
      sessions: sessionItems.slice(0, 50).map((item, index) => {
        const wrap = item.closest('.item-wrap') || item;
        return {
          position: index + 1,
          showId: parseShowIdFromWrap(wrap),
          text: getText(wrap),
          selected: wrap === selectedSession || wrap.contains(selectedSession)
        };
      }),
      tickets: priceWraps.slice(0, 80).map(extractTicketWrapState),
      quantity: {
        current: getQuantityNumber(),
        limit: getTicketLimit()
      },
      cashier: isCashierPaymentPage() ? {
        queryKeys: cashierQueryKeys,
        hasPayToken: cashierParams.has('payToken') || cashierParams.has('paytoken'),
        hasTradeNo: cashierParams.has('tradeNo') || cashierParams.has('tradeno'),
        paymentItems: getCashierPaymentItems().map((item) => ({
          text: getText(item),
          selected: isCashierPaymentItemSelected(item)
        }))
      } : null,
      recentNetwork: networkRecorder.records.slice(-20)
    };
  }

  async function fetchDetailClockSnapshot(projectId) {
    if (!projectId) throw new Error('缺少 pId，无法校准详情页倒计时');

    const url = new URL('/api/oversea/project/detail', location.origin);
    url.searchParams.set('bizId', String(projectId));
    url.searchParams.set('source', '0');
    url.searchParams.set('t', String(Date.now()));
    url.searchParams.set('WuKongReady', 'h5');

    const t0 = Date.now();
    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        accept: 'application/json, text/plain, */*',
        language: 'zh-HK',
        clientplatform: '1',
        sellchannel: '23',
        'cache-control': 'no-cache'
      }
    });
    const text = await response.text();
    const t1 = Date.now();
    const json = safeJsonParse(text);
    if (!response.ok) throw new Error(`/api/oversea/project/detail HTTP ${response.status}`);
    if (!json) throw new Error('/api/oversea/project/detail 未返回 JSON');
    const code = json.code ?? json.statusCode ?? json.errno;
    const ok = json.success === true || code === 200 || code === 0 || code == null;
    if (!ok) throw new Error(json?.message || json?.msg || json?.error || `接口返回 code=${code}`);

    const rttMs = Math.max(0, t1 - t0);
    const midpointMs = Math.round((t0 + t1) / 2);
    const serverTime = Number(json?.attrMaps?.serverTime);
    const httpDate = response.headers.get('date') || '';
    const httpDateMs = httpDate ? Date.parse(httpDate) : NaN;

    return {
      projectId: String(projectId),
      capturedAt: t1,
      rttMs,
      serverTime,
      httpDateMs,
      httpDate,
      uutixServerVsBrowserMs: Number.isFinite(serverTime) ? serverTime - midpointMs : NaN,
      httpDateVsBrowserMs: Number.isFinite(httpDateMs) ? httpDateMs - midpointMs : NaN,
      uutixServerVsHttpDateMs: Number.isFinite(serverTime) && Number.isFinite(httpDateMs) ? serverTime - httpDateMs : NaN
    };
  }

  function renderClockSnapshot(sample) {
    if (!sample) return { text: '未校准', color: '#6c757d' };
    const primaryMs = Number.isFinite(sample.uutixServerVsHttpDateMs)
      ? sample.uutixServerVsHttpDateMs
      : sample.uutixServerVsBrowserMs;
    const primaryLabel = Number.isFinite(sample.uutixServerVsHttpDateMs) ? 'HTTP Date' : '本机';
    if (!Number.isFinite(primaryMs)) {
      return { text: '已请求详情接口，但未读到 serverTime/Date 头', color: '#ff9800' };
    }
    const ageMs = Date.now() - sample.capturedAt;
    const direction = primaryMs >= 0 ? '快' : '慢';
    const abs = Math.abs(primaryMs);
    let advice = '正常，无需刷新';
    if (ageMs > 5 * 60 * 1000) {
      advice = '校准较久，建议开抢前手动校准一次';
    } else if (abs > 2000) {
      advice = '偏差较大，先手动校准；仍偏大再刷新详情页';
    } else if (abs > 500) {
      advice = '轻微偏差，开抢前可手动校准一次';
    }

    const lines = [
      `网页倒计时：比${primaryLabel}${direction} ${formatSignedMs(primaryMs).replace(/^[+-]/, '')}`,
      `建议：${advice}`,
      `参考：UUTIX-本机 ${formatSignedMs(sample.uutixServerVsBrowserMs)}${Number.isFinite(sample.httpDateVsBrowserMs) ? `；Date-本机 ${formatSignedMs(sample.httpDateVsBrowserMs)}` : ''}`,
      `网络：RTT ${Math.round(sample.rttMs)}ms；校准 ${formatDurationShort(ageMs)} 前`
    ];
    return { text: lines.join('\n'), color: getClockSkewColor(primaryMs) };
  }

  async function refreshDetailClockDisplay({ force = false } = {}) {
    const projectId = getUrlParamValue(['pId', 'projectId']) || extractPageState().ids.projectId;
    if (!projectId) {
      updateClockDisplay('当前页无 pId，无法比较详情页倒计时', '#6c757d');
      return null;
    }

    // 非强制刷新只复用上一次校准结果，避免频繁请求详情接口。
    if (!force && entryClockLastSample && String(entryClockLastSample.projectId || '') === String(projectId)) {
      const rendered = renderClockSnapshot(entryClockLastSample);
      updateClockDisplay(rendered.text, rendered.color);
      return entryClockLastSample;
    }

    if (!force && Date.now() - entryClockLastFetchAt < 60000) {
      updateClockDisplay('等待手动校准或自动冷却结束...', '#6c757d');
      return null;
    }

    try {
      entryClockLastFetchAt = Date.now();
      updateClockDisplay('正在校准 UUTIX serverTime...', '#17a2b8');
      const sample = await fetchDetailClockSnapshot(projectId);
      entryClockLastSample = sample;
      const rendered = renderClockSnapshot(sample);
      updateClockDisplay(rendered.text, rendered.color);
      return sample;
    } catch (e) {
      updateClockDisplay(`校准失败：${e?.message || e}`, '#ff9800');
      return null;
    }
  }

  function startEntryClockMonitor(token) {
    clearEntryClockMonitor();
    const projectId = getUrlParamValue(['pId', 'projectId']) || extractPageState().ids.projectId;
    const needFresh = !entryClockLastSample ||
      String(entryClockLastSample.projectId || '') !== String(projectId || '') ||
      Date.now() - entryClockLastSample.capturedAt > 5 * 60 * 1000;
    refreshDetailClockDisplay({ force: needFresh });
    entryClockTimer = setInterval(() => {
      if (!isRunning || token !== runToken) {
        clearEntryClockMonitor();
        return;
      }
      refreshDetailClockDisplay();
    }, 1000);
  }

  function extractApiState() {
    const records = networkRecorder.records.slice(-80);
    const endpoints = records.map((record) => ({
      method: record.method,
      url: record.url,
      status: record.status,
      type: record.type
    }));
    return {
      recording: networkRecorder.recording,
      records: records.length,
      endpoints
    };
  }

  function matchTarget(pageState = extractPageState()) {
    const target = pageState.target;
    const targetSession = pageState.sessions.find((item) => item.position === target.sessionPosition) || null;
    const targetTicket = pageState.tickets.find((item) => item.position === target.pricePosition) || null;
    const quantityOk = !pageState.quantity.limit || target.quantity <= pageState.quantity.limit;
    return {
      matched: !!targetTicket && quantityOk,
      targetSession,
      targetTicket,
      quantityOk,
      notes: [
        targetSession ? null : '当前页面未能确认目标场次',
        targetTicket ? null : '当前页面未能确认目标票档',
        quantityOk ? null : `目标数量超过页面限购 ${pageState.quantity.limit}`
      ].filter(Boolean)
    };
  }

  function buildPurchaseCandidate() {
    const pageState = extractPageState();
    const apiState = extractApiState();
    const matched = matchTarget(pageState);
    return {
      mode: 'dry-run-only',
      willSendRequest: false,
      canBuildCreateOrderRequest: false,
      reason: '当前脚本只构造候选信息；建单接口已知但含 mygsig/Rohr fingerprint 等动态参数，必须由页面原生流程生成，脚本不手工直发。',
      missingFields: [
        '页面当前流程生成的 mygsig',
        'Rohr 风控生成的 cart/order fingerprint',
        '失败码、验证码、限流分支的实际返回',
        'cashier submitPay 的 x-csrf-token 与支付页 fingerprint'
      ],
      pageState,
      apiState,
      matched
    };
  }

  function dryRunPurchase() {
    const candidate = buildPurchaseCandidate();
    logDebug('Dry Run：候选购票参数（不会发送创建订单请求）', candidate);
    try {
      console.table({
        page: `${candidate.pageState.page.host}${candidate.pageState.page.path}`,
        projectId: candidate.pageState.ids.projectId || '',
        showId: candidate.pageState.ids.selectedShowId || '',
        ticketId: candidate.pageState.ids.selectedTicketId || '',
        targetSession: candidate.pageState.target.sessionPosition,
        targetTicket: candidate.pageState.target.pricePosition,
        quantity: candidate.pageState.target.quantity,
        matched: candidate.matched.matched
      });
    } catch (_) {}
    updateStatus('Dry Run 已输出到控制台；未发送创建订单请求', '#17a2b8');
    return candidate;
  }

  function feasibilityReport() {
    const candidate = buildPurchaseCandidate();
    const hasCreateLikeRecord = networkRecorder.records.some((record) =>
      /order|trade|cart|submit|lock|ticket/i.test(record.url) &&
      String(record.method || '').toUpperCase() === 'POST'
    );
    const report = {
      conclusion: hasCreateLikeRecord
        ? '发现疑似状态改变请求，请结合导出的日志继续人工核对。'
        : '当前页面/日志尚未捕获创建订单或锁票接口，暂不建议直接 API 下单。',
      recommendedMode: hasCreateLikeRecord ? 'API 识别 + 页面点击混合方案' : '先记录真实购票链路，再做 API 识别 + 页面点击混合方案',
      dryRunCandidate: candidate
    };
    logDebug('API 可行性报告（页面内原型）', report);
    return report;
  }

  function setAutoRunFlag(enabled) {
    try {
      if (enabled) localStorage.setItem(AUTO_RUN_KEY, '1');
      else localStorage.removeItem(AUTO_RUN_KEY);
    } catch (_) {}
  }

  function setCartSubmitFlag(enabled) {
    try {
      if (enabled) localStorage.setItem(CART_SUBMIT_KEY, '1');
      else localStorage.removeItem(CART_SUBMIT_KEY);
    } catch (_) {}
  }

  function setPayNowFlag(enabled) {
    try {
      if (enabled) localStorage.setItem(PAY_NOW_KEY, '1');
      else localStorage.removeItem(PAY_NOW_KEY);
    } catch (_) {}
  }

  function readCrowdRetryState() {
    try {
      const raw = localStorage.getItem(CROWD_RETRY_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!Number.isFinite(Number(state?.ts))) return null;
      if (Date.now() - Number(state.ts) > 15 * 60 * 1000) return null;
      return {
        ts: Number(state.ts),
        attempts: Math.max(0, parseInt(state.attempts || 0, 10) || 0),
        sourceUrl: String(state.sourceUrl || '')
      };
    } catch (_) {
      return null;
    }
  }

  function markCrowdRetryArmed() {
    try {
      const prev = readCrowdRetryState();
      localStorage.setItem(CROWD_RETRY_KEY, JSON.stringify({
        ts: Date.now(),
        attempts: prev?.attempts || 0,
        sourceUrl: location.href
      }));
    } catch (_) {}
  }

  function clearCrowdRetryFlag() {
    try { localStorage.removeItem(CROWD_RETRY_KEY); } catch (_) {}
  }

  function bumpCrowdRetryAttempt() {
    const prev = readCrowdRetryState();
    const attempts = (prev?.attempts || 0) + 1;
    try {
      localStorage.setItem(CROWD_RETRY_KEY, JSON.stringify({
        ts: Date.now(),
        attempts,
        sourceUrl: prev?.sourceUrl || location.href
      }));
    } catch (_) {}
    return attempts;
  }

  function shouldAutoRunOnTicketPage() {
    try {
      return localStorage.getItem(AUTO_RUN_KEY) === '1' && isTicketSelectionPage();
    } catch (_) {
      return false;
    }
  }

  function shouldAutoSubmitOnCartPage() {
    try {
      return localStorage.getItem(CART_SUBMIT_KEY) === '1' && isInShoppingCartPage();
    } catch (_) {
      return false;
    }
  }

  function shouldAutoPayOnPreviewPage() {
    try {
      return localStorage.getItem(PAY_NOW_KEY) === '1' && isTradePreviewPage();
    } catch (_) {
      return false;
    }
  }

  function isCrowdLimitPage() {
    const txt = getText(document.body);
    if (!txt) return false;
    return /当前購票人數過多|當前購票人數過多|当前购票人数过多|請稍後重試|请稍后重试/.test(txt) &&
      /requestId|刷新|重試|重试|Refresh/i.test(txt);
  }

  function getCrowdRefreshButton() {
    return findByText([
      'button',
      '[role="button"]',
      'a',
      '.button',
      '.btn',
      'div'
    ], /^(刷新|重新整理|重試|重试|Refresh)$/i);
  }

  function shouldAutoHandleCrowdPage() {
    return !!readCrowdRetryState() && isCrowdLimitPage();
  }

  async function handleCrowdLimitPage(token) {
    const attempt = bumpCrowdRetryAttempt();
    if (attempt > CROWD_RETRY_MAX_ATTEMPTS) {
      clearCrowdRetryFlag();
      throw new Error('当前购票人数过多，自动冷却重试次数已达上限，请稍后手动重试');
    }

    const jitter = Math.floor(Math.random() * CROWD_RETRY_JITTER_MS);
    const cooldownMs = Math.min(18000, CROWD_RETRY_BASE_COOLDOWN_MS + attempt * 1200 + jitter);
    const seconds = Math.max(1, Math.ceil(cooldownMs / 1000));
    updateStatus(`当前购票人数过多：冷却 ${seconds}s 后刷新重试`, '#ff9800');

    const waitStart = Date.now();
    while (Date.now() - waitStart < cooldownMs) {
      await ensureNotStopped(token);
      await sleep(250);
    }

    setAutoRunFlag(true);
    const btn = getCrowdRefreshButton();
    if (btn && !isDisabled(btn)) {
      updateStatus('拥挤页：点击刷新重试...', '#17a2b8');
      burstClick(btn, 1);
      return true;
    }

    updateStatus('拥挤页：未找到刷新按钮，尝试重新载入...', '#17a2b8');
    try { location.reload(); } catch (_) {}
    return true;
  }

  function shouldAutoHandleCashierPage() {
    return isCashierPaymentPage();
  }

  async function clickCartSubmitOrder(token, {
    waitButtonMs = 15000,
    burstWindowMs = CLICK_READY_WINDOW_MS
  } = {}) {
    const btn = await waitFor(
      () => {
        const cur = getCartSubmitButton();
        return isCartSubmitReady(cur) ? cur : null;
      },
      token,
      waitButtonMs,
      20,
      '找不到可点击的提交訂單按钮'
    );

    setCartSubmitFlag(false);
    setPayNowFlag(true);
    updateStatus('購物車：点击提交訂單...', '#007bff');

    const clicked = await clickReadyButtonForWindow({
      token,
      getButton: () => getCartSubmitButton() || btn,
      isReady: isCartSubmitReady,
      intervalMs: CART_SUBMIT_INTERVAL_MS,
      burstClicks: CART_SUBMIT_BURST_CLICKS,
      windowMs: burstWindowMs,
      label: '提交訂單'
    });

    if (clicked > 0) {
      updateStatus(`已点击提交訂單 ✅（${clicked}次）`, '#28a745');
      return true;
    }

    throw new Error('提交訂單按钮存在但未能点击');
  }

  async function executePurchaseSequence(token) {
    try {
      setAutoRunFlag(false);
      const target = readTargetsFromPanel();

      updateStatus('等待选择界面出现...', '#ffc107');
      await waitFor(
        () => isTicketSelectionPage(),
        token,
        20000,
        20,
        '等待选择界面超时'
      );

      if (target.sessionPosition !== 1 && isLoadingVisible()) {
        updateStatus('开始前：等待 loading 稳定结束...', '#ffc107');
        await waitLoadingStableGone(token, { stableGoneMs: 140 });
      }

      const s = await stepSelectSession(target.sessionPosition, token);

      if (!s.skipped) {
        updateStatus('等待票价列表刷新...', '#ffc107');
        await waitForPriceWraps(target.pricePosition, token, { timeoutMs: 45000 });
      }

      const p = await stepSelectPrice(target.pricePosition, token, { rushReturn: target.rushReturn });

      await stepSetQuantity(target.quantity, token);

      updateStatus('最终核对 + 等待購買可用...', '#ffc107');
      await waitUntil(() => {
        if (isLoadingVisible()) return false;
        const btn = getFinalBuyButton();
        if (!btn || isDisabled(btn)) return false;

        const curShowId = parseShowIdFromWrap(getSelectedSessionWrap());
        const curTicketId = parseTicketIdFromWrap(getSelectedTicketWrap());
        const curShowText = getText(getSelectedSessionWrap());
        const curTicketText = getText(getSelectedTicketWrap());
        const curQty = getQuantityNumber();

        const okShow = s.targetShowId ? (curShowId === s.targetShowId) : (s.targetSessionText ? curShowText.includes(s.targetSessionText) : true);
        const okTicket = p.targetTicketId ? (curTicketId === p.targetTicketId) : (p.targetTicketText ? curTicketText.includes(p.targetTicketText) : true);
        const okQty = (curQty === null) ? true : (curQty === target.quantity);

        return okShow && okTicket && okQty;
      }, token, 20000, 20, '最终核对未通过/購買不可用（已阻止提交）');

      // --------------------------
      // 最终：狂点購買，但不立刻停止
      // --------------------------
      const clickProfile = getSubmitClickProfile(target, p);
      updateStatus(
        clickProfile.isRushMode
          ? `抢回流中（${clickProfile.intervalMs}ms 间隔点击購買）...`
          : '提交订单中（高速点击購買）...',
        '#007bff'
      );
      clearSubmitInterval();
      setCartSubmitFlag(true);
      markCrowdRetryArmed();

      let clickedAtLeastOnce = false;
      let retry = 0;

      const submitTick = async () => {
        try {
          if (!isRunning || token !== runToken) {
            clearSubmitInterval();
            return;
          }
          if (isLoadingVisible()) return;
          if (isCrowdLimitPage()) {
            clearSubmitInterval();
            await handleCrowdLimitPage(token);
            isRunning = false;
            return;
          }

          // 如果直接进入交易預覽页，先勾选条款再支付。
          if (isTradePreviewPage()) {
            clearSubmitInterval();
            clearCrowdRetryFlag();
            await clickPayNow(token);
            stopMonitoring(true);
            return;
          }

          // 如果已经跳转到购物车页，继续提交訂單并等待交易預覽页。
          if (isInShoppingCartPage()) {
            clearSubmitInterval();
            clearCrowdRetryFlag();
            updateStatus('已进入購物車页：准备提交訂單...', '#28a745');
            await clickCartSubmitOrder(token);
            await maybeHandleTradePreview(token, 30000);
            stopMonitoring(true);
            return;
          }

          const btn = getFinalBuyButton();
          if (btn && !isDisabled(btn)) {
            burstClick(btn, clickProfile.burstClicks);
            clickedAtLeastOnce = true;
          }

          // 点击过至少一次后：改为“等待跳转阶段”而不是马上停
          if (clickedAtLeastOnce) {
            // 让 setInterval 别继续狂点太久：这里做一次异步等待跳转（短时间）
            clearSubmitInterval();
            updateStatus('已点击購買：等待跳转到購物車...', '#17a2b8');

            const nextPage = await waitEnterCartAfterClick(token, {
              waitMs: 12000,
              stableMs: 250,
              pollMs: Math.min(clickProfile.intervalMs, 50),
              keepClickIntervalMs: clickProfile.intervalMs,
              keepClickBurstClicks: clickProfile.burstClicks
            });

            if (nextPage === 'preview') {
              clearCrowdRetryFlag();
              updateStatus('已进入交易預覽页：准备勾选并支付...', '#28a745');
              await clickPayNow(token);
              stopMonitoring(true);
            } else if (nextPage === 'cart') {
              clearCrowdRetryFlag();
              updateStatus('已进入購物車页：准备提交訂單...', '#28a745');
              await clickCartSubmitOrder(token);
              await maybeHandleTradePreview(token, 30000);
              stopMonitoring(true);
            } else if (nextPage === 'crowd') {
              updateStatus('进入拥挤页：冷却后刷新重试...', '#ff9800');
              await handleCrowdLimitPage(token);
              isRunning = false;
            } else {
              // 没跳转成功：回到狂点（但给出提示）
              updateStatus(clickProfile.isRushMode ? '未进入購物車：继续按回流间隔点击購買...' : '未进入購物車：继续高速点击購買...', '#ff9800');
              // 重新启动狂点 interval
              retry = 0;
              clickedAtLeastOnce = false;
              submitIntervalId = setInterval(submitTick, clickProfile.intervalMs);
            }
            return;
          }

          if (retry++ > 2500) {
            clearSubmitInterval();
            setCartSubmitFlag(false);
            updateStatus('超时：请手动点击', '#dc3545');
          }
        } catch (e) {
          clearSubmitInterval();
          if (String(e?.message || '') === '已停止') updateStatus('已停止', '#6c757d');
          else updateStatus(`出错: ${e.message || e}`, '#dc3545');
          stopMonitoring(true);
        }
      };

      submitIntervalId = setInterval(submitTick, clickProfile.intervalMs);
      submitTick();

    } catch (e) {
      console.error('UUTIX 脚本错误:', e);
      if (String(e?.message || '') === '已停止') updateStatus('已停止', '#6c757d');
      else updateStatus(`出错: ${e.message || e}`, '#dc3545');
      stopMonitoring(true);
    }
  }

  // --------------------------
  // 开始/停止
  // --------------------------
  function startMonitoring() {
    if (isRunning) return;

    runToken++;
    const token = runToken;
    isRunning = true;
    const startedOnCashierPage = isCashierPaymentPage();
    const startedOnPreviewPage = isTradePreviewPage();
    const startedOnCartPage = isInShoppingCartPage();
    const startedOnTicketPage = isTicketSelectionPage();
    const startedOnCrowdPage = isCrowdLimitPage();
    const existingPaymentHandoff = readPaymentHandoff();
    const currentTargets = readTargetsFromPanel();
    if (startedOnCashierPage && existingPaymentHandoff) {
      currentTargets.paymentMethod = normalizePaymentMethod(existingPaymentHandoff.paymentMethod);
    }
    saveTargetsToStorage(currentTargets);
    setStoredPaymentMethod(currentTargets.paymentMethod);
    if (!startedOnCashierPage || !existingPaymentHandoff) {
      writePaymentHandoff(getPaymentSettingsForHandoff());
    }
    setAutoRunFlag(!startedOnTicketPage && !startedOnCartPage && !startedOnPreviewPage && !startedOnCashierPage && !startedOnCrowdPage);
    setCartSubmitFlag(startedOnCartPage);
    setPayNowFlag(startedOnPreviewPage);

    (async () => {
      try {
        if (startedOnCrowdPage) {
          updateStatus('检测到购票拥挤页：准备冷却刷新...', '#ff9800');
          await handleCrowdLimitPage(token);
          isRunning = false;
          return;
        }

        if (startedOnCashierPage) {
          updateStatus('已在支付页：选择支付方式并确认...', '#17a2b8');
          await handleCashierPayment(token);
          stopMonitoring(true);
          return;
        }

        if (startedOnPreviewPage) {
          updateStatus('已在交易預覽页：勾选条款并点击立即支付...', '#17a2b8');
          await clickPayNow(token);
          stopMonitoring(true);
          return;
        }

        if (startedOnCartPage) {
          updateStatus('已在購物車页：直接提交訂單...', '#17a2b8');
          await clickCartSubmitOrder(token);
          await maybeHandleTradePreview(token, 30000);
          stopMonitoring(true);
          return;
        }

        if (startedOnTicketPage) {
          updateStatus('已在购票流程页：直接执行选择流程...', '#17a2b8');
          await executePurchaseSequence(token);
          return;
        }

        updateStatus('等待入口按钮变为购买状态...', '#17a2b8');
        await waitEntryBecomeBuyAndClick(token);
        await executePurchaseSequence(token);
      } catch (e) {
        if (String(e?.message || '') === '已停止') updateStatus('已停止', '#6c757d');
        else updateStatus(`出错: ${e.message || e}`, '#dc3545');
        stopMonitoring(true);
      }
    })();
  }

  function stopMonitoring(keepStatus) {
    clearSubmitInterval();
    clearEntryObserver();
    clearEntryClockMonitor();
    setAutoRunFlag(false);
    setCartSubmitFlag(false);
    setPayNowFlag(false);
    setCashierAutoFlag(false);
    clearCrowdRetryFlag();

    runToken++; // 中断 await
    isRunning = false;

    const status = document.getElementById('status-display');
    if (!keepStatus && status && !status.textContent.includes('完成')) {
      updateStatus('已停止', '#6c757d');
    }
  }

  // --------------------------
  // 面板
  // --------------------------
  function getSavedPanelPosition() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (!Number.isFinite(pos?.left) || !Number.isFinite(pos?.top)) return null;
      return pos;
    } catch (_) {
      return null;
    }
  }

  function savePanelPosition(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (_) {}
  }

  function clampPanelPoint(panel, left, top) {
    const margin = 8;
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function applySavedPanelPosition(panel) {
    const pos = getSavedPanelPosition();
    if (!pos) return;
    const clamped = clampPanelPoint(panel, pos.left, pos.top);
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function setPanelHidden(panel, dock, hidden, persist = true) {
    panel.style.display = hidden ? 'none' : 'flex';
    dock.style.display = hidden ? 'block' : 'none';
    if (persist) {
      try { localStorage.setItem(PANEL_HIDDEN_KEY, hidden ? '1' : '0'); } catch (_) {}
    }
  }

  function setupPanelDrag(panel, handle) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      if (!moved) return;

      const clamped = clampPanelPoint(panel, startLeft + dx, startTop + dy);
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      e.preventDefault();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      if (moved) savePanelPosition(panel);
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, input, select, textarea, a')) return;

      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      moved = false;

      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      e.preventDefault();
    });

    window.addEventListener('resize', () => {
      if (panel.style.display === 'none') return;
      const rect = panel.getBoundingClientRect();
      const clamped = clampPanelPoint(panel, rect.left, rect.top);
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      savePanelPosition(panel);
    });
  }

  function toggleCardFields() {
    const select = document.getElementById('payment-method');
    const fields = document.getElementById('uutix-card-fields');
    if (!fields) return;
    fields.style.display = isCardPaymentMethod(select?.value) ? 'flex' : 'none';
  }

  function setRushReturnToggle(enabled, shouldSave = true) {
    const btn = document.getElementById('rush-return-toggle');
    if (!btn) return;
    btn.dataset.enabled = enabled ? '1' : '0';
    btn.textContent = enabled ? '抢回流：开' : '抢回流：关';
    btn.style.background = enabled ? '#ff9800' : '#6c757d';
    btn.style.color = '#fff';
    if (shouldSave) saveTargetsToStorage(readTargetsFromPanel());
  }

  function scheduleAutoStart(status, color, readyFn, {
    delayMs = 0,
    fallbackMs = AUTO_START_FALLBACK_MS
  } = {}) {
    updateStatus(status, color);

    let started = false;
    let observer = null;
    let fallbackTimer = null;

    const cleanup = () => {
      if (observer) {
        try { observer.disconnect(); } catch (_) {}
        observer = null;
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const start = () => {
      if (started || isRunning) return;
      started = true;
      cleanup();
      setTimeout(() => {
        if (!isRunning) startMonitoring();
      }, delayMs);
    };

    const tryStart = () => {
      if (started || isRunning) return true;
      let ready = false;
      try { ready = !readyFn || !!readyFn(); } catch (_) { ready = false; }
      if (ready) start();
      return ready;
    };

    if (tryStart()) return;

    try {
      observer = new MutationObserver(() => { tryStart(); });
      observer.observe(document.documentElement || document.body, {
        subtree: true,
        childList: true,
        attributes: true
      });
    } catch (_) {}

    fallbackTimer = setTimeout(start, fallbackMs);
  }

  function createControlPanel() {
    if (document.getElementById('uutix-helper-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'uutix-helper-panel';
    panel.innerHTML = `
      <div id="uutix-helper-header">
        <div id="uutix-helper-title">UUTIX v18</div>
        <button id="uutix-helper-hide" type="button">隐藏</button>
      </div>

      <div class="uutix-row">
        <span style="font-size:13px;">场次位置:</span>
        <input class="uutix-control" type="number" id="session-position" value="1" min="1">
      </div>

      <div class="uutix-row">
        <span style="font-size:13px;">票价位置:</span>
        <input class="uutix-control" type="number" id="price-position" value="1" min="1">
      </div>

      <div class="uutix-row">
        <span style="font-size:13px;">目标数量:</span>
        <input class="uutix-control" type="number" id="ticket-quantity" value="1" min="1">
      </div>

      <div class="uutix-row">
        <span style="font-size:13px;">支付方式:</span>
        <select class="uutix-control" id="payment-method">
          <option value="wechat">微信支付</option>
          <option value="alipayhk">AlipayHK</option>
          <option value="visa">VISA卡</option>
          <option value="mastercard">萬事達卡</option>
          <option value="amex">美國運通卡</option>
          <option value="unionpay">銀聯支付</option>
        </select>
      </div>

      <details class="uutix-details">
        <summary>高级设置 / 抢回流</summary>
        <div class="uutix-row">
          <span style="font-size:13px;">是否抢回流:</span>
          <button class="uutix-control" id="rush-return-toggle" type="button" data-enabled="0" style="background:#6c757d; color:#fff;">抢回流：关</button>
        </div>

        <div class="uutix-row">
          <span style="font-size:13px;">回流间隔(ms):</span>
          <input class="uutix-control" type="number" id="rush-return-interval" value="${RUSH_RETURN_INTERVAL_DEFAULT_MS}" min="${RUSH_RETURN_INTERVAL_MIN_MS}" max="${RUSH_RETURN_INTERVAL_MAX_MS}" step="10">
        </div>
      </details>

      <div id="uutix-card-fields">
        <div class="uutix-row">
          <span>持卡人:</span>
          <input type="text" id="card-holder" autocomplete="off" placeholder="Name on card">
        </div>
        <div class="uutix-row">
          <span>卡号:</span>
          <input type="password" id="card-number" autocomplete="off" inputmode="numeric" placeholder="不保存">
        </div>
        <div class="uutix-row">
          <span>有效期:</span>
          <input type="text" id="card-expiry" autocomplete="off" inputmode="numeric" placeholder="MM/YY">
        </div>
        <div class="uutix-row">
          <span>CVV:</span>
          <input type="password" id="card-cvv" autocomplete="off" inputmode="numeric" placeholder="不保存">
        </div>
        <div id="uutix-card-privacy">卡号、CVV、有效期、持卡人不会写入 localStorage，也不会被脚本长期保存；仅在当前标签页临时传递给支付页，读取后清除。</div>
      </div>

      <div class="uutix-actions">
        <button id="start-btn" style="flex:1; background:#28a745; color:#fff;">开始</button>
        <button id="stop-btn" style="flex:1; background:#dc3545; color:#fff;">停止</button>
      </div>

      <div id="status-display">状态: 准备就绪</div>

      <details class="uutix-details">
        <summary>时钟校准</summary>
        <div id="clock-display">时钟: 等待进入详情页校准</div>
        <button id="calibrate-clock-btn">手动校准时钟</button>
      </details>
    `;

    const dock = document.createElement('div');
    dock.id = 'uutix-helper-dock';
    dock.textContent = 'UUTIX';

    document.body.appendChild(panel);
    document.body.appendChild(dock);

    applySavedPanelPosition(panel);
    loadTargetsIntoPanel();
    toggleCardFields();

    document.getElementById('start-btn').onclick = startMonitoring;
    document.getElementById('stop-btn').onclick = () => stopMonitoring(false);
    document.getElementById('calibrate-clock-btn').onclick = () => refreshDetailClockDisplay({ force: true });
    document.getElementById('uutix-helper-hide').onclick = () => setPanelHidden(panel, dock, true);
    document.getElementById('rush-return-toggle').onclick = () => {
      const enabled = document.getElementById('rush-return-toggle')?.dataset?.enabled === '1';
      setRushReturnToggle(!enabled, true);
    };
    document.getElementById('rush-return-interval').onchange = () => {
      const input = document.getElementById('rush-return-interval');
      if (input) input.value = String(normalizeRushReturnIntervalMs(input.value));
      saveTargetsToStorage(readTargetsFromPanel());
    };
    document.getElementById('payment-method').onchange = () => {
      toggleCardFields();
      saveTargetsToStorage(readTargetsFromPanel());
    };
    dock.onclick = () => setPanelHidden(panel, dock, false);

    setupPanelDrag(panel, document.getElementById('uutix-helper-header'));

    const isHidden = (() => {
      try { return localStorage.getItem(PANEL_HIDDEN_KEY) === '1'; } catch (_) { return false; }
    })();
    setPanelHidden(panel, dock, isHidden, false);

    if (/\/detail/i.test(location.pathname) && getUrlParamValue(['pId', 'projectId'])) {
      setTimeout(() => refreshDetailClockDisplay({ force: true }), 300);
    }

    if (shouldAutoHandleCrowdPage()) {
      scheduleAutoStart(
        '检测到购票拥挤页：冷却后自动刷新...',
        '#ff9800',
        () => isCrowdLimitPage()
      );
    } else if (shouldAutoHandleCashierPage()) {
      scheduleAutoStart(
        '检测到支付页：自动选择支付方式并确认...',
        '#17a2b8',
        () => getCashierPaymentItems().length > 0 || !!getCashierConfirmButton(),
        { delayMs: CASHIER_AUTO_START_DELAY_MS }
      );
    } else if (shouldAutoPayOnPreviewPage()) {
      scheduleAutoStart(
        '检测到交易預覽页：自动勾选并点击立即支付...',
        '#17a2b8',
        () => isTradePreviewPage()
      );
    } else if (shouldAutoSubmitOnCartPage()) {
      scheduleAutoStart(
        '检测到購物車页：自动提交訂單...',
        '#17a2b8',
        () => isInShoppingCartPage()
      );
    } else if (shouldAutoRunOnTicketPage()) {
      scheduleAutoStart(
        '检测到详情页跳转：自动继续购票流程...',
        '#17a2b8',
        () => isTicketSelectionPage()
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createControlPanel, { once: true });
  } else {
    createControlPanel();
  }
})();
