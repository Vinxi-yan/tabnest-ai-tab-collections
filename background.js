const STORAGE_KEY = "tabnest_state_v3";
const LEGACY_STORAGE_KEYS = ["tabnest_state_v2", "tabnest_state_v1"];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTimeCollectionName(date = new Date()) {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function uniqueTimeCollectionName(state) {
  const base = formatTimeCollectionName();
  const names = new Set(state.collections.map(c => c.name));
  if (!names.has(base)) return base;

  let i = 2;
  while (names.has(`${base}（${i}）`)) i += 1;
  return `${base}（${i}）`;
}

function createContextCollection(state, tab) {
  const collection = {
    id: crypto.randomUUID(),
    name: uniqueTimeCollectionName(state),
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    tabs: [makeSavedTab(tab)]
  };
  state.collections.unshift(collection);
  return collection;
}

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("Failed to configure side panel:", error);
  }
}

async function setupMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: "tabnest-save-tab",
    title: "保存为新的时间合集",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "tabnest-todo-today",
    title: "添加到「今天」",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "tabnest-todo-later",
    title: "添加到「稍后」",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "tabnest-move-parent",
    title: "保存 / 移动到标签合集",
    contexts: ["page"]
  });

  const state = await getState();
  const targets = [...state.collections]
    .filter(collection => !collection.archived)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 20);

  if (!targets.length) {
    chrome.contextMenus.create({
      id: "tabnest-move-empty",
      parentId: "tabnest-move-parent",
      title: "暂无标签合集",
      contexts: ["page"],
      enabled: false
    });
  } else {
    for (const collection of targets) {
      chrome.contextMenus.create({
        id: `tabnest-move-to:${collection.id}`,
        parentId: "tabnest-move-parent",
        title: collection.name,
        contexts: ["page"]
      });
    }
  }
}

function makeSavedTab(tab) {
  return {
    id: crypto.randomUUID(),
    title: tab.title || tab.url || "未命名标签",
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned),
    createdAt: Date.now()
  };
}

async function getState() {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  const result = await chrome.storage.local.get(keys);

  const state = result[STORAGE_KEY]
    || LEGACY_STORAGE_KEYS.map(key => result[key]).find(Boolean)
    || {
      version: 8,
      theme: "system",
      notes: "",
      collections: [],
      sessions: [],
      todos: []
    };

  state.version = 8;
  state.collections ||= [];
  state.sessions ||= [];
  state.todos ||= [];
  state.collections = state.collections.map(collection => ({
    archived: false,
    ...collection
  }));

  const legacy = state.collections.filter(
    collection => String(collection.name || "").trim() === "收件箱"
  );

  for (const inbox of legacy) {
    if (!Array.isArray(inbox.tabs) || inbox.tabs.length === 0) {
      state.collections = state.collections.filter(collection => collection.id !== inbox.id);
      continue;
    }

    const base = formatTimeCollectionName(new Date(inbox.createdAt || Date.now()));
    const names = new Set(
      state.collections
        .filter(collection => collection.id !== inbox.id)
        .map(collection => collection.name)
    );

    let name = base;
    let index = 2;
    while (names.has(name)) {
      name = `${base}（${index}）`;
      index += 1;
    }

    inbox.name = name;
    inbox.pinned = false;
  }

  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED" }).catch(() => {});
}



function findSavedByUrl(state, url) {
  for (const collection of state.collections) {
    const tab = collection.tabs.find(t => t.url === url);
    if (tab) return tab;
  }
  return null;
}

async function savePageFromContext(tab) {
  const state = await getState();
  createContextCollection(state, tab);
  await saveState(state);
}

async function addPageToTodoFromContext(tab, status) {
  const state = await getState();
  let saved = findSavedByUrl(state, tab.url);

  if (!saved) {
    const collection = createContextCollection(state, tab);
    saved = collection.tabs[0];
  }

  const existingTodo = state.todos.find(t => t.savedTabId === saved.id);
  if (existingTodo) {
    existingTodo.status = status;
    existingTodo.updatedAt = Date.now();
  } else {
    state.todos.unshift({
      id: crypto.randomUUID(),
      savedTabId: saved.id,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  await saveState(state);
}


async function savePageToExistingCollection(tab, collectionId) {
  const state = await getState();
  const target = state.collections.find(c => c.id === collectionId && !c.archived);

  if (!target) {
    createContextCollection(state, tab);
    await saveState(state);
    return;
  }

  const existingGlobal = findSavedByUrl(state, tab.url);
  if (existingGlobal) {
    for (const collection of state.collections) {
      collection.tabs = collection.tabs.filter(saved => saved.id !== existingGlobal.id);
    }
    if (!target.tabs.some(saved => saved.url === existingGlobal.url)) {
      target.tabs.push(existingGlobal);
    }
  } else if (!target.tabs.some(saved => saved.url === tab.url)) {
    target.tabs.push(makeSavedTab(tab));
  }

  state.collections = state.collections.filter(collection => collection.pinned || collection.tabs.length > 0);
  await saveState(state);
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
  setupMenus();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
  setupMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url) return;

  if (info.menuItemId === "tabnest-save-tab") {
    await savePageFromContext(tab);
  } else if (info.menuItemId === "tabnest-todo-today") {
    await addPageToTodoFromContext(tab, "today");
  } else if (info.menuItemId === "tabnest-todo-later") {
    await addPageToTodoFromContext(tab, "later");
  } else if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("tabnest-move-to:")) {
    const collectionId = info.menuItemId.slice("tabnest-move-to:".length);
    await savePageToExistingCollection(tab, collectionId);
  }
});

configureSidePanel();


chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    setupMenus().catch(console.error);
  }
});
