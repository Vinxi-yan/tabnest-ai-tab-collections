const STORAGE_KEY = "tabnest_state_v3";
const LEGACY_STORAGE_KEYS = ["tabnest_state_v2", "tabnest_state_v1"];
const organizer = new LocalSmartOrganizer();

const defaultState = {
  version: 8,
  theme: "system",
  notes: "",
  collections: [],
  sessions: [],
  todos: []
};

let state = structuredClone(defaultState);
let draggedTab = null;
let notesTimer = null;
let aiDraftGroups = [];
let duplicateDraft = [];
let batchMode = false;
let selectedCollectionIds = new Set();
let collectionSort = "newest";
let collapsedTimelineGroups = new Set();
let showArchivedOnly = false;
let activeCollectionId = null;
let detailSelectMode = false;
let detailSelectedTabIds = new Set();
let detailDraggedTabId = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTimeCollectionName(date = new Date()) {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function uniqueCollectionName(baseName) {
  const names = new Set(state.collections.map(c => c.name));
  if (!names.has(baseName)) return baseName;

  let i = 2;
  while (names.has(`${baseName}（${i}）`)) i += 1;
  return `${baseName}（${i}）`;
}

function createTimeCollection(tabs = []) {
  return {
    id: crypto.randomUUID(),
    name: uniqueCollectionName(formatTimeCollectionName()),
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    tabs
  };
}

function migrateLegacyInboxCollections() {
  const legacyInboxes = state.collections.filter(
    collection => String(collection.name || "").trim() === "收件箱"
  );

  if (!legacyInboxes.length) return false;

  let changed = false;

  for (const inbox of legacyInboxes) {
    if (!Array.isArray(inbox.tabs) || inbox.tabs.length === 0) {
      state.collections = state.collections.filter(collection => collection.id !== inbox.id);
      selectedCollectionIds.delete(inbox.id);
      if (activeCollectionId === inbox.id) activeCollectionId = null;
      changed = true;
      continue;
    }

    const date = new Date(inbox.createdAt || Date.now());
    const baseName = formatTimeCollectionName(date);
    const otherNames = new Set(
      state.collections
        .filter(collection => collection.id !== inbox.id)
        .map(collection => collection.name)
    );

    let newName = baseName;
    let index = 2;
    while (otherNames.has(newName)) {
      newName = `${baseName}（${index}）`;
      index += 1;
    }

    inbox.name = newName;
    inbox.pinned = false;
    inbox.archived = Boolean(inbox.archived);
    changed = true;
  }

  return changed;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getTimelineBucket(createdAt) {
  const now = new Date();
  const created = new Date(createdAt || Date.now());

  const today = startOfDay(now);
  const createdDay = startOfDay(created);
  const diffDays = Math.floor((today - createdDay) / 86400000);

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";

  // Monday as start of week
  const weekday = today.getDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - mondayOffset);

  if (createdDay >= weekStart) return "week";
  return "earlier";
}

function timelineLabel(bucket) {
  return {
    today: "今天",
    yesterday: "昨天",
    week: "本周",
    earlier: "更早"
  }[bucket] || "更早";
}

function sortCollections(items) {
  const copy = [...items];
  if (collectionSort === "oldest") {
    return copy.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }
  if (collectionSort === "name") {
    return copy.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }
  return copy.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function visibleCollectionIds() {
  return [...document.querySelectorAll(".collection-card[data-collection-id]")]
    .map(card => card.dataset.collectionId)
    .filter(Boolean);
}

function updateBatchUi() {
  const count = selectedCollectionIds.size;
  $("#selectedCount").textContent = `已选 ${count} 个`;
  $("#batchActions").classList.toggle("hidden", !batchMode);
  $("#batchModeBtn").classList.toggle("hidden", batchMode);
  $("#collectionsList").classList.toggle("batch-mode", batchMode);

  document.querySelectorAll(".collection-card").forEach(card => {
    const id = card.dataset.collectionId;
    const selected = selectedCollectionIds.has(id);
    card.classList.toggle("selected", selected);

    const checkbox = card.querySelector(".collection-select");
    if (checkbox) {
      checkbox.classList.toggle("hidden", !batchMode);
      checkbox.checked = selected;
    }
  });
}

function enterBatchMode() {
  batchMode = true;
  selectedCollectionIds.clear();
  updateBatchUi();
}

function exitBatchMode() {
  batchMode = false;
  selectedCollectionIds.clear();
  updateBatchUi();
}

function toggleCollectionSelection(id) {
  if (!batchMode) return;
  if (selectedCollectionIds.has(id)) {
    selectedCollectionIds.delete(id);
  } else {
    selectedCollectionIds.add(id);
  }
  updateBatchUi();
}

async function batchAddToToday() {
  if (!selectedCollectionIds.size) return toast("请先选择至少一个标签合集。");

  const collections = state.collections.filter(c => selectedCollectionIds.has(c.id));
  for (const collection of collections) {
    for (const tab of collection.tabs) {
      const existing = state.todos.find(t => t.savedTabId === tab.id);
      if (existing) {
        existing.status = "today";
        existing.updatedAt = Date.now();
      } else {
        state.todos.push({
          id: crypto.randomUUID(),
          savedTabId: tab.id,
          status: "today",
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }
  }

  await saveState();
  render();
  toast(`已将 ${collections.length} 个标签合集加入「今天」。`);
}

async function batchDeleteCollections() {
  if (!selectedCollectionIds.size) return toast("请先选择至少一个标签合集。");

  const collections = state.collections.filter(c => selectedCollectionIds.has(c.id));
  const tabCount = collections.reduce((sum, c) => sum + c.tabs.length, 0);

  const ok = confirm(
    `确定删除已选择的 ${collections.length} 个标签合集吗？\n` +
    `其中包含 ${tabCount} 个已保存标签。\n\n此操作不可撤销。`
  );
  if (!ok) return;

  const deletedTabIds = new Set(collections.flatMap(c => c.tabs.map(t => t.id)));
  state.collections = state.collections.filter(c => !selectedCollectionIds.has(c.id));
  state.todos = state.todos.filter(todo => !deletedTabIds.has(todo.savedTabId));

  await saveState();
  exitBatchMode();
  render();
  toast(`已删除 ${collections.length} 个标签合集。`);
}

async function loadState() {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  const result = await chrome.storage.local.get(keys);

  let loaded = result[STORAGE_KEY];
  if (!loaded) {
    loaded = LEGACY_STORAGE_KEYS.map(key => result[key]).find(Boolean);
  }

  if (loaded) {
    state = { ...clone(defaultState), ...loaded, version: 8 };
    state.collections ||= [];
    state.sessions ||= [];
    state.todos ||= [];
    state.collections = state.collections.map(collection => ({
      archived: false,
      ...collection
    }));

    const migrated = migrateLegacyInboxCollections();
    if (migrated || !result[STORAGE_KEY]) {
      await saveState();
    }
  }
}

async function saveState() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function isSavableTab(tab) {
  return Boolean(tab?.url) &&
    !tab.url.startsWith("chrome-extension://") &&
    !tab.url.startsWith("edge-extension://");
}

function isRestorableUrl(url) {
  return /^(https?:|file:|ftp:)/i.test(url || "");
}

function tabSnapshot(tab) {
  return {
    id: crypto.randomUUID(),
    title: tab.title || tab.url || "未命名标签",
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned),
    createdAt: Date.now()
  };
}

function sessionTabSnapshot(tab) {
  return {
    title: tab.title || tab.url || "未命名标签",
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned)
  };
}

function createSingleTabCollection(rawTab) {
  const collection = createTimeCollection();
  dedupePush(collection, tabSnapshot(rawTab));
  state.collections.unshift(collection);
  return collection;
}

function findSavedTabByUrl(url) {
  for (const collection of state.collections) {
    const tab = collection.tabs.find(t => t.url === url);
    if (tab) return { tab, collection };
  }
  return null;
}

function dedupePush(collection, savedTab) {
  const existing = collection.tabs.find(t => t.url === savedTab.url);
  if (existing) {
    existing.title = savedTab.title;
    existing.favIconUrl = savedTab.favIconUrl;
    existing.createdAt = Date.now();
    return existing;
  }
  collection.tabs.unshift(savedTab);
  return savedTab;
}

async function ensureSavedTab(rawTab) {
  const existing = findSavedTabByUrl(rawTab.url);
  if (existing) return existing.tab;

  const collection = createSingleTabCollection(rawTab);
  return collection.tabs[0];
}

async function saveCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isSavableTab(tab)) return toast("当前标签页无法保存。");

  const collection = createSingleTabCollection(tab);
  await saveState();
  render();
  toast(`已创建标签合集「${collection.name}」。`);
}

async function addRawTabToTodo(rawTab, status = "today") {
  if (!isSavableTab(rawTab)) return toast("当前标签页无法添加。");
  const saved = await ensureSavedTab(rawTab);
  const existing = state.todos.find(t => t.savedTabId === saved.id);

  if (existing) {
    existing.status = status;
    existing.updatedAt = Date.now();
  } else {
    state.todos.unshift({
      id: crypto.randomUUID(),
      savedTabId: saved.id,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  await saveState();
  render();
  toast(status === "today" ? "已添加到「今天」。" : "已添加到「稍后」。");
}

async function addCurrentToTodo(status = "today") {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await addRawTabToTodo(tab, status);
}

async function captureCurrentWindow() {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(isSavableTab);
  return {
    id: crypto.randomUUID(),
    name: `窗口 · ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    windows: [{ tabs: tabs.map(sessionTabSnapshot) }]
  };
}

async function captureAllWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  const captured = windows.map(win => ({
    tabs: (win.tabs || []).filter(isSavableTab).map(sessionTabSnapshot)
  })).filter(win => win.tabs.length);

  return {
    id: crypto.randomUUID(),
    name: `全部窗口 · ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    windows: captured
  };
}

async function saveWindow(closeAfter = false) {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(isSavableTab);
  if (!tabs.length) return toast("当前窗口没有可保存的标签页。");

  if (closeAfter) {
    const session = {
      id: crypto.randomUUID(),
      name: formatTimeCollectionName(),
      createdAt: Date.now(),
      windows: [{ tabs: tabs.map(sessionTabSnapshot) }]
    };

    state.sessions.unshift(session);
    await saveState();
    renderSessions();
    toast("当前窗口已保存为会话并准备关闭。");

    const ids = tabs.map(t => t.id).filter(Number.isInteger);
    if (ids.length) await chrome.tabs.remove(ids);
    return;
  }

  const collection = createTimeCollection();
  for (const tab of tabs) {
    dedupePush(collection, tabSnapshot(tab));
  }

  state.collections.unshift(collection);
  await saveState();
  render();
  toast(`已创建标签合集「${collection.name}」。`);
}

async function saveAllWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  const allTabs = windows
    .flatMap(win => win.tabs || [])
    .filter(isSavableTab);

  if (!allTabs.length) return toast("没有找到可保存的标签页。");

  const collection = createTimeCollection();
  for (const tab of allTabs) {
    dedupePush(collection, tabSnapshot(tab));
  }

  state.collections.unshift(collection);
  await saveState();
  render();
  toast(`已将所有窗口保存为标签合集「${collection.name}」。`);
}

async function restoreSession(session) {
  for (const win of session.windows) {
    const validTabs = win.tabs.filter(t => isRestorableUrl(t.url));
    if (!validTabs.length) continue;

    const created = await chrome.windows.create({ url: validTabs[0].url });
    const firstTabId = created.tabs?.[0]?.id;

    if (firstTabId && validTabs[0].pinned) {
      await chrome.tabs.update(firstTabId, { pinned: true });
    }

    for (const saved of validTabs.slice(1)) {
      await chrome.tabs.create({
        windowId: created.id,
        url: saved.url,
        active: false,
        pinned: saved.pinned
      });
    }
  }
  toast("会话已恢复。");
}

async function openSavedTab(tab) {
  if (!isRestorableUrl(tab.url)) return toast("该网址无法恢复打开。");
  await chrome.tabs.create({ url: tab.url, active: true });
}

async function openCollection(collection) {
  const tabs = collection.tabs.filter(t => isRestorableUrl(t.url));
  if (!tabs.length) return toast("该收藏组中没有可打开的标签页。");

  const created = await chrome.windows.create({ url: tabs[0].url });
  for (const tab of tabs.slice(1)) {
    await chrome.tabs.create({ windowId: created.id, url: tab.url, active: false });
  }
}

function applyTheme() {
  const dark = state.theme === "dark" ||
    (state.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

async function toggleTheme() {
  const currentDark = document.documentElement.dataset.theme === "dark";
  state.theme = currentDark ? "light" : "dark";
  await saveState();
  applyTheme();
}

function fallbackFavicon() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18'%3E%3Crect width='18' height='18' rx='4' fill='%23999'/%3E%3C/svg%3E";
}

function faviconElement(tab) {
  const img = document.createElement("img");
  img.className = "favicon";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.src = tab.favIconUrl || fallbackFavicon();
  img.onerror = () => { img.src = fallbackFavicon(); };
  return img;
}

function todoStatusForTab(tabId) {
  return state.todos.find(t => t.savedTabId === tabId)?.status || "none";
}

async function setTodoStatus(tabId, status) {
  const existing = state.todos.find(t => t.savedTabId === tabId);

  if (status === "none") {
    state.todos = state.todos.filter(t => t.savedTabId !== tabId);
  } else if (existing) {
    existing.status = status;
    existing.updatedAt = Date.now();
  } else {
    state.todos.unshift({
      id: crypto.randomUUID(),
      savedTabId: tabId,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  await saveState();
  render();
}

function makeTodoSelect(tabId) {
  const select = document.createElement("select");
  [
    ["none", "无待办"],
    ["today", "今天"],
    ["later", "稍后"],
    ["done", "已完成"]
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = todoStatusForTab(tabId);
  select.title = "待办状态";
  select.addEventListener("click", e => e.stopPropagation());
  select.addEventListener("change", () => setTodoStatus(tabId, select.value));
  return select;
}


let contextTabMove = null;

function hideTabContextMenu() {
  $("#tabContextMenu")?.classList.add("hidden");
  contextTabMove = null;
}

function positionContextMenu(menu, x, y) {
  menu.classList.remove("hidden");

  const margin = 8;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;

  if (left + rect.width > window.innerWidth - margin) {
    left = window.innerWidth - rect.width - margin;
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = window.innerHeight - rect.height - margin;
  }

  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function showTabMoveContextMenu(event, tabId, sourceCollectionId) {
  event.preventDefault();
  event.stopPropagation();

  contextTabMove = { tabId, sourceCollectionId };

  const targetsEl = $("#tabContextTargets");
  const menu = $("#tabContextMenu");
  targetsEl.innerHTML = "";

  const targets = sortCollections(
    state.collections.filter(collection =>
      !collection.archived && collection.id !== sourceCollectionId
    )
  );

  if (!targets.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.disabled = true;
    empty.textContent = "没有其他可用合集";
    targetsEl.appendChild(empty);
  } else {
    for (const target of targets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${target.name} · ${target.tabs.length} 个标签`;
      btn.addEventListener("click", () => moveSingleTabToCollection(tabId, sourceCollectionId, target.id));
      targetsEl.appendChild(btn);
    }
  }

  positionContextMenu(menu, event.clientX, event.clientY);
}

async function moveSingleTabToCollection(tabId, sourceCollectionId, targetCollectionId) {
  const source = state.collections.find(c => c.id === sourceCollectionId);
  const target = state.collections.find(c => c.id === targetCollectionId);
  if (!source || !target) return hideTabContextMenu();

  const index = source.tabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return hideTabContextMenu();

  const [tab] = source.tabs.splice(index, 1);

  if (!target.tabs.some(existing => existing.url === tab.url)) {
    target.tabs.push(tab);
  }

  // Remove empty automatically-created source collections only when they are empty and not pinned.
  if (!source.tabs.length && !source.pinned) {
    state.collections = state.collections.filter(c => c.id !== source.id);
    if (activeCollectionId === source.id) activeCollectionId = null;
  }

  await saveState();
  hideTabContextMenu();
  render();

  if (activeCollectionId) {
    renderCollectionDetail();
  }

  toast(`已移动到「${target.name}」。`);
}

async function moveSingleTabToNewTimeCollection() {
  if (!contextTabMove) return;

  const source = state.collections.find(c => c.id === contextTabMove.sourceCollectionId);
  if (!source) return hideTabContextMenu();

  const index = source.tabs.findIndex(tab => tab.id === contextTabMove.tabId);
  if (index < 0) return hideTabContextMenu();

  const [tab] = source.tabs.splice(index, 1);
  const collection = createTimeCollection([tab]);
  state.collections.unshift(collection);

  if (!source.tabs.length && !source.pinned) {
    state.collections = state.collections.filter(c => c.id !== source.id);
    if (activeCollectionId === source.id) activeCollectionId = null;
  }

  await saveState();
  hideTabContextMenu();
  render();
  toast(`已移动到新合集「${collection.name}」。`);
}

function makeTabRow(tab, collectionId) {
  const row = document.createElement("div");
  row.className = "saved-tab";
  row.draggable = true;
  row.dataset.tabId = tab.id;
  row.dataset.collectionId = collectionId;

  row.appendChild(faviconElement(tab));

  const text = document.createElement("div");
  text.className = "tab-text";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url;
  const url = document.createElement("div");
  url.className = "tab-url";
  url.textContent = tab.url;
  text.append(title, url);
  row.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "tab-actions";

  const todo = document.createElement("button");
  const currentStatus = todoStatusForTab(tab.id);
  todo.title = currentStatus === "none" ? "添加到「今天」" : `待办状态：${currentStatus === "today" ? "今天" : currentStatus === "later" ? "稍后" : "已完成"}`;
  todo.textContent = currentStatus === "done" ? "✓" : currentStatus === "today" ? "●" : currentStatus === "later" ? "◷" : "＋";
  todo.addEventListener("click", async (e) => {
    e.stopPropagation();
    await setTodoStatus(tab.id, currentStatus === "today" ? "done" : "today");
  });

  const open = document.createElement("button");
  open.title = "打开";
  open.textContent = "↗";
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    openSavedTab(tab);
  });

  const remove = document.createElement("button");
  remove.title = "移除";
  remove.textContent = "×";
  remove.addEventListener("click", async (e) => {
    e.stopPropagation();
    const collection = state.collections.find(c => c.id === collectionId);
    collection.tabs = collection.tabs.filter(t => t.id !== tab.id);
    state.todos = state.todos.filter(t => t.savedTabId !== tab.id);
    await saveState();
    render();
  });

  actions.append(todo, open, remove);
  row.appendChild(actions);

  row.addEventListener("dblclick", () => openSavedTab(tab));
  row.addEventListener("contextmenu", (event) => {
    showTabMoveContextMenu(event, tab.id, collectionId);
  });
  row.addEventListener("dragstart", () => {
    draggedTab = { tabId: tab.id, fromCollectionId: collectionId };
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    draggedTab = null;
    row.classList.remove("dragging");
    $$(".collection-card").forEach(c => c.classList.remove("drag-over"));
  });

  return row;
}

function showCollectionMenu(card, collection) {
  card.querySelector(".collection-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "collection-menu";

  const openDetail = document.createElement("button");
  openDetail.textContent = "打开合集详情";
  openDetail.addEventListener("click", () => openCollectionDetail(collection.id));

  const rename = document.createElement("button");
  rename.textContent = "重命名";
  rename.addEventListener("click", async () => {
    const name = prompt("标签合集名称", collection.name)?.trim();
    if (!name) return;
    collection.name = name;
    await saveState();
    render();
  });

  const addCurrent = document.createElement("button");
  addCurrent.textContent = "将当前标签保存到这里";
  addCurrent.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isSavableTab(tab)) return toast("当前标签页无法保存。");
    dedupePush(collection, tabSnapshot(tab));
    await saveState();
    render();
  });

  const todoAll = document.createElement("button");
  todoAll.textContent = "整个合集加入「今天」";
  todoAll.addEventListener("click", async () => {
    for (const tab of collection.tabs) {
      const existing = state.todos.find(t => t.savedTabId === tab.id);
      if (existing) {
        existing.status = "today";
        existing.updatedAt = Date.now();
      } else {
        state.todos.push({
          id: crypto.randomUUID(),
          savedTabId: tab.id,
          status: "today",
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }
    await saveState();
    render();
    switchView("todo");
  });

  const archive = document.createElement("button");
  archive.textContent = collection.archived ? "恢复合集" : "归档合集";
  archive.addEventListener("click", async () => {
    await toggleArchiveCollection(collection);
  });

  const del = document.createElement("button");
  del.className = "delete";
  del.textContent = "删除标签合集";
  del.addEventListener("click", async () => {
    if (state.collections.length <= 1) return toast("至少需要保留一个标签合集。");
    if (!confirm(`确定删除标签合集“${collection.name}”及其中已保存的标签页吗？`)) return;

    const ids = new Set(collection.tabs.map(t => t.id));
    state.todos = state.todos.filter(t => !ids.has(t.savedTabId));
    state.collections = state.collections.filter(c => c.id !== collection.id);
    await saveState();
    render();
  });

  menu.append(openDetail, rename, addCurrent, todoAll, archive, del);
  card.appendChild(menu);

  setTimeout(() => {
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener("click", close, true);
      }
    };
    document.addEventListener("click", close, true);
  }, 0);
}


function getActiveCollection() {
  return state.collections.find(c => c.id === activeCollectionId) || null;
}

function openCollectionDetail(collectionId) {
  const collection = state.collections.find(c => c.id === collectionId);
  if (!collection) return;

  activeCollectionId = collectionId;
  detailSelectMode = false;
  detailSelectedTabIds.clear();

  $$(".nav-tab").forEach(btn => btn.classList.remove("active"));
  $$(".view").forEach(view => view.classList.remove("active"));
  $("#collectionDetailView").classList.add("active");

  renderCollectionDetail();
}

function closeCollectionDetail() {
  activeCollectionId = null;
  detailSelectMode = false;
  detailSelectedTabIds.clear();
  switchView("collections");
}

function updateDetailBatchUi() {
  $("#detailSelectedCount").textContent = `已选 ${detailSelectedTabIds.size} 个`;
  $("#detailBatchActions").classList.toggle("hidden", !detailSelectMode);
  $("#detailSelectModeBtn").classList.toggle("hidden", detailSelectMode);

  document.querySelectorAll(".detail-tab-row").forEach(row => {
    const id = row.dataset.tabId;
    const selected = detailSelectedTabIds.has(id);
    row.classList.toggle("selected", selected);
    const checkbox = row.querySelector(".detail-tab-select");
    if (checkbox) {
      checkbox.classList.toggle("hidden", !detailSelectMode);
      checkbox.checked = selected;
    }
  });
}

function toggleDetailTabSelection(tabId) {
  if (!detailSelectMode) return;
  if (detailSelectedTabIds.has(tabId)) {
    detailSelectedTabIds.delete(tabId);
  } else {
    detailSelectedTabIds.add(tabId);
  }
  updateDetailBatchUi();
}

function makeDetailTabRow(tab, collection) {
  const row = document.createElement("div");
  row.className = "detail-tab-row";
  row.dataset.tabId = tab.id;
  row.draggable = !detailSelectMode;

  const select = document.createElement("input");
  select.type = "checkbox";
  select.className = "detail-tab-select";
  select.classList.toggle("hidden", !detailSelectMode);
  select.checked = detailSelectedTabIds.has(tab.id);
  select.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetailTabSelection(tab.id);
  });

  const handle = document.createElement("div");
  handle.className = "drag-handle";
  handle.textContent = "⋮⋮";
  handle.title = "拖动排序";

  const contentWrap = document.createElement("div");
  contentWrap.style.display = "grid";
  contentWrap.style.gridTemplateColumns = "22px 1fr";
  contentWrap.style.gap = "8px";
  contentWrap.style.alignItems = "center";
  contentWrap.style.minWidth = "0";
  contentWrap.appendChild(faviconElement(tab));

  const text = document.createElement("div");
  text.className = "tab-text";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url;
  const url = document.createElement("div");
  url.className = "tab-url";
  url.textContent = tab.url;
  text.append(title, url);
  contentWrap.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "detail-row-actions";

  const todo = document.createElement("button");
  todo.title = "加入今天";
  todo.textContent = "＋";
  todo.addEventListener("click", async (e) => {
    e.stopPropagation();
    await setTodoStatus(tab.id, "today");
    renderCollectionDetail();
  });

  const open = document.createElement("button");
  open.title = "打开";
  open.textContent = "↗";
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    openSavedTab(tab);
  });

  const remove = document.createElement("button");
  remove.title = "删除";
  remove.textContent = "×";
  remove.addEventListener("click", async (e) => {
    e.stopPropagation();
    collection.tabs = collection.tabs.filter(t => t.id !== tab.id);
    state.todos = state.todos.filter(t => t.savedTabId !== tab.id);
    await saveState();
    renderCollectionDetail();
    renderCollections();
  });

  actions.append(todo, open, remove);
  row.append(select, handle, contentWrap, actions);

  row.addEventListener("click", (e) => {
    if (!detailSelectMode) return;
    if (e.target.closest("button,input")) return;
    toggleDetailTabSelection(tab.id);
  });

  row.addEventListener("dblclick", () => {
    if (!detailSelectMode) openSavedTab(tab);
  });

  row.addEventListener("contextmenu", (event) => {
    if (!detailSelectMode) showTabMoveContextMenu(event, tab.id, collection.id);
  });

  row.addEventListener("dragstart", () => {
    if (detailSelectMode) return;
    detailDraggedTabId = tab.id;
    row.classList.add("dragging");
  });

  row.addEventListener("dragend", () => {
    detailDraggedTabId = null;
    row.classList.remove("dragging");
    document.querySelectorAll(".detail-tab-row").forEach(r => {
      r.classList.remove("drop-before", "drop-after");
    });
  });

  row.addEventListener("dragover", (e) => {
    if (!detailDraggedTabId || detailDraggedTabId === tab.id || detailSelectMode) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle("drop-before", before);
    row.classList.toggle("drop-after", !before);
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-before", "drop-after");
  });

  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!detailDraggedTabId || detailDraggedTabId === tab.id || detailSelectMode) return;

    const fromIndex = collection.tabs.findIndex(t => t.id === detailDraggedTabId);
    const targetIndex = collection.tabs.findIndex(t => t.id === tab.id);
    if (fromIndex < 0 || targetIndex < 0) return;

    const rect = row.getBoundingClientRect();
    const placeBefore = e.clientY < rect.top + rect.height / 2;

    const [moved] = collection.tabs.splice(fromIndex, 1);
    let insertIndex = collection.tabs.findIndex(t => t.id === tab.id);
    if (!placeBefore) insertIndex += 1;
    collection.tabs.splice(insertIndex, 0, moved);

    await saveState();
    renderCollectionDetail();
    renderCollections();
  });

  return row;
}

function renderCollectionDetail() {
  const collection = getActiveCollection();
  if (!collection) {
    closeCollectionDetail();
    return;
  }

  $("#detailCollectionTitle").textContent = collection.name;
  $("#detailCollectionMeta").textContent =
    `${collection.tabs.length} 个标签${collection.archived ? " · 已归档" : ""}`;

  const list = $("#detailTabList");
  list.innerHTML = "";

  if (!collection.tabs.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "这个标签合集还是空的。";
    list.appendChild(empty);
  } else {
    for (const tab of collection.tabs) {
      list.appendChild(makeDetailTabRow(tab, collection));
    }
  }

  updateDetailBatchUi();
}

async function detailAddCurrentTab() {
  const collection = getActiveCollection();
  if (!collection) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isSavableTab(tab)) return toast("当前标签页无法保存。");

  dedupePush(collection, tabSnapshot(tab));
  await saveState();
  renderCollectionDetail();
  renderCollections();
  toast(`已保存到「${collection.name}」。`);
}

async function openSelectedDetailTabs() {
  const collection = getActiveCollection();
  if (!collection || !detailSelectedTabIds.size) return toast("请先选择标签。");

  const tabs = collection.tabs.filter(tab => detailSelectedTabIds.has(tab.id) && isRestorableUrl(tab.url));
  if (!tabs.length) return toast("所选标签无法打开。");

  const created = await chrome.windows.create({ url: tabs[0].url });
  for (const tab of tabs.slice(1)) {
    await chrome.tabs.create({ windowId: created.id, url: tab.url, active: false });
  }
}

function openMoveTabsDialog() {
  const collection = getActiveCollection();
  if (!collection || !detailSelectedTabIds.size) return toast("请先选择标签。");

  const list = $("#moveTargetList");
  list.innerHTML = "";

  const targets = state.collections.filter(c => c.id !== collection.id && !c.archived);
  if (!targets.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "没有可移动到的其他标签合集。";
    list.appendChild(empty);
  } else {
    for (const target of sortCollections(targets)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "move-target-btn";
      btn.textContent = `${target.name} · ${target.tabs.length} 个标签`;
      btn.addEventListener("click", () => moveSelectedTabsTo(target.id));
      list.appendChild(btn);
    }
  }

  $("#moveTabsDialog").showModal();
}

async function moveSelectedTabsTo(targetCollectionId) {
  const source = getActiveCollection();
  const target = state.collections.find(c => c.id === targetCollectionId);
  if (!source || !target) return;

  const moving = source.tabs.filter(tab => detailSelectedTabIds.has(tab.id));
  source.tabs = source.tabs.filter(tab => !detailSelectedTabIds.has(tab.id));

  for (const tab of moving) {
    if (!target.tabs.some(t => t.url === tab.url)) {
      target.tabs.push(tab);
    }
  }

  await saveState();
  detailSelectedTabIds.clear();
  detailSelectMode = false;
  $("#moveTabsDialog").close();
  renderCollectionDetail();
  renderCollections();
  toast(`已移动 ${moving.length} 个标签到「${target.name}」。`);
}

async function deleteSelectedDetailTabs() {
  const collection = getActiveCollection();
  if (!collection || !detailSelectedTabIds.size) return toast("请先选择标签。");

  const count = detailSelectedTabIds.size;
  if (!confirm(`确定删除已选择的 ${count} 个标签吗？`)) return;

  collection.tabs = collection.tabs.filter(tab => !detailSelectedTabIds.has(tab.id));
  state.todos = state.todos.filter(todo => !detailSelectedTabIds.has(todo.savedTabId));

  detailSelectedTabIds.clear();
  detailSelectMode = false;
  await saveState();
  renderCollectionDetail();
  renderCollections();
  toast(`已删除 ${count} 个标签。`);
}

async function toggleArchiveCollection(collection) {
  collection.archived = !collection.archived;
  collection.archivedAt = collection.archived ? Date.now() : null;
  await saveState();

  if (activeCollectionId === collection.id) {
    renderCollectionDetail();
  }
  renderCollections();

  toast(collection.archived ? "标签合集已归档。" : "标签合集已恢复。");
}

function renderCollections() {
  const list = $("#collectionsList");
  list.innerHTML = "";

  const total = state.collections.reduce((sum, c) => sum + c.tabs.length, 0);
  $("#tabCount").textContent = `${state.collections.length} 个合集 · ${total} 个已保存标签`;

  const visibleCollections = state.collections.filter(c => Boolean(c.archived) === showArchivedOnly);
  const pinned = showArchivedOnly ? [] : sortCollections(visibleCollections.filter(c => c.pinned));
  const normal = visibleCollections.filter(c => !c.pinned);

  const buckets = {
    today: [],
    yesterday: [],
    week: [],
    earlier: []
  };

  for (const collection of normal) {
    buckets[getTimelineBucket(collection.createdAt)].push(collection);
  }

  const renderCollectionCard = (collection) => {
    const fragment = $("#collectionTemplate").content.cloneNode(true);
    const card = fragment.querySelector(".collection-card");
    card.dataset.collectionId = collection.id;
    card.dataset.collectionId = collection.id;

    fragment.querySelector(".collection-title").textContent = collection.name;
    fragment.querySelector(".collection-meta").textContent =
      `${collection.tabs.length} 个标签`;

    const titleEl = fragment.querySelector(".collection-title");
    titleEl.style.cursor = "pointer";
    titleEl.title = "打开合集详情";
    titleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!batchMode) openCollectionDetail(collection.id);
    });

    if (collection.archived) {
      const badge = document.createElement("span");
      badge.className = "archive-badge";
      badge.textContent = "已归档";
      fragment.querySelector(".collection-meta").after(badge);
      card.classList.add("archived-card");
    }

    const checkbox = fragment.querySelector(".collection-select");
    checkbox.checked = selectedCollectionIds.has(collection.id);
    checkbox.classList.toggle("hidden", !batchMode);
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollectionSelection(collection.id);
    });

    const pin = fragment.querySelector(".pin-btn");
    pin.textContent = collection.pinned ? "★" : "☆";
    pin.classList.toggle("is-pinned", Boolean(collection.pinned));
    pin.addEventListener("click", async (e) => {
      e.stopPropagation();
      collection.pinned = !collection.pinned;
      await saveState();
      render();
    });

    fragment.querySelector(".open-all-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!batchMode) openCollection(collection);
    });

    fragment.querySelector(".more-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!batchMode) showCollectionMenu(card, collection);
    });

    const tabList = fragment.querySelector(".tab-list");
    for (const tab of collection.tabs) {
      tabList.appendChild(makeTabRow(tab, collection.id));
    }

    card.classList.toggle("is-empty", !collection.tabs.length);
    card.classList.toggle("selected", selectedCollectionIds.has(collection.id));

    card.addEventListener("dblclick", (e) => {
      if (batchMode || e.target.closest("button,input,.saved-tab")) return;
      openCollectionDetail(collection.id);
    });

    card.addEventListener("click", (e) => {
      if (!batchMode) return;
      if (e.target.closest("button, select, input, .saved-tab")) return;
      toggleCollectionSelection(collection.id);
    });

    const dropZone = fragment.querySelector(".drop-zone");
    dropZone.addEventListener("dragover", (e) => {
      if (!draggedTab || batchMode) return;
      e.preventDefault();
      card.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (!draggedTab || batchMode) return;

      const from = state.collections.find(c => c.id === draggedTab.fromCollectionId);
      const to = state.collections.find(c => c.id === collection.id);
      if (!from || !to) return;

      const idx = from.tabs.findIndex(t => t.id === draggedTab.tabId);
      if (idx < 0) return;

      const [moved] = from.tabs.splice(idx, 1);
      if (!to.tabs.find(t => t.url === moved.url)) to.tabs.unshift(moved);

      await saveState();
      render();
    });

    return fragment;
  };

  const renderTimelineSection = (key, title, collections) => {
    if (!collections.length) return;

    const section = document.createElement("section");
    section.className = "timeline-section";
    section.dataset.timelineGroup = key;

    const head = document.createElement("div");
    head.className = "timeline-head";

    const toggle = document.createElement("button");
    toggle.className = "timeline-toggle";
    toggle.type = "button";

    const chev = document.createElement("span");
    chev.className = "chevron";
    chev.textContent = collapsedTimelineGroups.has(key) ? "›" : "⌄";

    const label = document.createElement("span");
    label.textContent = title;

    const count = document.createElement("span");
    count.className = "timeline-count";
    count.textContent = `${collections.length} 个合集`;

    toggle.append(chev, label, count);
    toggle.addEventListener("click", () => {
      if (collapsedTimelineGroups.has(key)) {
        collapsedTimelineGroups.delete(key);
      } else {
        collapsedTimelineGroups.add(key);
      }
      renderCollections();
      updateBatchUi();
    });

    head.appendChild(toggle);

    const body = document.createElement("div");
    body.className = "timeline-body";
    body.classList.toggle("collapsed", collapsedTimelineGroups.has(key));

    for (const collection of sortCollections(collections)) {
      body.appendChild(renderCollectionCard(collection));
    }

    section.append(head, body);
    list.appendChild(section);
  };

  if (pinned.length) {
    renderTimelineSection("pinned", "已置顶", pinned);
  }

  renderTimelineSection("today", "今天", buckets.today);
  renderTimelineSection("yesterday", "昨天", buckets.yesterday);
  renderTimelineSection("week", "本周", buckets.week);
  renderTimelineSection("earlier", "更早", buckets.earlier);

  if (!state.collections.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = showArchivedOnly ? "还没有已归档的标签合集。" : "还没有标签合集。点击「保存标签」「窗口存为合集」或「+ 新建合集」开始。";
    list.appendChild(empty);
  }

  updateBatchUi();
}

function getSavedTabById(id) {
  for (const collection of state.collections) {
    const tab = collection.tabs.find(t => t.id === id);
    if (tab) return { tab, collection };
  }
  return null;
}

function renderTodo() {
  const board = $("#todoBoard");
  board.innerHTML = "";

  const groups = [
    ["today", "今天"],
    ["later", "稍后"],
    ["done", "已完成"]
  ];

  for (const [status, label] of groups) {
    const items = state.todos
      .filter(todo => todo.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const column = document.createElement("section");
    column.className = "todo-column";

    const heading = document.createElement("h3");
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    const count = document.createElement("span");
    count.className = "todo-count";
    count.textContent = items.length;
    heading.append(labelSpan, count);
    column.appendChild(heading);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = status === "today"
        ? "今天暂无待处理标签。"
        : status === "later"
        ? "暂无稍后处理的标签。"
        : "已完成的项目会显示在这里。";
      column.appendChild(empty);
    }

    for (const todo of items) {
      const found = getSavedTabById(todo.savedTabId);
      if (!found) continue;
      const { tab, collection } = found;

      const row = document.createElement("div");
      row.className = `todo-item ${status === "done" ? "todo-completed" : ""}`;
      row.appendChild(faviconElement(tab));

      const text = document.createElement("div");
      text.className = "tab-text";

      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = tab.title;

      const meta = document.createElement("div");
      meta.className = "tab-url";
      meta.textContent = collection.name;

      text.append(title, meta);
      row.appendChild(text);
      row.appendChild(makeTodoSelect(tab.id));

      row.addEventListener("dblclick", () => openSavedTab(tab));
      column.appendChild(row);
    }

    board.appendChild(column);
  }
}

function renderSessions() {
  const list = $("#sessionsList");
  list.innerHTML = "";

  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "还没有保存的会话。";
    list.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const card = document.createElement("article");
    card.className = "session-card";

    const title = document.createElement("h3");
    title.textContent = session.name;

    const count = session.windows.reduce((sum, w) => sum + w.tabs.length, 0);
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${session.windows.length} 个窗口 · ${count} 个标签`;

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const restore = document.createElement("button");
    restore.textContent = "恢复";
    restore.addEventListener("click", () => restoreSession(session));

    const todo = document.createElement("button");
    todo.textContent = "→ 今天";
    todo.addEventListener("click", async () => {
      for (const raw of session.windows.flatMap(w => w.tabs)) {
        await addRawTabToTodo(raw, "today");
      }
      switchView("todo");
    });

    const remove = document.createElement("button");
    remove.className = "delete";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      state.sessions = state.sessions.filter(s => s.id !== session.id);
      await saveState();
      renderSessions();
    });

    actions.append(restore, todo, remove);
    card.append(title, meta, actions);
    list.appendChild(card);
  }
}

function renderSearch() {
  const q = $("#searchInput").value.trim().toLowerCase();
  const results = $("#searchResults");
  const collections = $("#collectionsList");

  if (!q) {
    results.classList.add("hidden");
    collections.classList.remove("hidden");
    results.innerHTML = "";
    return;
  }

  switchView("collections");
  collections.classList.add("hidden");
  results.classList.remove("hidden");
  results.innerHTML = "";

  const matches = [];
  for (const collection of state.collections) {
    for (const tab of collection.tabs) {
      const haystack = `${tab.title} ${tab.url} ${collection.name}`.toLowerCase();
      if (haystack.includes(q)) matches.push({ tab, collection });
    }
  }

  const heading = document.createElement("h3");
  heading.textContent = `${matches.length} 个搜索结果`;
  results.appendChild(heading);

  for (const { tab, collection } of matches) {
    const row = document.createElement("div");
    row.className = "search-result";
    row.appendChild(faviconElement(tab));

    const text = document.createElement("div");
    text.className = "tab-text";

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title;

    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = `${collection.name} · ${tab.url}`;

    text.append(title, url);
    row.appendChild(text);
    row.appendChild(makeTodoSelect(tab.id));
    row.addEventListener("dblclick", () => openSavedTab(tab));
    results.appendChild(row);
  }
}

function renderNotes() {
  $("#notesInput").value = state.notes || "";
}

function render() {
  renderCollections();
  renderTodo();
  renderSessions();
  renderSearch();
  if (activeCollectionId) renderCollectionDetail();
}

async function addCollection() {
  const collection = createTimeCollection();
  state.collections.unshift(collection);
  await saveState();
  render();
  toast(`已新建标签合集「${collection.name}」，可在菜单中重命名。`);
}

function switchView(name) {
  $$(".nav-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.view === name));
  $$(".view").forEach(view => view.classList.remove("active"));
  $(`#${name}View`).classList.add("active");
}

async function exportBackup() {
  const exportData = {
    ...state,
    version: 8,
    exportedAt: new Date().toISOString(),
    app: "TabNest AI 标签合集"
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;

  a.href = url;
  a.download = `tabnest-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("备份已导出。");
}

function validateImportedState(data) {
  if (!data || typeof data !== "object") {
    throw new Error("文件内容不是有效的 TabNest 备份。");
  }

  if (!Array.isArray(data.collections)) {
    throw new Error("备份中缺少标签合集数据。");
  }

  for (const collection of data.collections) {
    if (!collection || typeof collection !== "object" || !Array.isArray(collection.tabs)) {
      throw new Error("标签合集结构不完整。");
    }
  }

  if (data.sessions != null && !Array.isArray(data.sessions)) {
    throw new Error("会话数据格式错误。");
  }

  if (data.todos != null && !Array.isArray(data.todos)) {
    throw new Error("待办数据格式错误。");
  }

  return true;
}

async function importBackupFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    validateImportedState(data);

    const ok = confirm(
      `准备导入备份：\n` +
      `${data.collections.length} 个标签合集\n` +
      `${(data.sessions || []).length} 个会话\n` +
      `${(data.todos || []).length} 个待办\n\n` +
      `导入将覆盖当前 TabNest 本地数据，是否继续？`
    );

    if (!ok) return;

    state = {
      ...clone(defaultState),
      ...data,
      version: 8,
      collections: Array.isArray(data.collections) ? data.collections : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      todos: Array.isArray(data.todos) ? data.todos : [],
      notes: typeof data.notes === "string" ? data.notes : "",
      theme: ["system", "light", "dark"].includes(data.theme) ? data.theme : "system"
    };

    state.collections = state.collections.map(collection => ({
      archived: false,
      ...collection
    }));

    migrateLegacyInboxCollections();

    await saveState();
    applyTheme();
    renderNotes();
    render();
    toast("备份导入成功。");
  } catch (error) {
    console.error(error);
    alert(`导入失败：${error.message || "无法读取该备份文件。"}`);
  } finally {
    $("#importInput").value = "";
  }
}

function allSavedTabs() {
  return state.collections.flatMap(collection =>
    collection.tabs.map(tab => ({ ...tab, sourceCollectionId: collection.id }))
  );
}

async function getAiSourceTabs() {
  const source = document.querySelector('input[name="aiSource"]:checked')?.value || "current";
  if (source === "saved") return allSavedTabs();
  return (await chrome.tabs.query({ currentWindow: true }))
    .filter(isSavableTab)
    .map(tabSnapshot);
}

function renderAiPreview(groups) {
  const preview = $("#aiPreview");
  preview.innerHTML = "";

  if (!groups.length) {
    preview.innerHTML = '<div class="muted">没有可整理的标签页。</div>';
    $("#aiApplyBtn").disabled = true;
    return;
  }

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "ai-group";

    const h = document.createElement("h3");
    const name = document.createElement("span");
    name.textContent = group.name;
    const confidence = document.createElement("span");
    confidence.className = "muted";
    confidence.textContent = `${Math.round(group.confidence * 100)}% · ${group.tabs.length}`;
    h.append(name, confidence);

    const ul = document.createElement("ul");
    group.tabs.slice(0, 8).forEach(tab => {
      const li = document.createElement("li");
      li.textContent = tab.title || tab.url;
      ul.appendChild(li);
    });
    if (group.tabs.length > 8) {
      const li = document.createElement("li");
      li.textContent = `另有 ${group.tabs.length - 8} 个`;
      ul.appendChild(li);
    }

    section.append(h, ul);
    preview.appendChild(section);
  }

  $("#aiApplyBtn").disabled = false;
}

async function generateAiSuggestions() {
  const tabs = await getAiSourceTabs();
  aiDraftGroups = organizer.group(tabs);
  renderAiPreview(aiDraftGroups);
}

async function suggestWorkspaceName() {
  const tabs = await getAiSourceTabs();
  const name = organizer.smartName(tabs);
  const el = $("#aiNameSuggestion");
  el.textContent = `推荐名称：${name}`;
  el.classList.remove("hidden");
}

async function applyAiGroups() {
  if (!aiDraftGroups.length) return;

  const source = document.querySelector('input[name="aiSource"]:checked')?.value || "current";

  for (const group of aiDraftGroups) {
    let collection = state.collections.find(c => c.name.toLowerCase() === group.name.toLowerCase());
    if (!collection) {
      collection = {
        id: crypto.randomUUID(),
        name: group.name,
        pinned: false,
        createdAt: Date.now(),
        tabs: []
      };
      state.collections.push(collection);
    }

    for (const rawTab of group.tabs) {
      if (source === "saved" && rawTab.sourceCollectionId) {
        const from = state.collections.find(c => c.id === rawTab.sourceCollectionId);
        if (!from || from.id === collection.id) continue;

        const idx = from.tabs.findIndex(t => t.id === rawTab.id);
        if (idx >= 0) {
          const [moved] = from.tabs.splice(idx, 1);
          if (!collection.tabs.find(t => t.url === moved.url)) {
            collection.tabs.unshift(moved);
          }
        }
      } else {
        const existing = findSavedTabByUrl(rawTab.url);
        if (existing) {
          if (existing.collection.id !== collection.id) {
            existing.collection.tabs = existing.collection.tabs.filter(t => t.id !== existing.tab.id);
            if (!collection.tabs.find(t => t.url === existing.tab.url)) {
              collection.tabs.unshift(existing.tab);
            }
          }
        } else {
          collection.tabs.unshift({
            id: rawTab.id || crypto.randomUUID(),
            title: rawTab.title || rawTab.url,
            url: rawTab.url,
            favIconUrl: rawTab.favIconUrl || "",
            pinned: Boolean(rawTab.pinned),
            createdAt: Date.now()
          });
        }
      }
    }
  }

  state.collections = state.collections.filter(c => c.tabs.length > 0);
  await saveState();
  render();
  $("#aiDialog").close();
  toast("AI 整理结果已应用。");
}

function openDuplicateDialog() {
  const all = allSavedTabs();
  const result = organizer.dedupe(all);
  duplicateDraft = result.duplicates;

  const list = $("#duplicateList");
  list.innerHTML = "";

  if (!duplicateDraft.length) {
    list.innerHTML = '<div class="muted">未发现重复网址。</div>';
    $("#removeDuplicatesBtn").disabled = true;
  } else {
    $("#removeDuplicatesBtn").disabled = false;
    for (const item of duplicateDraft) {
      const row = document.createElement("div");
      row.className = "duplicate-row";

      const text = document.createElement("div");
      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = item.duplicate.title;
      const url = document.createElement("div");
      url.className = "tab-url";
      url.textContent = item.duplicate.url;
      text.append(title, url);

      const tag = document.createElement("span");
      tag.className = "badge";
      tag.textContent = "重复";

      row.append(text, tag);
      list.appendChild(row);
    }
  }

  $("#duplicateDialog").showModal();
}

async function removeDuplicateCopies() {
  const duplicateIds = new Set(duplicateDraft.map(item => item.duplicate.id));
  for (const collection of state.collections) {
    collection.tabs = collection.tabs.filter(tab => !duplicateIds.has(tab.id));
  }
  state.todos = state.todos.filter(todo => !duplicateIds.has(todo.savedTabId));
  await saveState();
  duplicateDraft = [];
  $("#duplicateDialog").close();
  render();
  toast("重复副本已删除。");
}

async function handleContextMessage(message) {
  if (!message?.type || !message.tab) return;

  if (message.type === "CONTEXT_SAVE_TAB") {
    const collection = createSingleTabCollection(message.tab);
    await saveState();
    render();
    toast(`已创建标签合集「${collection.name}」。`);
  }

  if (message.type === "CONTEXT_ADD_TODO") {
    await addRawTabToTodo(message.tab, message.status || "today");
  }
}

function bindEvents() {
  $("#themeToggle").addEventListener("click", toggleTheme);

  $("#tabContextNewCollection").addEventListener("click", moveSingleTabToNewTimeCollection);
  document.addEventListener("click", (event) => {
    const menu = $("#tabContextMenu");
    if (!menu.classList.contains("hidden") && !menu.contains(event.target)) {
      hideTabContextMenu();
    }
  });
  window.addEventListener("blur", hideTabContextMenu);
  window.addEventListener("resize", hideTabContextMenu);
  document.addEventListener("scroll", hideTabContextMenu, true);
  $("#saveTabBtn").addEventListener("click", saveCurrentTab);
  $("#saveWindowBtn").addEventListener("click", () => saveWindow(false));
  $("#saveAllBtn").addEventListener("click", saveAllWindows);
  $("#saveCloseBtn").addEventListener("click", () => saveWindow(true));
  $("#addCollectionBtn").addEventListener("click", addCollection);
  $("#batchModeBtn").addEventListener("click", enterBatchMode);
  $("#showArchivedBtn").addEventListener("click", () => {
    showArchivedOnly = !showArchivedOnly;
    $("#showArchivedBtn").textContent = showArchivedOnly ? "返回当前" : "已归档";
    exitBatchMode();
    renderCollections();
  });
  $("#exitBatchBtn").addEventListener("click", exitBatchMode);
  $("#collectionSort").addEventListener("change", (event) => {
    collectionSort = event.target.value;
    renderCollections();
  });
  $("#selectAllVisibleBtn").addEventListener("click", () => {
    const ids = visibleCollectionIds();
    const allSelected = ids.length && ids.every(id => selectedCollectionIds.has(id));
    if (allSelected) {
      ids.forEach(id => selectedCollectionIds.delete(id));
    } else {
      ids.forEach(id => selectedCollectionIds.add(id));
    }
    updateBatchUi();
  });
  $("#batchTodayBtn").addEventListener("click", batchAddToToday);
  $("#batchDeleteBtn").addEventListener("click", batchDeleteCollections);
  $("#detailBackBtn").addEventListener("click", closeCollectionDetail);
  $("#detailOpenAllBtn").addEventListener("click", () => {
    const collection = getActiveCollection();
    if (collection) openCollection(collection);
  });
  $("#detailAddCurrentBtn").addEventListener("click", detailAddCurrentTab);
  $("#detailSelectModeBtn").addEventListener("click", () => {
    detailSelectMode = true;
    detailSelectedTabIds.clear();
    renderCollectionDetail();
  });
  $("#detailExitSelectBtn").addEventListener("click", () => {
    detailSelectMode = false;
    detailSelectedTabIds.clear();
    renderCollectionDetail();
  });
  $("#detailSelectAllBtn").addEventListener("click", () => {
    const collection = getActiveCollection();
    if (!collection) return;
    const allSelected = collection.tabs.length && collection.tabs.every(tab => detailSelectedTabIds.has(tab.id));
    detailSelectedTabIds = allSelected ? new Set() : new Set(collection.tabs.map(tab => tab.id));
    updateDetailBatchUi();
  });
  $("#detailOpenSelectedBtn").addEventListener("click", openSelectedDetailTabs);
  $("#detailMoveSelectedBtn").addEventListener("click", openMoveTabsDialog);
  $("#detailDeleteSelectedBtn").addEventListener("click", deleteSelectedDetailTabs);
  $("#detailMoreBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const collection = getActiveCollection();
    if (!collection) return;
    const host = $("#collectionDetailView");
    showCollectionMenu(host, collection);
  });

  $("#addCurrentToTodayBtn").addEventListener("click", () => addCurrentToTodo("today"));
  $("#searchInput").addEventListener("input", () => {
    if ($("#searchInput").value.trim() && batchMode) exitBatchMode();
    renderSearch();
  });
  $("#importBtn").addEventListener("click", () => $("#importInput").click());
  $("#importInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importBackupFile(file);
  });
  $("#exportBtn").addEventListener("click", exportBackup);

  $("#aiOrganizeBtn").addEventListener("click", () => {
    aiDraftGroups = [];
    $("#aiPreview").innerHTML = '<div class="muted">请选择整理来源，然后生成建议。</div>';
    $("#aiNameSuggestion").classList.add("hidden");
    $("#aiApplyBtn").disabled = true;
    $("#aiDialog").showModal();
  });
  $("#aiPreviewBtn").addEventListener("click", generateAiSuggestions);
  $("#aiSmartNameBtn").addEventListener("click", suggestWorkspaceName);
  $("#aiApplyBtn").addEventListener("click", applyAiGroups);

  $("#dedupeBtn").addEventListener("click", openDuplicateDialog);
  $("#removeDuplicatesBtn").addEventListener("click", removeDuplicateCopies);

  $$(".nav-tab").forEach(btn =>
    btn.addEventListener("click", () => switchView(btn.dataset.view))
  );

  $("#notesInput").addEventListener("input", () => {
    clearTimeout(notesTimer);
    $("#notesStatus").textContent = "保存中…";
    notesTimer = setTimeout(async () => {
      state.notes = $("#notesInput").value;
      await saveState();
      $("#notesStatus").textContent = "已保存";
      setTimeout(() => $("#notesStatus").textContent = "", 1200);
    }, 350);
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STATE_CHANGED") {
      loadState().then(() => {
        renderNotes();
        render();
      });
      return;
    }

    handleContextMessage(message);
  });
}

async function init() {
  await loadState();
  applyTheme();
  bindEvents();
  renderNotes();
  render();
}

init();
