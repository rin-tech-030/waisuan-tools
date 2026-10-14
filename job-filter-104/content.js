// 職缺過濾器（適用 104）— content script
// 只在 https://www.104.com.tw/jobs/search/* 執行。不發送任何網路請求、不使用 eval / innerHTML。
//
// 104 搜尋結果是虛擬捲動（vue-recycle-scroller）：同一批節點會被重複使用並換內容，
// 所以這裡「不用 display:none 藏卡片」，而是：
//   1. 每次 DOM 變動後，重新讀取每張卡片「目前」的公司與標題；
//   2. 依結果把卡片標成 data-jf104="ok|hidden|revealed|showall"；
//   3. hidden 狀態由 content.css 把內文收合成一行「已隱藏：…」，不移除節點、不影響定位。
(() => {
  'use strict';

  if (window.__jf104Loaded) return;
  window.__jf104Loaded = true;

  // ───────── 所有選擇器集中在這裡；104 改版時只需改這個物件 ─────────
  const SELECTORS = {
    // 職缺卡片（手機版 .job-mobile；桌機版為推測，未實測）
    card: ['.job-mobile', 'article.job-list-item', '.job-list-item'],
    // 找不到上面任何一種卡片時的最後備援
    cardFallback: '[data-job-no]',
    // 職缺編號（可能在卡片本身或其子孫）
    jobNo: '[data-job-no]',
    // 標題（依序嘗試）
    title: [
      'a.info-job .info-name',
      '.info-job .info-name',
      '[data-gtm-joblist="職缺-職缺名稱"]',
      'a.info-job',
      'a[href*="/job/"]'
    ],
    // 公司連結（依序嘗試；公司 ID 取自網址 /company/<id>）
    company: [
      '.info-company a[href*="/company/"]',
      'a[href*="/company/"]',
      '[data-gtm-joblist="職缺-公司名稱"]'
    ]
  };

  const COMPANY_ID_RE = /\/company\/([A-Za-z0-9_-]+)/;
  const ATTR = 'data-jf104';
  const LABEL_ATTR = 'data-jf104-label';
  const BTN_CLASS = 'jf104-btn';
  const MIN_INTERVAL_MS = 80;

  // ───────── 狀態（content script 隨頁面存在，不需要跨重啟保存） ─────────
  let companyIds = new Set();
  let companyNamesNoId = new Set(); // 只有名稱、沒有 ID 的黑名單項目
  let keywords = []; // 已轉小寫
  let showAll = false; // 暫時顯示全部（只在本頁有效，重新整理即還原）
  const revealed = new Set(); // 個別暫時顯示的職缺
  const matchedSeen = new Map(); // jobKey -> 是否命中黑名單（用來統計捲過的卡片）
  let pageKey = location.pathname + location.search;
  let scheduled = false;
  let lastRun = 0;

  // ───────── 小工具 ─────────
  const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const norm = (s) => clean(s).normalize('NFKC').toLowerCase();

  function firstMatch(root, selectors) {
    for (const sel of selectors) {
      let el = null;
      try {
        el = root.querySelector(sel);
      } catch (e) {
        el = null;
      }
      if (el) return el;
    }
    return null;
  }

  function collectCards() {
    let list = Array.from(document.querySelectorAll(SELECTORS.card.join(',')));
    if (!list.length) list = Array.from(document.querySelectorAll(SELECTORS.cardFallback));
    // 只保留最外層，避免巢狀重複
    return list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  }

  function readCard(card) {
    const noEl = card.matches(SELECTORS.jobNo) ? card : card.querySelector(SELECTORS.jobNo);
    const jobNo = noEl ? clean(noEl.getAttribute('data-job-no')) : '';

    const titleEl = firstMatch(card, SELECTORS.title);
    const title = titleEl ? clean(titleEl.textContent) : '';

    let companyId = '';
    let companyName = '';
    for (const sel of SELECTORS.company) {
      let el = null;
      try {
        el = card.querySelector(sel);
      } catch (e) {
        el = null;
      }
      if (!el) continue;
      const a = el.matches('a') ? el : el.closest('a') || el.querySelector('a');
      const href = a ? a.getAttribute('href') || '' : '';
      const m = COMPANY_ID_RE.exec(href);
      if (m && !companyId) companyId = m[1];
      const name = clean(el.textContent);
      if (name && !companyName) companyName = name;
      if (companyId && companyName) break;
    }
    return { jobNo, title, companyId, companyName };
  }

  function jobKey(info) {
    return info.jobNo || `${info.companyId}|${info.title}`;
  }

  function evaluate(info) {
    if (info.companyId && companyIds.has(info.companyId)) {
      return { kind: 'company', text: info.companyName || info.companyId };
    }
    if (!info.companyId && info.companyName && companyNamesNoId.has(info.companyName)) {
      return { kind: 'company', text: info.companyName };
    }
    if (info.title) {
      const t = norm(info.title);
      for (const kw of keywords) {
        if (kw && t.includes(kw)) return { kind: 'keyword', text: kw };
      }
    }
    return null;
  }

  // ───────── 設定載入 ─────────
  function applySettings(raw) {
    const companies = Array.isArray(raw && raw.companies) ? raw.companies : [];
    const kws = Array.isArray(raw && raw.keywords) ? raw.keywords : [];
    companyIds = new Set();
    companyNamesNoId = new Set();
    for (const c of companies) {
      if (!c || typeof c !== 'object') continue;
      const id = typeof c.id === 'string' ? c.id.trim() : '';
      const name = typeof c.name === 'string' ? clean(c.name) : '';
      if (id) companyIds.add(id);
      else if (name) companyNamesNoId.add(name);
    }
    keywords = kws.filter((k) => typeof k === 'string').map(norm).filter(Boolean);
    matchedSeen.clear();
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get({ companies: [], keywords: [] });
      applySettings(data);
    } catch (e) {
      console.error('[職缺過濾器] 讀取設定失敗', e);
    }
  }

  async function addCompanyToBlacklist(info) {
    if (!info.companyId && !info.companyName) return;
    try {
      const data = await chrome.storage.local.get({ companies: [] });
      const list = Array.isArray(data.companies) ? data.companies : [];
      const exists = list.some((c) =>
        info.companyId ? c && c.id === info.companyId : c && !c.id && c.name === info.companyName
      );
      if (!exists) {
        list.push({ id: info.companyId, name: info.companyName || info.companyId });
        await chrome.storage.local.set({ companies: list });
      }
    } catch (e) {
      console.error('[職缺過濾器] 儲存失敗', e);
    }
  }

  // ───────── 套用到卡片 ─────────
  function ensureButton(card) {
    let btn = null;
    for (const child of card.children) {
      if (child.classList && child.classList.contains(BTN_CLASS)) {
        btn = child;
        break;
      }
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN_CLASS;
      card.appendChild(btn);
    }
    return btn;
  }

  function removeButton(card) {
    for (const child of Array.from(card.children)) {
      if (child.classList && child.classList.contains(BTN_CLASS)) child.remove();
    }
  }

  function setButton(btn, action, text, hint) {
    if (btn.dataset.action !== action) btn.dataset.action = action;
    if (btn.textContent !== text) btn.textContent = text;
    btn.title = hint;
    btn.setAttribute('aria-label', hint);
  }

  function clearCard(card) {
    card.removeAttribute(ATTR);
    card.removeAttribute(LABEL_ATTR);
    removeButton(card);
  }

  function applyToCard(card) {
    const info = readCard(card);

    // 內容尚未渲染（或剛被回收、還沒換新內容）
    if (!info.title && !info.companyName && !info.companyId) {
      clearCard(card);
      return;
    }

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

    const key = jobKey(info);
    const reason = evaluate(info);
    matchedSeen.set(key, !!reason);

    const btn = ensureButton(card);
    const who = info.companyName || info.companyId;

    if (!reason) {
      card.setAttribute(ATTR, 'ok');
      card.removeAttribute(LABEL_ATTR);
      if (who) {
        setButton(btn, 'hide', '隱藏這家公司', `把「${who}」加入黑名單`);
        btn.hidden = false;
      } else {
        btn.hidden = true;
      }
      return;
    }

    const label =
      reason.kind === 'company'
        ? `已隱藏：${reason.text}`
        : `已隱藏：標題含「${reason.text}」`;

    if (showAll) {
      card.setAttribute(ATTR, 'showall');
      card.removeAttribute(LABEL_ATTR);
      btn.hidden = true;
    } else if (revealed.has(key)) {
      card.setAttribute(ATTR, 'revealed');
      card.removeAttribute(LABEL_ATTR);
      setButton(btn, 'rehide', '重新隱藏', '再次隱藏這筆職缺');
      btn.hidden = false;
    } else {
      card.setAttribute(ATTR, 'hidden');
      if (card.getAttribute(LABEL_ATTR) !== label) card.setAttribute(LABEL_ATTR, label);
      setButton(btn, 'show', '顯示', '暫時顯示這筆職缺');
      btn.hidden = false;
    }
  }

  function processNow() {
    scheduled = false;
    lastRun = Date.now();

    const key = location.pathname + location.search;
    if (key !== pageKey) {
      // 換頁／換搜尋條件：清掉暫時狀態
      pageKey = key;
      revealed.clear();
      matchedSeen.clear();
      showAll = false;
    }

    // 暫停監聽，避免我們自己的修改觸發無限迴圈
    observer.disconnect();
    try {
      for (const card of collectCards()) {
        try {
          applyToCard(card);
        } catch (e) {
          console.error('[職缺過濾器] 處理卡片失敗', e);
        }
      }
    } finally {
      startObserving();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRun));
    setTimeout(() => requestAnimationFrame(processNow), wait);
  }

  // ───────── 監聽 DOM 變動（含虛擬捲動換內容） ─────────
  const observer = new MutationObserver(schedule);

  function startObserving() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'data-job-no', 'data-gtm-joblist', 'style', 'class']
    });
  }

  // ───────── 卡片上的按鈕（事件委派；點擊當下才重新讀取卡片，因為節點會被重複使用） ─────────
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest('.' + BTN_CLASS);
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const card = btn.parentElement;
      if (!card) return;
      const info = readCard(card);
      const key = jobKey(info);
      const action = btn.dataset.action;
      if (action === 'hide') {
        addCompanyToBlacklist(info); // storage.onChanged 會觸發重新套用
      } else if (action === 'show') {
        revealed.add(key);
        processNow();
      } else if (action === 'rehide') {
        revealed.delete(key);
        processNow();
      }
    },
    true
  );

  // ───────── 與 popup 溝通 ─────────
  function status() {
    let matched = 0;
    for (const v of matchedSeen.values()) if (v) matched++;
    return { ok: true, matched, seen: matchedSeen.size, showAll };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
    if (msg.type === 'jf104:getStatus') {
      sendResponse(status());
    } else if (msg.type === 'jf104:setShowAll') {
      showAll = !!msg.value;
      processNow();
      sendResponse(status());
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.companies || changes.keywords)) return;
    await loadSettings();
    schedule();
  });

  // ───────── 啟動（104 約 6 秒後才載入結果，observer 會持續等到卡片出現） ─────────
  (async () => {
    startObserving();
    await loadSettings();
    processNow();
  })();
})();
