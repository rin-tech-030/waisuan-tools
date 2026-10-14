'use strict';

const $ = (id) => document.getElementById(id);
const SEARCH_PREFIX = 'https://www.104.com.tw/jobs/search/';

let tabId = null;

async function ask(message) {
  if (tabId == null) return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return res && res.ok ? res : null;
  } catch (e) {
    return null; // 該分頁沒有載入 content script（不是搜尋頁，或頁面尚未重新整理）
  }
}

function render(status) {
  const toggle = $('toggle');
  if (!status) {
    $('count').textContent = '—';
    $('note').textContent = '請在 104 職缺搜尋結果頁使用（安裝後需重新整理該頁）。';
    toggle.disabled = true;
    return;
  }
  $('count').textContent = String(status.matched);
  $('note').textContent = status.showAll
    ? `本頁有 ${status.matched} 筆符合黑名單，目前已暫時顯示。`
    : `本頁已隱藏 ${status.matched} 筆職缺（含已捲過的）。`;
  toggle.textContent = status.showAll ? '恢復隱藏' : '暫時顯示全部';
  toggle.disabled = false;
}

async function init() {
  $('options').addEventListener('click', async () => {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (e) {
      console.error(e);
    }
    window.close();
  });

  $('toggle').addEventListener('click', async () => {
    const current = await ask({ type: 'jf104:getStatus' });
    if (!current) return render(null);
    render(await ask({ type: 'jf104:setShowAll', value: !current.showAll }));
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return render(null);
  if (typeof tab.url === 'string' && !tab.url.startsWith(SEARCH_PREFIX)) return render(null);
  tabId = tab.id;
  render(await ask({ type: 'jf104:getStatus' }));
}

init();
