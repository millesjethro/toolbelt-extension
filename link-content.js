(() => {
  const HOST_ID = "link-shower-tip";
  const DEFAULTS = { mode: "hold", keyK: "Shift", keyLabel: "Shift", accent: "#FFD93D", externalOnly: false, preview: true, previewStyle: "auto", enabled: true };
  let settings = { ...DEFAULTS };
  let hovered = null, held = false, tapOn = false, mx = -1, my = -1, raf = 0;
  let host = null, tip = null, originEl = null, restEl = null, prevEl = null, statusEl = null;
  let prevFrame = null, cardEl = null, prevFor = "", prevTimer = 0, failTimer = 0;
  const BLOCKED = /(^|\.)(facebook\.com|fb\.com|fb\.watch|instagram\.com)$/i;

  const norm = (k) => (k && k.length === 1 ? k.toLowerCase() : k);

  chrome.storage.local.get({ linkShower: DEFAULTS }, (s) => { settings = { ...DEFAULTS, ...s.linkShower }; applyAccent(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.linkShower) return;
    settings = { ...DEFAULTS, ...changes.linkShower.newValue };
    held = false; tapOn = false;
    applyAccent(); clearPreview(); refresh();
  });

  function applyAccent() { if (originEl) originEl.style.color = settings.accent; }

  function isRealLink(a) {
    const raw = a.getAttribute("href");
    return !!raw && raw.trim() !== "" && !raw.trim().startsWith("#");
  }
  function isExternal(a) { return /^https?:$/.test(a.protocol) && a.hostname !== location.hostname; }
  function isTyping(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }

  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  function findLink(el) {
    while (el) {
      if (el.matches && el.matches("a[href]")) return el;
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return null;
  }

  function ensureTip() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .tip { position: fixed; display: none; max-width: min(440px, 90vw);
        background: #12141A; color: #F2F3F5; border: 1px solid #2A2E39; border-radius: 10px;
        padding: 8px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
        font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
      .origin { font-weight: 700; }
      .rest { color: #C9CED8; }
      .prev { display: none; position: relative; width: 400px; height: 250px; max-width: 100%;
        margin-top: 8px; border-radius: 8px; overflow: hidden; background: #1C1F27; }
      .prev iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
      .prev.card { height: auto; min-height: 64px; }
      .card-body { display: flex; flex-direction: column; font-family: system-ui, sans-serif; }
      .card-img { width: 100%; height: 160px; object-fit: cover; display: block; background: #2A2E39; }
      .card-text { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 4px; word-break: normal; }
      .card-site { font: 700 11px system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #A3A9B5; }
      .card-title { font: 700 14px/1.3 system-ui, sans-serif; color: #F2F3F5; }
      .card-desc { font: 500 12px/1.4 system-ui, sans-serif; color: #C9CED8; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #A3A9B5; font: 500 12px system-ui, sans-serif; text-align: center; padding: 12px; }`;
    tip = document.createElement("div");
    tip.className = "tip";
    originEl = document.createElement("span");
    originEl.className = "origin";
    restEl = document.createElement("span");
    restEl.className = "rest";
    const line = document.createElement("div");
    line.append(originEl, restEl);
    prevEl = document.createElement("div");
    prevEl.className = "prev";
    statusEl = document.createElement("div");
    statusEl.className = "status";
    prevEl.append(statusEl);
    tip.append(line, prevEl);
    root.append(style, tip);
    document.documentElement.appendChild(host);
    applyAccent();
  }

  function fill(a) {
    let origin = "", rest = "";
    try {
      const u = new URL(a.href);
      if (u.origin && u.origin !== "null") {
        origin = u.origin;
        rest = u.pathname + u.search + u.hash;
        if (rest === "/") rest = "";
      } else {
        origin = u.protocol;
        rest = a.href.slice(u.protocol.length);
      }
    } catch (e) { origin = a.getAttribute("href"); }
    originEl.textContent = origin;
    restEl.textContent = rest;
  }

  /* ---- page preview ---- */
  function clearPreview() {
    clearTimeout(prevTimer); clearTimeout(failTimer);
    if (prevFrame) { prevFrame.remove(); prevFrame = null; }
    if (cardEl) { cardEl.remove(); cardEl = null; }
    prevFor = "";
    if (prevEl) { prevEl.style.display = "none"; prevEl.classList.remove("card"); }
  }
  function showPreview(a) {
    if (!settings.preview || !/^https?:$/.test(a.protocol)) { clearPreview(); return; }
    prevEl.style.display = "block";
    if (prevFor === a.href) return;
    clearPreview();
    prevFor = a.href;
    prevEl.style.display = "block";
    statusEl.style.display = "flex";
    statusEl.textContent = "Loading preview…";
    const useCard = settings.previewStyle === "card" || (settings.previewStyle !== "page" && BLOCKED.test(a.hostname));
    if (useCard) prevEl.classList.add("card");
    const url = a.href;
    prevTimer = setTimeout(() => {
      if (useCard) { loadCard(url); return; }
      prevFrame = document.createElement("iframe");
      prevFrame.src = chrome.runtime.getURL("preview.html") + "?u=" + encodeURIComponent(url);
      prevFrame.setAttribute("tabindex", "-1");
      prevEl.insertBefore(prevFrame, statusEl);
      failTimer = setTimeout(() => { statusEl.textContent = "Preview unavailable on this site"; }, 2500);
    }, 350);
  }
  function loadCard(url) {
    chrome.runtime.sendMessage({ type: "linkShower:unfurl", url }, (r) => {
      if (prevFor !== url) return;
      if (chrome.runtime.lastError) { statusEl.textContent = "Preview unavailable"; return; }
      renderCard(r);
    });
  }
  function renderCard(r) {
    if (!r || !(r.title || r.desc || r.image)) {
      statusEl.style.display = "flex";
      statusEl.textContent = "No preview available. The site may need a login.";
      return;
    }
    statusEl.style.display = "none";
    cardEl = document.createElement("div");
    cardEl.className = "card-body";
    if (r.image) {
      const img = document.createElement("img");
      img.className = "card-img";
      img.src = r.image;
      cardEl.append(img);
    }
    const text = document.createElement("div");
    text.className = "card-text";
    const add = (cls, val) => { if (!val) return; const d = document.createElement("div"); d.className = cls; d.textContent = val; text.append(d); };
    add("card-site", r.site);
    add("card-title", r.title);
    add("card-desc", r.desc);
    cardEl.append(text);
    prevEl.insertBefore(cardEl, statusEl);
  }
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!prevFrame || e.source !== prevFrame.contentWindow || !d || !d.linkShower) return;
    if (d.linkShower === "loaded") { clearTimeout(failTimer); statusEl.style.display = "none"; }
  });

  function place(x, y) {
    tip.style.display = "block";
    const w = tip.offsetWidth, h = tip.offsetHeight, pad = 12;
    let left = x + 14, top = y + 20;
    if (left + w + pad > window.innerWidth) left = Math.max(pad, x - w - 14);
    if (top + h + pad > window.innerHeight) top = Math.max(pad, y - h - 14);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; clearPreview(); }

  function wantShow() {
    if (!settings.enabled || !hovered) return false;
    if (settings.mode === "always") return true;
    if (settings.mode === "hold") return held;
    return tapOn;
  }
  function update() {
    if (wantShow()) { ensureTip(); fill(hovered); showPreview(hovered); place(mx, my); }
    else hideTip();
  }

  function refresh() {
    let next = null;
    if (mx >= 0 && my >= 0) {
      const a = findLink(deepElementAt(mx, my));
      if (a && isRealLink(a) && !(settings.externalOnly && !isExternal(a))) next = a;
    }
    if (next !== hovered) tapOn = false;
    hovered = next;
    update();
  }

  function onMove(e) {
    mx = e.clientX; my = e.clientY;
    if (tip && tip.style.display === "block") place(mx, my);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); });
  }
  function onKeyDown(e) {
    if (e.key === "Escape") { held = false; tapOn = false; hovered = null; hideTip(); return; }
    if (e.repeat || norm(e.key) !== norm(settings.keyK)) return;
    if (isTyping(e.composedPath()[0])) return;
    refresh();
    if (settings.mode === "hold") held = true;
    else if (settings.mode === "tap" && hovered) tapOn = !tapOn;
    update();
  }
  function onKeyUp(e) {
    if (norm(e.key) !== norm(settings.keyK)) return;
    if (settings.mode === "hold") { held = false; update(); }
  }

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("scroll", () => refresh(), true);
  window.addEventListener("blur", () => { held = false; tapOn = false; hideTip(); });
  document.documentElement.addEventListener("mouseleave", () => { mx = my = -1; hovered = null; tapOn = false; update(); });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg && msg.type === "linkShower:count") {
      let internal = 0, external = 0;
      document.querySelectorAll("a[href]").forEach((a) => {
        if (!isRealLink(a)) return;
        isExternal(a) ? external++ : internal++;
      });
      reply({ total: internal + external, internal, external });
    }
  });
})();
