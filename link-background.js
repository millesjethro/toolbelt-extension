// 1) Lets the preview frame show pages that normally refuse to be embedded.
//    Only applies to frames opened from this extension's own preview.html.
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: { resourceTypes: ["sub_frame"], initiatorDomains: [chrome.runtime.id] }
  }]
}).catch(console.error);

// 2) Link card: read a page's title / description / image (Open Graph tags).
const cache = new Map();

function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e === "amp") return "&"; if (e === "lt") return "<"; if (e === "gt") return ">";
    if (e === "quot") return '"'; if (e === "apos") return "'";
    const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return !Number.isInteger(n) || n < 0 || n > 0x10ffff ? m : String.fromCodePoint(n);
  });
}
function parseMeta(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n) => {
      const r = new RegExp("\\b" + n + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
      return r ? (r[2] ?? r[3]) : null;
    };
    const key = (attr("property") || attr("name") || "").toLowerCase();
    const val = attr("content");
    if (key && val != null && !(key in meta)) meta[key] = decode(val);
  }
  const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return {
    title: meta["og:title"] || meta["twitter:title"] || (t ? decode(t[1]).trim() : ""),
    desc: meta["og:description"] || meta["twitter:description"] || meta["description"] || "",
    image: meta["og:image"] || meta["twitter:image"] || "",
    site: meta["og:site_name"] || ""
  };
}
async function readHead(res, max) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "", n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    out += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(out)) break;
  }
  try { await reader.cancel(); } catch (e) {}
  return out;
}
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function toDataUrl(src, base) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const url = new URL(src, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    const r = await fetch(url.href, { signal: ctl.signal, credentials: "omit" });
    const type = (r.headers.get("content-type") || "").split(";")[0];
    if (!r.ok || !/^image\/(png|jpeg|webp|gif|avif)$/i.test(type)) return null;
    const reader = r.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) return null;
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return "data:" + type + ";base64," + b64(bytes);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
const pending = new Map();
async function unfurl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  if (cache.has(url)) return cache.get(url);
  if (pending.has(url)) return pending.get(url);
  const task = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctl.signal });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return null;
      const meta = parseMeta(await readHead(res, 400000));
      meta.image = meta.image ? await toDataUrl(meta.image, res.url) : null;
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(url, meta);
      return meta;
    } finally { clearTimeout(timer); }
  })();
  pending.set(url, task);
  try { return await task; } finally { pending.delete(url); }
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg && msg.type === "linkShower:unfurl") {
    unfurl(msg.url).then(send).catch(() => send(null));
    return true;
  }
});
