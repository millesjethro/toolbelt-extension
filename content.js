(function () {
  if (window.__ctInjected) return;
  window.__ctInjected = true;

  let lastLang = "en";
  chrome.storage &&
    chrome.storage.local.get(["lastLang"], (res) => {
      if (res && res.lastLang) lastLang = res.lastLang;
    });

  let active = false;
  let hoverEl = null;
  let translateMode = false; // false | "single" | "group" — click-to-translate, instant
  let deleteMode = false; // false | "single" | "group"
  let excludeMode = false; // false | "single" | "group"
  let editMode = false; // click text to edit it in place (fix a translation by typing)
  let editingEl = null;
  let areaMode = false; // Area Translate: drag-select text, translate the selection
  const deletedStack = []; // batches of {el, parent, next}, most recent last
  const excludedEls = new Set();
  let reapplyIntervalId = null;

  const HOVER_CLASS = "__ct-hover";
  const HOVER_CLASS_DELETE = "__ct-hover-delete";
  const HOVER_CLASS_EXCLUDE = "__ct-hover-exclude";
  const EXCLUDED_CLASS = "__ct-excluded";
  const HOVER_CLASS_EDIT = "__ct-hover-edit";
  const EDITING_CLASS = "__ct-editing";
  const ALL_HOVER_CLASSES = [HOVER_CLASS, HOVER_CLASS_DELETE, HOVER_CLASS_EXCLUDE, HOVER_CLASS_EDIT];

  // The extension's entire on-page footprint: hover/selection outlines and a
  // couple of transient status overlays. Every control lives in the floating
  // panel window.
  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .__ct-hover {
        outline: 2px solid #4f7cff !important;
        outline-offset: 1px !important;
        cursor: pointer !important;
        background-color: rgba(79,124,255,0.06) !important;
      }
      .__ct-hover-delete {
        outline: 2px solid #e5484d !important;
        outline-offset: 1px !important;
        cursor: not-allowed !important;
        background-color: rgba(229,72,77,0.12) !important;
      }
      .__ct-hover-exclude {
        outline: 2px solid #9aa1b1 !important;
        outline-offset: 1px !important;
        cursor: pointer !important;
        background-color: rgba(154,161,177,0.12) !important;
      }
      .__ct-hover-edit {
        outline: 2px solid #21c55d !important;
        outline-offset: 1px !important;
        cursor: text !important;
        background-color: rgba(33,197,93,0.08) !important;
      }
      .__ct-editing {
        outline: 2px solid #21c55d !important;
        outline-offset: 2px !important;
        cursor: text !important;
      }
      .__ct-excluded {
        outline: 2px dashed #9aa1b1 !important;
        outline-offset: 3px !important;
      }
      .__ct-spinner {
        position: absolute; z-index: 2147483647; background: rgba(0,0,0,0.8); color: #fff;
        font: 12px sans-serif; padding: 4px 8px; border-radius: 6px; pointer-events: none;
      }
      .__ct-toast {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        background: #1f2430; color: #fff; padding: 8px 14px; border-radius: 8px;
        font: 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
        z-index: 2147483647; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      }
    `;
    document.documentElement.appendChild(style);
  }
  injectStyle();

  function isProtected(el) {
    return (
      el === document.body ||
      el === document.documentElement ||
      el.tagName === "HTML" ||
      el.tagName === "BODY"
    );
  }

  function clearHover() {
    if (hoverEl) {
      hoverEl.classList.remove(...ALL_HOVER_CLASSES);
      hoverEl = null;
    }
  }

  // all four are mutually exclusive: false | "single" | "group" (or plain
  // true/false for areaMode, which has no single/group split)
  function setTranslateMode(kind) {
    translateMode = translateMode === kind ? false : kind;
    if (translateMode) {
      deleteMode = false;
      excludeMode = false;
      editMode = false;
      endEditing();
      deactivateAreaMode();
    }
    clearHover();
  }
  function setDeleteMode(kind) {
    deleteMode = deleteMode === kind ? false : kind;
    if (deleteMode) {
      translateMode = false;
      excludeMode = false;
      editMode = false;
      endEditing();
      deactivateAreaMode();
    }
    clearHover();
  }
  function setExcludeMode(kind) {
    excludeMode = excludeMode === kind ? false : kind;
    if (excludeMode) {
      translateMode = false;
      deleteMode = false;
      editMode = false;
      endEditing();
      deactivateAreaMode();
    }
    clearHover();
  }

  function setEditMode() {
    editMode = !editMode;
    if (editMode) {
      translateMode = false;
      deleteMode = false;
      excludeMode = false;
      deactivateAreaMode();
    } else {
      endEditing();
    }
    clearHover();
  }

  function beginEditing(el) {
    endEditing();
    editingEl = el;
    el.setAttribute("contenteditable", "true");
    el.classList.add(EDITING_CLASS);
    el.addEventListener("blur", endEditing, { once: true });
    el.focus();
  }

  function endEditing() {
    if (!editingEl) return;
    const el = editingEl;
    editingEl = null;
    el.removeEventListener("blur", endEditing);
    el.removeAttribute("contenteditable");
    el.classList.remove(EDITING_CLASS);
  }

  function activateAreaMode() {
    if (areaMode) return;
    areaMode = true;
    editMode = false;
    endEditing();
    translateMode = false;
    deleteMode = false;
    excludeMode = false;
    clearHover();
    // Deliberately does NOT preventDefault anywhere — the browser's own
    // text-selection (drag to highlight, like copying text) does all the
    // work of showing what will be translated. We just read it on mouseup.
    document.addEventListener("mouseup", onAreaSelectionMouseUp, true);
  }

  function deactivateAreaMode() {
    if (!areaMode) return;
    areaMode = false;
    document.removeEventListener("mouseup", onAreaSelectionMouseUp, true);
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  function toggleAreaMode() {
    if (areaMode) deactivateAreaMode();
    else activateAreaMode();
  }

  function onAreaSelectionMouseUp(e) {
    if (e.target.closest && e.target.closest(".__ct-toast, .__ct-spinner")) return;
    // Deferred slightly so the browser has finished updating the Selection
    // object for this mouseup before we read it.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return; // plain click, no drag
      const range = sel.getRangeAt(0);
      if (range.collapsed || !sel.toString().trim()) return;
      const textNodes = getTextNodesInRange(range);
      sel.removeAllRanges(); // clear the highlight — the text is about to change anyway
      if (textNodes.length === 0) return;
      translateArea(textNodes, lastLang);
    }, 0);
  }

  // Finds elements that "belong to the same repeated thing" as el, so marking
  // (or deleting) one comment/card/link excludes all of its counterparts in
  // one click. Tried in order, most specific first:
  //  1. same tag + identical trimmed text content, page-wide — this is
  //     checked FIRST and deliberately narrow: it's what makes clicking one
  //     "See Translation" link group only the other elements with that exact
  //     same text, not every other <span> nearby
  //  2. exact match on el's full class set, if that groups >1
  //  3. whichever single shared class groups the most elements (handles
  //     per-instance classes like "comment comment-4821")
  //  4. same-tag siblings under the same parent (last resort — broadest, and
  //     NOT filtered by text, so it only kicks in when nothing more precise matched)
  function getSimilarElements(el) {
    const text = el.textContent && el.textContent.trim();
    if (text) {
      const sameTagSameText = Array.from(document.getElementsByTagName(el.tagName)).filter(
        (e) => e.textContent && e.textContent.trim() === text
      );
      if (sameTagSameText.length > 1) return sameTagSameText;
    }
    if (el.classList && el.classList.length > 0) {
      const classes = Array.from(el.classList);
      try {
        const compoundSelector = "." + classes.map((c) => CSS.escape(c)).join(".");
        const exact = Array.from(document.querySelectorAll(compoundSelector));
        if (exact.length > 1) return exact;
      } catch (err) {
        // invalid selector (shouldn't happen with CSS.escape) — fall through
      }
      let best = null;
      classes.forEach((cls) => {
        try {
          const matches = Array.from(document.getElementsByClassName(cls));
          if (matches.length > 1 && (!best || matches.length > best.length)) best = matches;
        } catch (err) {
          /* ignore and keep looking */
        }
      });
      if (best) return best;
    }
    if (el.parentElement) {
      const tag = el.tagName;
      const siblings = Array.from(el.parentElement.children).filter((child) => child.tagName === tag);
      if (siblings.length > 1) return siblings;
    }
    return [el];
  }

  function toggleExcludedSingle(el) {
    if (isProtected(el)) return;
    const alreadyExcluded = el.classList.contains(EXCLUDED_CLASS);
    if (alreadyExcluded) {
      el.classList.remove(EXCLUDED_CLASS);
      excludedEls.delete(el);
    } else {
      el.classList.add(EXCLUDED_CLASS);
      excludedEls.add(el);
    }
    return { count: 1, excluded: !alreadyExcluded };
  }

  function toggleExcludedGroup(el) {
    if (isProtected(el)) return;
    const group = getSimilarElements(el).filter((g) => !isProtected(g));
    const alreadyExcluded = el.classList.contains(EXCLUDED_CLASS);
    group.forEach((g) => {
      if (alreadyExcluded) {
        g.classList.remove(EXCLUDED_CLASS);
        excludedEls.delete(g);
      } else {
        g.classList.add(EXCLUDED_CLASS);
        excludedEls.add(g);
      }
    });
    return { count: group.length, excluded: !alreadyExcluded };
  }

  function clearAllExclusions() {
    const count = excludedEls.size;
    excludedEls.forEach((el) => {
      if (el.classList) el.classList.remove(EXCLUDED_CLASS);
    });
    excludedEls.clear();
    return count;
  }

  // Some sites (React/Vue/etc.) re-render parts of the DOM in response to any
  // mutation — including the text changes we make while translating — and that
  // re-render can silently drop the class we added for marking exclusions, even
  // though the element itself is still there. Re-apply it defensively after any
  // bulk translation pass, and drop tracking for elements that got removed.
  function reapplyExclusionMarkers() {
    excludedEls.forEach((el) => {
      if (!document.body.contains(el)) {
        excludedEls.delete(el);
        return;
      }
      if (!el.classList.contains(EXCLUDED_CLASS)) el.classList.add(EXCLUDED_CLASS);
    });
  }

  // ---------- Deleting (single or grouped), with batched undo ----------
  function pushDeleteBatch(elements) {
    const items = elements.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
    items.forEach(({ el }) => {
      if (hoverEl === el) hoverEl = null;
      excludedEls.delete(el);
      el.remove();
    });
    deletedStack.push({ items });
  }

  function deleteElementSingle(el) {
    if (isProtected(el)) return;
    pushDeleteBatch([el]);
    return { count: 1 };
  }

  function deleteElementGroup(el) {
    if (isProtected(el)) return;
    const group = getSimilarElements(el).filter((g) => !isProtected(g) && document.body.contains(g));
    pushDeleteBatch(group);
    return { count: group.length };
  }

  function undoLastDelete() {
    const batch = deletedStack.pop();
    if (!batch) return;
    batch.items.forEach(({ el, parent, next }) => {
      if (next && next.parentNode === parent) parent.insertBefore(el, next);
      else parent.appendChild(el);
    });
  }

  // ---------- Picking / editing / deleting / excluding ----------
  function onMouseMove(e) {
    if (areaMode) return; // area-mode has its own mousedown/move/up handlers
    const el = e.target;
    if (el.isContentEditable && (editMode || (!deleteMode && !excludeMode && !translateMode))) {
      clearHover();
      return;
    }
    if (el === hoverEl) return;
    clearHover();
    hoverEl = el;
    hoverEl.classList.add(
      deleteMode ? HOVER_CLASS_DELETE : excludeMode ? HOVER_CLASS_EXCLUDE : editMode ? HOVER_CLASS_EDIT : HOVER_CLASS
    );
  }

  function onClick(e) {
    if (areaMode) {
      // Swallow every click while area mode is on — genuine drag-selections
      // are handled separately on mouseup, and this stops a stray plain
      // click (e.g. on a link) from navigating away by accident.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const el = e.target;
    if (editMode) {
      // Clicks inside the element already being edited must pass through so
      // the caret can move; anything else picks a new element to edit.
      if (el.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      if (isProtected(el)) return;
      beginEditing(el);
      return;
    }
    if (deleteMode) {
      e.preventDefault();
      e.stopPropagation();
      const result = deleteMode === "group" ? deleteElementGroup(el) : deleteElementSingle(el);
      if (result && result.count > 1) showToast(`Deleted ${result.count} matching elements.`, 2200);
      return;
    }
    if (excludeMode) {
      e.preventDefault();
      e.stopPropagation();
      const result = excludeMode === "group" ? toggleExcludedGroup(el) : toggleExcludedSingle(el);
      if (result && result.count > 1) {
        showToast(
          `${result.excluded ? "Excluded" : "Un-excluded"} ${result.count} matching elements.`,
          2200
        );
      }
      return;
    }
    if (translateMode) {
      e.preventDefault();
      e.stopPropagation();
      if (isProtected(el)) return;
      if (translateMode === "group") {
        const group = getSimilarElements(el).filter((g) => !isProtected(g));
        translateElements(group, lastLang).then(() => {
          if (group.length > 1) showToast(`Translated ${group.length} matching elements.`, 2200);
        });
      } else {
        translateElements([el], lastLang);
      }
      return;
    }
    // No mode toggled on — Single/Group Translate, Exclude, or Delete has
    // to be switched on first; a plain click does nothing.
  }

  function onKeyDown(e) {
    if (e.key === "Escape") stopMode();
  }

  function startMode(lang) {
    if (lang) lastLang = lang;
    if (active) return;
    active = true;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    reapplyIntervalId = setInterval(reapplyExclusionMarkers, 2000);
  }

  function stopMode() {
    active = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (reapplyIntervalId) {
      clearInterval(reapplyIntervalId);
      reapplyIntervalId = null;
    }
    clearHover();
    translateMode = false;
    deleteMode = false;
    excludeMode = false;
    editMode = false;
    endEditing();
    deactivateAreaMode();
  }

  // ---------- Translation ----------
  function isTranslatableTextNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    const parentEl = node.parentElement;
    if (!parentEl) return false;
    const parentTag = parentEl.tagName;
    if (parentTag === "SCRIPT" || parentTag === "STYLE" || parentTag === "NOSCRIPT") return false;
    if (parentEl.closest(".__ct-toast, .__ct-spinner")) return false;
    if (parentEl.closest("." + EXCLUDED_CLASS)) return false;
    return true;
  }

  function getTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isTranslatableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // DOM select for Area Translate: walks the selected Range's common
  // ancestor and keeps only text nodes the Range actually overlaps — this
  // rides on the browser's own native text-selection instead of comparing
  // pixel rectangles, so it's exact regardless of scroll position, zoom,
  // or unusual layout (absolutely positioned content, columns, etc).
  function getTextNodesInRange(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentElement || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isTranslatableTextNode(node)) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function protectWords(text, words) {
    if (!words || words.length === 0) return { masked: text, map: [] };
    let masked = text;
    const map = [];
    words.forEach((w) => {
      if (!w) return;
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "gi");
      masked = masked.replace(re, (match) => {
        const token = `⟦${map.length}⟧`;
        map.push(match);
        return token;
      });
    });
    return { masked, map };
  }

  function restoreWords(text, map) {
    if (!map || map.length === 0) return text;
    let result = text;
    map.forEach((original, i) => {
      const re = new RegExp(`[\\[\\(⟦]\\s*${i}\\s*[\\]\\)⟧]`, "g");
      result = result.replace(re, original);
    });
    return result;
  }

  async function getExcludedWords() {
    if (!chrome.storage) return [];
    const res = await chrome.storage.local.get(["excludedWords"]);
    return Array.isArray(res.excludedWords) ? res.excludedWords : [];
  }

  // ---------- Batched translation ----------
  // Instead of one network request per text node, many nodes are packed into a
  // single request, tagged 【0】【1】… so they can be split apart again, and
  // several requests run in parallel. If a tagged reply doesn't split back
  // cleanly, the batch is halved and retried, down to single nodes.
  const BATCH_CHARS = 3500;
  const BATCH_MAX_NODES = 80;
  const BATCH_CONCURRENCY = 6;

  function translateFast(text, lang) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "translateText", text, lang, fast: true }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.ok) return reject(new Error((response && response.error) || "Unknown error"));
        resolve(response.translated);
      });
    });
  }

  function parseTagged(out, n) {
    const re = /【\s*(\d+)\s*】/g;
    const marks = [];
    let m;
    while ((m = re.exec(out))) marks.push({ idx: parseInt(m[1], 10), start: m.index, end: re.lastIndex });
    if (marks.length !== n) return null;
    for (let i = 0; i < n; i++) if (marks[i].idx !== i) return null;
    return marks.map((mk, i) => out.slice(mk.end, i + 1 < n ? marks[i + 1].start : out.length).trim());
  }

  function applyResult(item, translated) {
    if (!item.node.isConnected) return false;
    item.node.nodeValue = item.lead + restoreWords(translated, item.map) + item.trail;
    return true;
  }

  async function translateItems(items, lang, tally) {
    if (items.length === 0) return;
    if (items.length === 1) {
      try {
        const out = await translateFast(items[0].masked, lang);
        if (applyResult(items[0], out.trim())) tally.succeeded++;
        else tally.failed++;
      } catch (err) {
        console.error("Toolbelt: failed to translate a text chunk", err);
        tally.failed++;
      }
      tally.done++;
      tally.onProgress && tally.onProgress(tally.done, tally.total);
      return;
    }
    let parts = null;
    try {
      const tagged = items.map((it, i) => `【${i}】${it.masked}`).join("\n");
      parts = parseTagged(await translateFast(tagged, lang), items.length);
    } catch (err) {
      console.error("Toolbelt: batch request failed", err);
      tally.failed += items.length;
      tally.done += items.length;
      tally.onProgress && tally.onProgress(tally.done, tally.total);
      return;
    }
    if (!parts) {
      const mid = Math.ceil(items.length / 2);
      await translateItems(items.slice(0, mid), lang, tally);
      await translateItems(items.slice(mid), lang, tally);
      return;
    }
    items.forEach((it, i) => {
      if (applyResult(it, parts[i])) tally.succeeded++;
      else tally.failed++;
    });
    tally.done += items.length;
    tally.onProgress && tally.onProgress(tally.done, tally.total);
  }

  async function translateNodesBatched(nodes, lang, excludedWords, onProgress) {
    const tally = { succeeded: 0, failed: 0, done: 0, total: nodes.length, onProgress };
    const items = [];
    nodes.forEach((node) => {
      const raw = node.nodeValue || "";
      const core = raw.trim();
      if (!node.isConnected || !/\p{L}/u.test(core)) {
        // gone, or nothing to translate (numbers / symbols only)
        tally.done++;
        tally.succeeded++;
        return;
      }
      const { masked, map } = protectWords(core, excludedWords);
      items.push({
        node,
        masked,
        map,
        lead: raw.match(/^\s*/)[0],
        trail: raw.match(/\s*$/)[0],
      });
    });

    const batches = [];
    let cur = [];
    let chars = 0;
    items.forEach((it) => {
      if (cur.length && (chars + it.masked.length > BATCH_CHARS || cur.length >= BATCH_MAX_NODES)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(it);
      chars += it.masked.length + 8;
    });
    if (cur.length) batches.push(cur);

    let next = 0;
    async function worker() {
      while (next < batches.length) {
        const b = batches[next++];
        await translateItems(b, lang, tally);
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker));
    return { succeeded: tally.succeeded, failed: tally.failed };
  }

  function showSpinner(el) {
    const rect = el.getBoundingClientRect();
    const s = document.createElement("div");
    s.className = "__ct-spinner";
    s.textContent = "Translating…";
    s.style.top = `${Math.max(rect.top + window.scrollY - 24, 4)}px`;
    s.style.left = `${rect.left + window.scrollX}px`;
    document.documentElement.appendChild(s);
    return s;
  }

  function showToast(text, ms) {
    const t = document.createElement("div");
    t.className = "__ct-toast";
    t.textContent = text;
    document.documentElement.appendChild(t);
    if (ms) setTimeout(() => t.remove(), ms);
    return t;
  }

  function scheduleExclusionReapply() {
    reapplyExclusionMarkers();
    setTimeout(reapplyExclusionMarkers, 300);
    setTimeout(reapplyExclusionMarkers, 1200);
  }

  async function translateElements(els, lang) {
    const seen = new Set();
    const textNodes = [];
    els.forEach((el) => {
      getTextNodes(el).forEach((n) => {
        if (!seen.has(n)) {
          seen.add(n);
          textNodes.push(n);
        }
      });
    });
    if (textNodes.length === 0) return { succeeded: 0, failed: 0 };

    const excludedWords = await getExcludedWords();
    const spinner = showSpinner(els[0]);
    let result = { succeeded: 0, failed: 0 };
    try {
      result = await translateNodesBatched(textNodes, lang, excludedWords);
      scheduleExclusionReapply();
      if (result.failed > 0) {
        showToast(
          result.succeeded > 0
            ? `Translated ${result.succeeded}, but ${result.failed} chunk(s) failed — try again.`
            : `Translation failed for this element — try again in a moment.`,
          3200
        );
      }
    } finally {
      spinner.remove();
    }
    return result;
  }

  async function translateArea(textNodes, lang) {
    if (!textNodes || textNodes.length === 0) {
      showToast("No translatable text in that selection.", 2200);
      return;
    }
    const excludedWords = await getExcludedWords();
    const toast = showToast(`Translating selection… 0/${textNodes.length}`);
    try {
      const { succeeded, failed } = await translateNodesBatched(
        textNodes,
        lang,
        excludedWords,
        (done, total) => {
          toast.textContent = `Translating selection… ${done}/${total}`;
        }
      );
      if (failed > 0) {
        toast.textContent = `Translated ${succeeded} of ${textNodes.length} in that selection — ${failed} failed. Select it again to retry.`;
        setTimeout(() => toast.remove(), 5000);
      } else {
        toast.textContent = `Done — translated ${textNodes.length} text block(s) in that selection.`;
        setTimeout(() => toast.remove(), 3000);
      }
    } catch (err) {
      toast.textContent = "Selection translation failed — see console for details.";
      console.error("Click to Translate: area translation failed", err);
      setTimeout(() => toast.remove(), 3000);
    }
    scheduleExclusionReapply();
  }

  async function translateWholePage(lang) {
    const textNodes = getTextNodes(document.body);
    if (textNodes.length === 0) {
      showToast("Nothing to translate on this page.", 2500);
      return;
    }
    const excludedWords = await getExcludedWords();
    const toast = showToast(`Translating page… 0/${textNodes.length}`);
    try {
      const { succeeded, failed } = await translateNodesBatched(
        textNodes,
        lang,
        excludedWords,
        (done, total) => {
          toast.textContent = `Translating page… ${done}/${total}`;
        }
      );
      if (failed > 0) {
        toast.textContent = `Translated ${succeeded} of ${textNodes.length} — ${failed} failed (likely rate-limited). Run Translate Whole Page again to retry the rest.`;
        setTimeout(() => toast.remove(), 5000);
      } else {
        toast.textContent = `Done — translated ${textNodes.length} text block(s)${
          excludedEls.size ? ` (${excludedEls.size} area(s) excluded)` : ""
        }.`;
        setTimeout(() => toast.remove(), 3000);
      }
    } catch (err) {
      toast.textContent = "Translation failed — see console for details.";
      console.error("Click to Translate: whole-page translation failed", err);
      setTimeout(() => toast.remove(), 3000);
    }
    scheduleExclusionReapply();
  }

  function getFullStateSnapshot() {
    return {
      active,
      lang: lastLang,
      translateMode,
      deleteMode,
      excludeMode,
      editMode,
      areaMode,
      excludedCount: excludedEls.size,
      deletedCount: deletedStack.length,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startTranslate") {
      startMode(msg.lang);
      sendResponse({ ok: true, active: true });
    } else if (msg.action === "stopTranslate") {
      stopMode();
      sendResponse({ ok: true, active: false });
    } else if (msg.action === "updateLang") {
      lastLang = msg.lang;
      sendResponse({ ok: true });
    } else if (msg.action === "getState") {
      sendResponse({ active, lang: lastLang });
    } else if (msg.action === "getFullState") {
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleTranslateSingle") {
      if (translateMode === "single") {
        stopMode();
      } else {
        if (!active) startMode(lastLang);
        setTranslateMode("single");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleTranslateGroup") {
      if (translateMode === "group") {
        stopMode();
      } else {
        if (!active) startMode(lastLang);
        setTranslateMode("group");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleDeleteSingle") {
      if (deleteMode === "single") {
        stopMode(); // turning off Delete shouldn't leave translate-select mode running underneath it
      } else {
        if (!active) startMode(lastLang);
        setDeleteMode("single");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleDeleteGroup") {
      if (deleteMode === "group") {
        stopMode();
      } else {
        if (!active) startMode(lastLang);
        setDeleteMode("group");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleExcludeSingle") {
      if (excludeMode === "single") {
        stopMode(); // same fix for Exclude — toggling off shouldn't leave select mode running
      } else {
        if (!active) startMode(lastLang);
        setExcludeMode("single");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleExcludeGroup") {
      if (excludeMode === "group") {
        stopMode();
      } else {
        if (!active) startMode(lastLang);
        setExcludeMode("group");
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleEdit") {
      if (editMode) {
        stopMode();
      } else {
        if (!active) startMode(lastLang);
        setEditMode();
      }
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "toggleAreaTranslate") {
      if (!active) startMode(lastLang);
      toggleAreaMode();
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "clearOverlays") {
      const count = clearAllExclusions();
      sendResponse({ ok: true, count, ...getFullStateSnapshot() });
    } else if (msg.action === "undoDelete") {
      undoLastDelete();
      sendResponse(getFullStateSnapshot());
    } else if (msg.action === "translateWholePage") {
      translateWholePage(msg.lang);
      sendResponse({ ok: true });
    }
  });
})();
