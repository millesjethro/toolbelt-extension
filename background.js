importScripts("link-background.js");
// =============================================================
// Toolbelt — merged background service worker
// Combines: Click to Translate + Item Counter + Meta Scraper
// Routing is by msg.action, so each tool's messages stay isolated.
// =============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    // ---- Click to Translate ----
    case "translateText":
      // fast:true = batched whole-page/element requests from content.js, which
      // does its own concurrency control; they skip the one-at-a-time queue.
      (msg.fast ? translateWithRetry(msg.text, msg.lang) : enqueueTranslate(msg.text, msg.lang))
        .then((translated) => sendResponse({ ok: true, translated }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep the message channel open for the async response

    // ---- Item Counter (Items tab) ----
    case "scanItems":
      runItemScanOnActiveTab()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "scanFacebookPosts":
      runFacebookPostsScanOnActiveTab(msg.maxPosts)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    // ---- Width tab ----
    case "setPageWidth":
      setPageWidthOnActiveTab(msg.width)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "resetPageWidth":
      resetPageWidthOnActiveTab()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    // ---- Meta Scraper (Source tab) ----
    case "backup-source":
    case "save-source-file":
      handleSourceAction(msg.action).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    default:
      return false;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "backup-source" || command === "save-source-file") {
    handleSourceAction(command).catch(console.error);
  } else if (command === "toggle-delete-single") {
    handleToggleDeleteShortcut();
  } else if (command === "scan-items") {
    handleScanItemsShortcut();
  }
});

// -------------------------------------------------------------
// Click to Translate — translation request queue
//
// Every translate request — from any tab, any mode (single element, area,
// whole page) — funnels through this one queue. That's deliberate: the free
// translate endpoint rate-limits (HTTP 429) under bursts, and per-call
// concurrency limits in content.js don't help with that because they don't
// know about each other. Serializing everything here, with a gap that grows
// when we get rate-limited and eases back down when we don't, is what
// actually keeps requests under the limit.
// -------------------------------------------------------------

