(() => {
  const q = new URLSearchParams(location.search);
  const url = q.get("u") || "";
  const vw = Math.min(Math.max(parseInt(q.get("w"), 10) || 1280, 320), 1920); // virtual page width
  const wrap = document.getElementById("wrap");
  const f = document.getElementById("f");
  const scale = window.innerWidth / vw;
  wrap.style.width = vw + "px";
  wrap.style.transform = "scale(" + scale + ")";
  f.style.width = vw + "px";
  f.style.height = Math.ceil(window.innerHeight / scale) + "px";
  parent.postMessage({ linkShower: "ready" }, "*");
  if (!/^https?:\/\//i.test(url)) return;
  f.addEventListener("load", () => parent.postMessage({ linkShower: "loaded" }, "*"));
  f.src = url;
})();
