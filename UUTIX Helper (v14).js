// ==UserScript==
// @name         UUTIX Helper (v14)
// @namespace    http://tampermonkey.net/
// @version      2026-06-23.14
// @description  分步复查：适配新版 detail/ticket/cart DOM；等待票价列表稳定；入口按钮监听“已订阅→购买”后点击；场次/票价/数量每步确认；进入購物車后自动提交訂單。
// @author       yuuuiv
// @license      MIT
// @match        https://www.uutix.com/detail?pId=*
// @match        https://www.uutix.com/ticket?pId=*
// @match        https://www.uutix.com/shopping-cart*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=uutix.com
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  let submitIntervalId = null;
  let entryObserver = null;

  let isRunning = false;
  let runToken = 0;

  const PANEL_POS_KEY = 'uutix-helper-panel-position';
  const PANEL_HIDDEN_KEY = 'uutix-helper-panel-hidden';
  const AUTO_RUN_KEY = 'uutix-helper-auto-run-ticket';
  const TARGETS_KEY = 'uutix-helper-last-targets';
  const CART_SUBMIT_KEY = 'uutix-helper-auto-submit-cart';
  const ENTRY_CLICK_INTERVAL_MS = 35;
  const SUBMIT_CLICK_INTERVAL_MS = 12;
  const SUBMIT_BURST_CLICKS = 4;
  const CART_SUBMIT_INTERVAL_MS = 25;
  const CART_SUBMIT_BURST_CLICKS = 1;

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
      display:flex; flex-direction:column; gap:12px; width:360px; box-sizing:border-box;
    }
    #uutix-helper-panel button{ cursor:pointer; padding:8px; border-radius:6px; border:none; font-weight:bold; }
    #uutix-helper-panel label, #uutix-helper-panel span, #uutix-helper-panel div{ box-sizing:border-box; font-family:sans-serif; }
    #uutix-helper-header{ display:flex; align-items:center; justify-content:space-between; cursor:move; user-select:none; }
    #uutix-helper-title{ font-weight:bold; font-size:16px; line-height:24px; }
    #uutix-helper-hide{ width:52px; background:#6c757d; color:#fff; padding:6px 8px !important; font-size:12px; }
    #uutix-helper-dock{
      all: initial; position:fixed; right:18px; bottom:128px; z-index:99999;
      background:#007bff; color:#fff; border-radius:999px; padding:8px 12px;
      font:700 13px sans-serif; box-shadow:0 3px 10px rgba(0,0,0,.2);
      cursor:pointer; display:none; user-select:none;
    }
    #status-display{ font-size:13px; padding:8px; text-align:center; border-radius:8px; background:#f5f5f5; }
    #uutix-helper-panel input{ font-size:13px; padding:2px 6px; border-radius:4px; outline:none; }
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
      await sleep(intervalMs);
    }
  }

  async function waitUntil(condFn, token, timeoutMs = 8000, intervalMs = 20, errMsg = '等待条件超时') {
    const t0 = Date.now();
    while (true) {
      await ensureNotStopped(token);
      if (condFn()) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(errMsg);
      await sleep(intervalMs);
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
    stableGoneMs = 350
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

  function burstClick(element, times = 1) {
    if (!element) return 0;
    let clicked = 0;
    for (let i = 0; i < times; i++) {
      if (isDisabled(element)) break;
      element.click();
      clicked++;
    }
    return clicked;
  }

  async function waitCondStable(condFn, token, stableMs = 120, timeoutMs = 3500, pollMs = 16, errMsg = '状态稳定确认超时') {
    const t0 = Date.now();
    let okStart = null;

    while (true) {
      await ensureNotStopped(token);

      if (isLoadingVisible()) {
        okStart = null;
        await sleep(pollMs);
        continue;
      }

      if (condFn()) {
        if (okStart == null) okStart = Date.now();
        if (Date.now() - okStart >= stableMs) return true;
      } else {
        okStart = null;
      }

      if (Date.now() - t0 > timeoutMs) throw new Error(errMsg);
      await sleep(pollMs);
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
        await sleep(pollMs);
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

      await sleep(pollMs);
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
    // 1) URL 判断（最稳，最快）
    if (/\/shopping-cart/i.test(location.pathname) || /shopping-cart/i.test(location.href)) return true;

    // 2) DOM 标志（来自你给的購物車.html结构）
    // title: 購物車 / page wrapper: .shopping-carts-wrapper / step section: .step-section
    const title = document.title || '';
    if (title.includes('購物車') || title.includes('购物车')) return true;
    if (document.querySelector('.shopping-carts-wrapper')) return true;
    if (document.querySelector('.step-section')) return true;

    return false;
  }

  async function waitEnterCartAfterClick(token, {
    waitMs = 12000,        // 最多等 12s
    stableMs = 250,        // 连续满足 250ms 才算真正进入
    pollMs = 25,
    keepClickIntervalMs = 120 // 等待期间每隔 120ms 补点一次（比狂点轻很多）
  } = {}) {
    const t0 = Date.now();
    let okStart = null;
    let lastKeepClick = 0;

    while (true) {
      await ensureNotStopped(token);

      // 如果已经跳到购物车，稳定确认
      if (isInShoppingCartPage()) {
        if (okStart == null) okStart = Date.now();
        if (Date.now() - okStart >= stableMs) return true;
      } else {
        okStart = null;
      }

      // 等待期间：如果还在 detail 页且按钮还能点，就间歇补点
      // （避免“点了但没触发路由/请求”这种偶发）
      if (!isInShoppingCartPage() && !isLoadingVisible()) {
        const now = Date.now();
        if (now - lastKeepClick >= keepClickIntervalMs) {
          const btn = getFinalBuyButton();
          if (btn && !isDisabled(btn)) burstClick(btn, Math.max(1, Math.min(2, SUBMIT_BURST_CLICKS)));
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

  let clickTimer = null;

  function hasEnteredNextStep() {
    return isTicketSelectionPage();
  }

  function startClicking() {
    if (clickTimer) return;

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
        await waitLoadingStableGone(token, { stableGoneMs: 320 });
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
        }, token, 120, 3500, 16, '场次稳定确认超时');
      },
      { maxRetry: 60, betweenMs: 35 }
    );

    return { targetShowId, targetSessionText, skipped: false };
  }

  // --------------------------
  // Step 2：票价
  // --------------------------
  async function stepSelectPrice(pricePosition, token) {
    let targetTicketId = null;
    let targetTicketText = '';

    await retryStep(
      `选择票价#${pricePosition}`,
      token,
      async () => {
        const { wraps } = await waitForPriceWraps(pricePosition, token);

        const targetWrap = wraps[pricePosition - 1];
        if (!targetWrap) throw new Error(`无效票价位置：${pricePosition}（当前只有 ${wraps.length} 个票价）`);

        const item = targetWrap.querySelector('.item') || targetWrap;
        if (!item) throw new Error('票价项结构异常');

        if (isTicketUnavailable(targetWrap)) {
          const stateText = getTicketStateText(targetWrap) || getText(targetWrap) || '未知状态';
          throw new Error(`目标票价#${pricePosition} 不可购买：${stateText}`);
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
        }, token, 110, 3200, 16, '票价稳定确认超时');
      },
      { maxRetry: 80, betweenMs: 25 }
    );

    return { targetTicketId, targetTicketText };
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
      }, token, 80, 2000, 20, '数量=1 确认超时');
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
        }, token, 100, 3200, 16, '数量稳定确认超时');
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
    return { sessionPosition, pricePosition, quantity };
  }

  function saveTargetsToStorage(targets) {
    try {
      localStorage.setItem(TARGETS_KEY, JSON.stringify(targets));
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
    } catch (_) {}
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

  async function clickCartSubmitOrder(token, {
    waitButtonMs = 15000,
    burstWindowMs = 160
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
    updateStatus('購物車：点击提交訂單...', '#007bff');

    let clicked = 0;
    const firstClickAt = Date.now();

    while (Date.now() - firstClickAt <= burstWindowMs) {
      await ensureNotStopped(token);
      if (isLoadingVisible()) {
        await sleep(CART_SUBMIT_INTERVAL_MS);
        continue;
      }

      const cur = getCartSubmitButton() || btn;
      if (!isCartSubmitReady(cur)) {
        if (clicked > 0) break;
        await sleep(CART_SUBMIT_INTERVAL_MS);
        continue;
      }

      clicked += burstClick(cur, CART_SUBMIT_BURST_CLICKS);
      await sleep(CART_SUBMIT_INTERVAL_MS);
    }

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
        await waitLoadingStableGone(token, { stableGoneMs: 280 });
      }

      const s = await stepSelectSession(target.sessionPosition, token);

      if (!s.skipped) {
        updateStatus('等待票价列表刷新...', '#ffc107');
        await waitForPriceWraps(target.pricePosition, token, { timeoutMs: 45000 });
      }

      const p = await stepSelectPrice(target.pricePosition, token);

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
      updateStatus('提交订单中（高速点击購買）...', '#007bff');
      clearSubmitInterval();
      setCartSubmitFlag(true);

      let clickedAtLeastOnce = false;
      let retry = 0;

      const submitTick = async () => {
        try {
          if (!isRunning || token !== runToken) {
            clearSubmitInterval();
            return;
          }
          if (isLoadingVisible()) return;

          // 如果已经跳转到购物车页，结束
          if (isInShoppingCartPage()) {
            clearSubmitInterval();
            updateStatus('已进入購物車页：准备提交訂單...', '#28a745');
            await clickCartSubmitOrder(token);
            stopMonitoring(true);
            return;
          }

          const btn = getFinalBuyButton();
          if (btn && !isDisabled(btn)) {
            burstClick(btn, SUBMIT_BURST_CLICKS);
            clickedAtLeastOnce = true;
          }

          // 点击过至少一次后：改为“等待跳转阶段”而不是马上停
          if (clickedAtLeastOnce) {
            // 让 setInterval 别继续狂点太久：这里做一次异步等待跳转（短时间）
            clearSubmitInterval();
            updateStatus('已点击購買：等待跳转到購物車...', '#17a2b8');

            const ok = await waitEnterCartAfterClick(token, {
              waitMs: 12000,
              stableMs: 250,
              pollMs: 25,
              keepClickIntervalMs: 25
            });

            if (ok) {
              updateStatus('已进入購物車页：准备提交訂單...', '#28a745');
              await clickCartSubmitOrder(token);
              stopMonitoring(true);
            } else {
              // 没跳转成功：回到狂点（但给出提示）
              updateStatus('未进入購物車：继续高速点击購買...', '#ff9800');
              // 重新启动狂点 interval
              retry = 0;
              clickedAtLeastOnce = false;
              submitIntervalId = setInterval(submitTick, SUBMIT_CLICK_INTERVAL_MS);
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

      submitIntervalId = setInterval(submitTick, SUBMIT_CLICK_INTERVAL_MS);
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
    const startedOnCartPage = isInShoppingCartPage();
    const startedOnTicketPage = isTicketSelectionPage();
    saveTargetsToStorage(readTargetsFromPanel());
    setAutoRunFlag(!startedOnTicketPage && !startedOnCartPage);
    setCartSubmitFlag(startedOnCartPage);

    (async () => {
      try {
        if (startedOnCartPage) {
          updateStatus('已在購物車页：直接提交訂單...', '#17a2b8');
          await clickCartSubmitOrder(token);
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
    setAutoRunFlag(false);
    setCartSubmitFlag(false);

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

  function createControlPanel() {
    if (document.getElementById('uutix-helper-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'uutix-helper-panel';
    panel.innerHTML = `
      <div id="uutix-helper-header">
        <div id="uutix-helper-title">UUTIX v14</div>
        <button id="uutix-helper-hide" type="button">隐藏</button>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px;">场次位置:</span>
        <input type="number" id="session-position" value="1" min="1" style="width:140px; border:1px solid #ccc;">
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px;">票价位置:</span>
        <input type="number" id="price-position" value="1" min="1" style="width:140px; border:1px solid #ccc;">
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px;">目标数量:</span>
        <input type="number" id="ticket-quantity" value="1" min="1" style="width:140px; border:1px solid #ccc;">
      </div>

      <div style="display:flex; gap:10px;">
        <button id="start-btn" style="flex:1; background:#28a745; color:#fff;">开始</button>
        <button id="stop-btn" style="flex:1; background:#dc3545; color:#fff;">停止</button>
      </div>

      <div id="status-display">状态: 准备就绪</div>
    `;

    const dock = document.createElement('div');
    dock.id = 'uutix-helper-dock';
    dock.textContent = 'UUTIX';

    document.body.appendChild(panel);
    document.body.appendChild(dock);

    applySavedPanelPosition(panel);
    loadTargetsIntoPanel();

    document.getElementById('start-btn').onclick = startMonitoring;
    document.getElementById('stop-btn').onclick = () => stopMonitoring(false);
    document.getElementById('uutix-helper-hide').onclick = () => setPanelHidden(panel, dock, true);
    dock.onclick = () => setPanelHidden(panel, dock, false);

    setupPanelDrag(panel, document.getElementById('uutix-helper-header'));

    const isHidden = (() => {
      try { return localStorage.getItem(PANEL_HIDDEN_KEY) === '1'; } catch (_) { return false; }
    })();
    setPanelHidden(panel, dock, isHidden, false);

    if (shouldAutoSubmitOnCartPage()) {
      updateStatus('检测到購物車页：自动提交訂單...', '#17a2b8');
      setTimeout(() => {
        if (!isRunning) startMonitoring();
      }, 180);
    } else if (shouldAutoRunOnTicketPage()) {
      updateStatus('检测到详情页跳转：自动继续购票流程...', '#17a2b8');
      setTimeout(() => {
        if (!isRunning) startMonitoring();
      }, 250);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createControlPanel, { once: true });
  } else {
    createControlPanel();
  }
})();