async function translate(text, lang) {
  const base = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
    lang
  )}&dt=t`;
  let res;
  if (text.length > 1200) {
    // Batched requests carry many text nodes at once — too long for a GET URL.
    res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "q=" + encodeURIComponent(text),
    });
  } else {
    res = await fetch(base + "&q=" + encodeURIComponent(text));
  }
  if (!res.ok) throw new Error("Translate request failed: " + res.status);
  const data = await res.json();
  return data[0].map((chunk) => chunk[0]).join("");
}

// Used for batched requests: no shared queue, just retry with backoff on 429.
async function translateWithRetry(text, lang) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await translate(text, lang);
    } catch (err) {
      lastErr = err;
      if (!/429/.test(err.message)) break;
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt) + Math.random() * 300));
    }
  }
  throw lastErr || new Error("Translation failed");
}

const requestQueue = [];
let queueRunning = false;
let gapMs = 150;
const MIN_GAP_MS = 150;
const MAX_GAP_MS = 4000;
const MAX_ATTEMPTS = 4;

function enqueueTranslate(text, lang) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ text, lang, resolve, reject });
    runQueue();
  });
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (requestQueue.length > 0) {
    const { text, lang, resolve, reject } = requestQueue.shift();
    let lastErr = null;
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
      try {
        const result = await translate(text, lang);
        resolve(result);
        gapMs = Math.max(MIN_GAP_MS, gapMs * 0.85); // ease the pacing back down on success
        done = true;
      } catch (err) {
        lastErr = err;
        const isRateLimited = /429/.test(err.message);
        if (isRateLimited) {
          gapMs = Math.min(MAX_GAP_MS, gapMs * 2);
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, gapMs));
          }
        } else {
          break; // non-rate-limit errors (network, etc.) aren't worth retrying here
        }
      }
    }
    if (!done) reject(lastErr || new Error("Translation failed"));
    if (requestQueue.length > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
  queueRunning = false;
}

// -------------------------------------------------------------
// Delete Mode keyboard shortcut
//
// Delete's own controls live inline in the popup (see popup.js), which
// works because toggling delete mode is a one-time message to the content
// script — deleting keeps working on the page whether or not the popup is
// open. The shortcut does exactly what the popup's "Single delete" button
// does, then shows an on-page toast since there's no popup UI to reflect
// the new state back to you.
// -------------------------------------------------------------

function handleToggleDeleteShortcut() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { action: "toggleDeleteSingle" }, (state) => {
      if (chrome.runtime.lastError || !state) return;
      const message = state.deleteMode === "single"
        ? "Single Delete ON — click an element to remove it"
        : "Single Delete OFF";
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showNotification,
        args: [message],
      });
    });
  });
}

// -------------------------------------------------------------
// Item Counter (Items tab)
//
// Shared by the popup's "Scan this page" button (via the "scanItems"
// message) and the scan keyboard shortcut, so the scanning logic lives in
// one place instead of being duplicated between popup.js and here.
// -------------------------------------------------------------

async function collectPinCounts() {
  async function autoScroll() {
    let lastHeight = -1;
    let stableRounds = 0;
    const maxRounds = 60;
    for (let i = 0; i < maxRounds && stableRounds < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 650));
      const h = document.body.scrollHeight;
      if (h === lastHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastHeight = h;
      }
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  }

  await autoScroll();

  const pins = [...document.querySelectorAll("*")]
    .filter((el) =>
      [...el.childNodes].some(
        (n) => n.nodeType === 3 && /\bPins?\b/i.test(n.textContent)
      )
    )
    .map((el) => {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ");
      return {
        text,
        count: text.match(/["']?(\d+)["']?\s*["']?Pins?\b["']?/i)?.[1],
      };
    })
    .filter((x) => x.count)
    .map((x) => ({ ...x, count: Number(x.count) }));

  const total = pins.reduce((sum, x) => sum + x.count, 0);
  return { mode: "pinterest", items: pins, total, url: location.href, title: document.title };
}

async function collectFacebookReels() {
  async function autoScroll() {
    let lastHeight = -1;
    let stableRounds = 0;
    const maxRounds = 60;
    for (let i = 0; i < maxRounds && stableRounds < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 650));
      const h = document.body.scrollHeight;
      if (h === lastHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastHeight = h;
      }
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  }

  await autoScroll();

  const seenHref = new Set();
  const reels = [...document.querySelectorAll('a[href*="/reel/"]')]
    .map((link) => {
      const img = link.querySelector("img");
      return {
        text: (img?.getAttribute("alt") || link.href || "").trim(),
        href: link.href,
        src: img?.src || null,
      };
    })
    .filter((r) => r.src)
    .filter((r) => {
      if (seenHref.has(r.href)) return false;
      seenHref.add(r.href);
      return true;
    })
    .map((r) => ({ text: r.text || r.href, count: 1 }));

  const total = reels.length;
  return { mode: "facebook-reels", items: reels, total, url: location.href, title: document.title };
}

async function collectFacebookPhotos() {
  async function autoScroll() {
    let lastHeight = -1;
    let stableRounds = 0;
    const maxRounds = 60;
    for (let i = 0; i < maxRounds && stableRounds < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 650));
      const h = document.body.scrollHeight;
      if (h === lastHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastHeight = h;
      }
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  }

  await autoScroll();

  const seenHref = new Set();
  const photos = [...document.querySelectorAll('a[href*="/photo"]')]
    .map((link) => {
      const img = link.querySelector("img");
      return {
        text: (img?.getAttribute("alt") || link.href || "").trim(),
        href: link.href,
        src: img?.src || null,
      };
    })
    .filter((p) => p.src)
    .filter((p) => {
      if (seenHref.has(p.href)) return false;
      seenHref.add(p.href);
      return true;
    })
    .map((p) => ({ text: p.text || p.href, count: 1 }));

  const total = photos.length;
  return { mode: "facebook", items: photos, total, url: location.href, title: document.title };
}

// Facebook's own feed selectors are auto-generated, atomic CSS class names
// (e.g. "x1yztbdb") that Facebook regenerates whenever they ship a new
// build — this selector can and eventually will stop matching and need
// updating here if that happens. Kept inline (rather than as a shared
// constant) because this function is injected into the page via
// chrome.scripting.executeScript and can't close over anything outside it.
async function collectFacebookPosts(maxPosts) {
  const selector = "div.x1yztbdb.x1n2onr6.xh8yej3.x1ja2u2z";
  const cap = Math.max(1, parseInt(maxPosts, 10) || 300);
  let lastCount = -1;
  let stableRounds = 0;
  const maxRounds = Math.min(2000, Math.max(120, cap)); // safety ceiling on scroll iterations

  for (let i = 0; i < maxRounds && stableRounds < 3; i++) {
    const count = document.querySelectorAll(selector).length;
    if (count >= cap) break; // stop scrolling once we've hit the cap — Facebook's feed never truly ends
    if (count === lastCount) {
      stableRounds++; // nothing new loaded — probably hit the end of what's available
    } else {
      stableRounds = 0;
      lastCount = count;
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 650));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));

  const actualCount = document.querySelectorAll(selector).length;
  const total = Math.min(actualCount, cap);
  return {
    mode: "facebook-posts",
    items: [],
    total,
    hitCap: actualCount >= cap,
    url: location.href,
    title: document.title,
  };
}

function detectItemScanMode(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)pinterest\.[a-z.]+$/i.test(host)) return "pinterest";
    if (/(^|\.)facebook\.com$/i.test(host)) {
      return /\/reels?(\/|$|\?)/i.test(url) ? "facebook-reels" : "facebook";
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function runItemScanOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    return { ok: false, error: "No active tab found." };
  }

  const mode = detectItemScanMode(tab.url);
  if (!mode) {
    return { ok: false, error: "Open a Pinterest or Facebook tab, then scan." };
  }

  const func =
    mode === "facebook-reels"
      ? collectFacebookReels
      : mode === "facebook"
      ? collectFacebookPhotos
      : collectPinCounts;

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
    });
    const result = injection?.result;
    if (!result) {
      return { ok: false, error: "Could not read the page." };
    }
    return { ok: true, result, tabTitle: tab.title };
  } catch (err) {
    const msg = /Cannot access/i.test(err.message)
      ? "Cannot scan this page. Open a Pinterest or Facebook tab and try again."
      : "Something went wrong: " + err.message;
    return { ok: false, error: msg };
  }
}

async function runFacebookPostsScanOnActiveTab(maxPosts) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    return { ok: false, error: "No active tab found." };
  }
  try {
    const host = new URL(tab.url).hostname;
    if (!/(^|\.)facebook\.com$/i.test(host)) {
      return { ok: false, error: "Open a Facebook tab, then count posts." };
    }
  } catch (e) {
    return { ok: false, error: "No active tab found." };
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectFacebookPosts,
      args: [maxPosts],
    });
    const result = injection?.result;
    if (!result) {
      return { ok: false, error: "Could not read the page." };
    }
    return { ok: true, result, tabTitle: tab.title };
  } catch (err) {
    const msg = /Cannot access/i.test(err.message)
      ? "Cannot scan this page. Open a Facebook tab and try again."
      : "Something went wrong: " + err.message;
    return { ok: false, error: msg };
  }
}

function scanSummaryMessage(res) {
  if (!res.ok) return res.error;
  const { result } = res;
  if (result.mode === "facebook-posts") {
    return result.hitCap
      ? `Scanned: ${result.total.toLocaleString()}+ posts (reached your max)`
      : `Scanned: ${result.total.toLocaleString()} post${result.total === 1 ? "" : "s"} found`;
  }
  if (!result.items.length) return "Scanned — nothing found on this page.";
  const isFacebookPhotos = result.mode === "facebook";
  const isFacebookReels = result.mode === "facebook-reels";
  const noun = isFacebookPhotos ? "photo" : isFacebookReels ? "reel" : "Pin";
  return `Scanned: ${result.total.toLocaleString()} ${noun}${result.total === 1 ? "" : "s"} found`;
}

async function handleScanItemsShortcut() {
  const res = await runItemScanOnActiveTab();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: showNotification,
    args: [scanSummaryMessage(res)],
  });
}

// -------------------------------------------------------------
// Width tab — caps the page to a centered column at a user-chosen width.
// Applies only to the active tab's current DOM; a reload reverts it, or
// Reset removes the override without needing a reload.
// -------------------------------------------------------------

function applyPageWidth(px) {
  if (!document.body) throw new Error("Page has no body");
  const key = "__toolbeltWidthOriginal";
  if (!document.body.hasAttribute(key)) {
    document.body.setAttribute(key, JSON.stringify(["max-width", "margin-left", "margin-right"].map(name =>
      [name, document.body.style.getPropertyValue(name), document.body.style.getPropertyPriority(name)])));
  }
  document.body.style.setProperty("max-width", px + "px");
  document.body.style.setProperty("margin-left", "auto");
  document.body.style.setProperty("margin-right", "auto");
}

function resetPageWidth() {
  const key = "__toolbeltWidthOriginal";
  const saved = document.body?.getAttribute(key);
  if (!saved) return;
  for (const [name, value, priority] of JSON.parse(saved)) {
    if (value) document.body.style.setProperty(name, value, priority);
    else document.body.style.removeProperty(name);
  }
  document.body.removeAttribute(key);
}

async function setPageWidthOnActiveTab(px) {
  if (!Number.isInteger(px) || px < 200 || px > 10000) return { ok: false, error: "Enter a width from 200 to 10000px." };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "No active tab found." };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyPageWidth,
      args: [px],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Can't adjust width on this page." };
  }
}

async function resetPageWidthOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "No active tab found." };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: resetPageWidth,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Can't adjust width on this page." };
  }
}

// -------------------------------------------------------------
// Source tab (formerly "Meta Scraper")
//
// Copies or saves the page source exactly as-is. If the source contains
// "Philippines" or a ".ph" domain/suffix, a warning toast is shown (nothing is
// removed). ".php" and other longer words don't count — only a standalone
// ".ph" does. See getRawSource() below.
// -------------------------------------------------------------

async function handleSourceAction(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab found." };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: getRawSource });
    const result = injection?.result;
    if (!result || result.error) throw new Error(result?.error || "Could not read source.");
    const { text: source, philippines, ph } = result;
    const warning = buildPhWarning(philippines, ph);
    if (action === "backup-source") {
      const [copy] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: copyTextToClipboard, args: [source] });
      if (!copy?.result) throw new Error("Clipboard access was denied. Try Save source instead.");
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showNotification, args: ["Source code copied to clipboard"] });
    } else {
      await saveToFile(source, tab.title);
    }
    showPhWarning(tab.id, warning);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message || "Cannot access this page." }; }
}

async function getRawSource() {
  try {
    const res = await fetch(window.location.href, { credentials: "include" });
    if (!res.ok) throw new Error("Source request failed: " + res.status);
    const text = await res.text();
    // \b after "ph" means ".php", ".photo", etc. do NOT count — only a standalone ".ph".
    const ph = (text.match(/\.ph\b/gi) || []).length;
    const philippines = (text.match(/\bphilippines?\b/gi) || []).length;
    return { text, philippines, ph };
  } catch (err) {
    console.error("Failed to fetch source:", err);
    return { error: err.message || "Could not fetch page source." };
  }
}

function buildPhWarning(philippines, ph) {
  const found = [];
  if (philippines) found.push(`"Philippines" ×${philippines}`);
  if (ph) found.push(`".ph" ×${ph}`);
  return found.length ? `⚠ Found in copied source: ${found.join(", ")}` : null;
}

function showPhWarning(tabId, warning) {
  if (!warning) return;
  chrome.scripting.executeScript({
    target: { tabId },
    func: showNotification,
    args: [warning, true],
  });
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("Modern clipboard failed, using fallback.", err);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try { return document.execCommand("copy"); } finally { textarea.remove(); }
  }
}

async function saveToFile(source, tabTitle) {
  const safeName = (tabTitle || "untitled").replace(/[^a-z0-9]/gi, "_").toLowerCase().slice(0, 120);
  await chrome.downloads.download({
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(source),
    filename: "backup_" + safeName + ".txt", conflictAction: "uniquify", saveAs: false,
  });
}

function showNotification(message, isWarning) {
  // Each call injects this function fresh (no shared JS state between calls),
  // but the DOM does persist — so toasts stack by finding/reusing a shared
  // container div rather than each one owning its own fixed position. That
  // way back-to-back copies pile up top-to-bottom instead of overwriting the
  // same spot, so you can actually tell a new one landed.
  let container = document.getElementById("__ts-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "__ts-toast-container";
    Object.assign(container.style, {
      position: "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "8px",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    document.body.appendChild(container);
  }

  const el = document.createElement("div");
  el.textContent = message;
  Object.assign(el.style, {
    backgroundColor: isWarning ? "#b45309" : "#333333",
    color: "#ffffff",
    padding: "12px 24px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
    fontWeight: "bold",
    opacity: "0",
    transition: "opacity 0.3s ease-in-out",
  });
  container.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => {
      el.remove();
      if (container.children.length === 0) container.remove();
    }, 300);
  }, isWarning ? 7000 : 3000);
}
