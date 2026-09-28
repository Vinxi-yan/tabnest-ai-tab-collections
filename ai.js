/**
 * TabNest local organizer
 *
 * This is intentionally local-first. It classifies tabs by title + hostname only.
 * No page body/content is read and nothing is sent to a server.
 *
 * Later, replace `LocalSmartOrganizer` with a remote provider behind your own backend.
 */

const CATEGORY_RULES = [
  {
    name: "AI 与开发",
    keywords: [
      "openai", "chatgpt", "claude", "anthropic", "github", "gitlab", "npm",
      "developer", "docs", "api", "sdk", "mcp", "huggingface", "vercel",
      "localhost", "stack overflow", "stackoverflow"
    ]
  },
  {
    name: "设计",
    keywords: [
      "figma", "dribbble", "behance", "design", "canva", "adobe",
      "framer", "sketch", "icon", "font"
    ]
  },
  {
    name: "研究与阅读",
    keywords: [
      "wikipedia", "medium", "substack", "arxiv", "paper", "research",
      "article", "blog", "news", "report"
    ]
  },
  {
    name: "工作与文档",
    keywords: [
      "notion", "docs.google", "drive.google", "sheets.google", "slides.google",
      "office", "sharepoint", "slack", "teams", "linear", "jira", "trello",
      "asana"
    ]
  },
  {
    name: "社交与内容",
    keywords: [
      "youtube", "youtu.be", "xiaohongshu", "xhs", "douyin", "tiktok",
      "instagram", "twitter", "x.com", "linkedin", "reddit", "bilibili"
    ]
  },
  {
    name: "购物",
    keywords: [
      "amazon", "taobao", "tmall", "jd.com", "shop", "store", "ebay",
      "etsy", "product"
    ]
  },
  {
    name: "金融",
    keywords: [
      "bank", "finance", "invest", "stock", "market", "trading", "broker",
      "crypto", "coinbase"
    ]
  }
];

function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function hostnameOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function tokenize(title = "", url = "") {
  const host = hostnameOf(url);
  const text = normalizeText(`${title} ${host} ${url}`);
  return text
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map(t => t.trim())
    .filter(t => t.length > 1);
}

class LocalSmartOrganizer {
  classify(tab) {
    const haystack = normalizeText(`${tab.title || ""} ${hostnameOf(tab.url)} ${tab.url || ""}`);

    let best = { name: "参考资料", score: 0 };
    for (const category of CATEGORY_RULES) {
      let score = 0;
      for (const keyword of category.keywords) {
        if (haystack.includes(keyword)) score += keyword.length >= 6 ? 3 : 2;
      }
      if (score > best.score) best = { name: category.name, score };
    }

    if (best.score > 0) {
      return { collectionName: best.name, confidence: Math.min(0.98, 0.58 + best.score * 0.06) };
    }

    const host = hostnameOf(tab.url);
    if (host) {
      const base = host.split(".").slice(-2, -1)[0] || host.split(".")[0] || "参考资料";
      const name = base.charAt(0).toUpperCase() + base.slice(1);
      return { collectionName: name, confidence: 0.48 };
    }

    return { collectionName: "参考资料", confidence: 0.35 };
  }

  group(tabs) {
    const groups = new Map();

    for (const tab of tabs) {
      const classification = this.classify(tab);
      if (!groups.has(classification.collectionName)) {
        groups.set(classification.collectionName, {
          name: classification.collectionName,
          tabs: [],
          confidenceSum: 0
        });
      }
      const group = groups.get(classification.collectionName);
      group.tabs.push(tab);
      group.confidenceSum += classification.confidence;
    }

    return [...groups.values()]
      .map(group => ({
        name: group.name,
        tabs: group.tabs,
        confidence: group.tabs.length
          ? group.confidenceSum / group.tabs.length
          : 0
      }))
      .sort((a, b) => b.tabs.length - a.tabs.length || b.confidence - a.confidence);
  }

  dedupe(tabs) {
    const seen = new Map();
    const unique = [];
    const duplicates = [];

    for (const tab of tabs) {
      const key = normalizeText(tab.url || "");
      if (!key) continue;
      if (seen.has(key)) {
        duplicates.push({ duplicate: tab, original: seen.get(key) });
      } else {
        seen.set(key, tab);
        unique.push(tab);
      }
    }

    return { unique, duplicates };
  }

  smartName(tabs) {
    if (!tabs.length) return "未命名工作区";
    const groups = this.group(tabs);
    if (groups[0] && groups[0].tabs.length / tabs.length >= 0.5) return groups[0].name;

    const tokenCounts = new Map();
    for (const tab of tabs) {
      for (const token of tokenize(tab.title, tab.url)) {
        if (token.length < 3) continue;
        tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
      }
    }

    const top = [...tokenCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .find(([token, count]) => count >= 2 && !["https", "www", "com", "html"].includes(token));

    return top ? `${top[0].charAt(0).toUpperCase()}${top[0].slice(1)} 工作区` : "综合工作区";
  }
}

window.LocalSmartOrganizer = LocalSmartOrganizer;
