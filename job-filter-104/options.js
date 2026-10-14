'use strict';

const MAX_ITEMS = 2000;
const MAX_LEN = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const URL_ID_RE = /\/company\/([A-Za-z0-9_-]+)/;

const $ = (id) => document.getElementById(id);

// ───────── 資料正規化（匯入檔、手動輸入都走這裡） ─────────
function cleanText(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN) : '';
}

function normCompany(c) {
  if (!c || typeof c !== 'object') return null;
  const id = typeof c.id === 'string' ? c.id.trim() : '';
  const name = cleanText(c.name);
  if (id && !ID_RE.test(id)) return null;
  if (!id && !name) return null;
  return { id, name: name || id };
}

function sameCompany(a, b) {
  return a.id || b.id ? a.id === b.id : a.name === b.name;
}

function mergeCompanies(base, extra) {
  const out = base.slice();
  for (const raw of extra) {
    const c = normCompany(raw);
    if (!c) continue;
    if (!out.some((o) => sameCompany(o, c))) out.push(c);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function mergeKeywords(base, extra) {
  const out = base.slice();
  const seen = new Set(out.map((k) => k.toLowerCase()));
  for (const raw of extra) {
    const k = cleanText(raw);
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ───────── 儲存 ─────────
async function load() {
  const data = await chrome.storage.local.get({ companies: [], keywords: [] });
  return {
    companies: mergeCompanies([], Array.isArray(data.companies) ? data.companies : []),
    keywords: mergeKeywords([], Array.isArray(data.keywords) ? data.keywords : [])
  };
}

async function save(state) {
  await chrome.storage.local.set({ companies: state.companies, keywords: state.keywords });
}

// 先讀最新資料再修改，避免覆蓋 104 頁面上剛按下的「隱藏這家公司」
async function update(mutator) {
  const state = await load();
  const result = await mutator(state);
  await save(state);
  return result;
}

function say(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ───────── 畫面（一律用 textContent，不插入 HTML） ─────────
function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function renderCompanies(list) {
  const ul = $('company-list');
  ul.replaceChildren();
  if (!list.length) {
    ul.append(emptyItem('尚無公司。'));
    return;
  }
  list.forEach((c, index) => {
    const li = document.createElement('li');

    const name = document.createElement('input');
    name.type = 'text';
    name.value = c.name;
    name.maxLength = MAX_LEN;
    name.setAttribute('aria-label', '顯示名稱');
    name.addEventListener('change', async () => {
      const next = cleanText(name.value) || c.id;
      if (!next) return;
      await update((s) => {
        const target = s.companies.find((o) => sameCompany(o, c));
        if (target) target.name = next;
      });
      say('已更新顯示名稱。');
    });

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = c.id ? `ID：${c.id}` : '（無 ID，以名稱比對）';
    id.title = c.id;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '移除';
    del.setAttribute('aria-label', `移除 ${c.name}`);
    del.addEventListener('click', async () => {
      await update((s) => {
        s.companies = s.companies.filter((o) => !sameCompany(o, c));
      });
      say(`已移除「${c.name}」。`);
    });

    li.append(name, id, del);
    ul.append(li);
  });
}

function renderKeywords(list) {
  const ul = $('kw-list');
  ul.replaceChildren();
  if (!list.length) {
    ul.append(emptyItem('尚無關鍵字。'));
    return;
  }
  for (const k of list) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'kw';
    text.textContent = k;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '移除';
    del.setAttribute('aria-label', `移除關鍵字 ${k}`);
    del.addEventListener('click', async () => {
      await update((s) => {
        s.keywords = s.keywords.filter((o) => o !== k);
      });
      say(`已移除關鍵字「${k}」。`);
    });

    li.append(text, del);
    ul.append(li);
  }
}

async function render() {
  const state = await load();
  renderCompanies(state.companies);
  renderKeywords(state.keywords);
}

// ───────── 事件 ─────────
$('company-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ref = $('company-ref').value.trim();
  const name = cleanText($('company-name').value);
  let id = '';
  if (ref) {
    const m = URL_ID_RE.exec(ref);
    id = m ? m[1] : ID_RE.test(ref) ? ref : '';
    if (!id) return say('無法辨識公司 ID，請貼上含 /company/ 的網址，或直接輸入 ID。', true);
  }
  if (!id && !name) return say('請至少填入公司網址／ID 或顯示名稱。', true);
  const added = await update((s) => {
    const before = s.companies.length;
    s.companies = mergeCompanies(s.companies, [{ id, name }]);
    return s.companies.length > before;
  });
  say(added ? '已新增公司。' : '這家公司已在黑名單內。');
  if (added) {
    $('company-ref').value = '';
    $('company-name').value = '';
  }
});

$('kw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const k = cleanText($('kw-input').value);
  if (!k) return say('請輸入關鍵字。', true);
  const added = await update((s) => {
    const before = s.keywords.length;
    s.keywords = mergeKeywords(s.keywords, [k]);
    return s.keywords.length > before;
  });
  say(added ? `已新增關鍵字「${k}」。` : '這個關鍵字已存在。');
  if (added) $('kw-input').value = '';
});

$('export').addEventListener('click', async () => {
  const state = await load();
  const payload = {
    app: 'job-filter-104',
    version: 1,
    exportedAt: new Date().toISOString(),
    companies: state.companies,
    keywords: state.keywords
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `job-filter-104-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say('已匯出。');
});

$('import').addEventListener('change', async (ev) => {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return say('檔案太大（上限 1 MB）。', true);
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    return say('不是有效的 JSON 檔。', true);
  }
  if (!data || typeof data !== 'object' || (!Array.isArray(data.companies) && !Array.isArray(data.keywords))) {
    return say('檔案格式不符（需要 companies 或 keywords 陣列）。', true);
  }
  const result = await update((s) => {
    const c0 = s.companies.length;
    const k0 = s.keywords.length;
    s.companies = mergeCompanies(s.companies, Array.isArray(data.companies) ? data.companies : []);
    s.keywords = mergeKeywords(s.keywords, Array.isArray(data.keywords) ? data.keywords : []);
    return { c: s.companies.length - c0, k: s.keywords.length - k0 };
  });
  say(`匯入完成：新增 ${result.c} 家公司、${result.k} 個關鍵字。`);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.companies || changes.keywords)) render();
});

render();
