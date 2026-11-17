(() => {
const DEFAULTS = { mode: "hold", keyK: "Shift", keyLabel: "Shift", accent: "#FFD93D", externalOnly: false, preview: true, previewStyle: "auto", enabled: true };
const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };
let listening = false;

function hintText() {
  if (state.mode === "always") return document.createTextNode("Popup shows on every link you hover.");
  const span = document.createElement("span");
  const b = document.createElement("b");
  b.textContent = state.keyLabel;
  span.append(state.mode === "hold" ? "Hold " : "Tap ", b,
    state.mode === "hold" ? " while hovering a link." : " while hovering a link to show or hide the URL.");
  return span;
}

function render() {
  $("pane-links").style.setProperty("--accent", state.accent);
  $("pane-links").classList.toggle("always", state.mode === "always");
  $("key").textContent = listening ? "Press a key…  (Esc to cancel)" : state.keyLabel;
  $("key").classList.toggle("listening", listening);
  $("enabled").checked = state.enabled;
  $("ext").checked = state.externalOnly;
  $("prev").checked = state.preview;
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("sel", b.dataset.mode === state.mode));
  document.querySelectorAll("#pstyle button").forEach((b) => b.classList.toggle("sel", b.dataset.ps === state.previewStyle));
  document.querySelectorAll("#swatches button").forEach((b) => {
    const sel = b.dataset.color === state.accent;
    b.classList.toggle("sel", sel);
    b.setAttribute("aria-pressed", String(sel));
  });
  $("hint").replaceChildren(hintText());
}
function save(patch) {
  state = { ...state, ...patch };
  chrome.storage.local.set({ linkShower: state });
  render();
}

chrome.storage.local.get({ linkShower: DEFAULTS }, (s) => {
  state = { ...DEFAULTS, ...s.linkShower };
  if (state.previewStyle === "window") state.previewStyle = "auto"; // removed option
  render();
});

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) save({ mode: b.dataset.mode }); });
$("pstyle").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) save({ previewStyle: b.dataset.ps }); });
$("prev").addEventListener("change", (e) => save({ preview: e.target.checked }));
$("ext").addEventListener("change", (e) => save({ externalOnly: e.target.checked }));
$("swatches").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) save({ accent: b.dataset.color }); });

$("key").addEventListener("click", () => { listening = true; render(); $("key").focus(); });
document.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  listening = false;
  if (e.key === "Escape") { render(); return; }
  const label = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  save({ keyK: e.key, keyLabel: label });
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "linkShower:count" }, { frameId: 0 }, (r) => {
    if (chrome.runtime.lastError || !r) { $("split").textContent = "Not available on this page"; return; }
    $("total").textContent = r.total;
    $("split").textContent = r.internal + " internal · " + r.external + " external";
  });
});

})();
