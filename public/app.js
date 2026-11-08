const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
const video = $("video");

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("file").files[0];
  if (!file) return;
  $("go").disabled = true;
  $("steps").replaceChildren();
  $("result").style.display = "none";
  $("progress").classList.remove("on", "failed", "done");
  setProgress(0, "Uploading");
  const body = new FormData();
  body.append("video", file);
  try {
    const res = await fetch("/api/videos", { method: "POST", body });
    // A proxy or a crash can answer with something that is not JSON.
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return fail(json.error ?? "Upload failed");
    follow(json.id);
  } catch {
    fail("Upload failed");
  }
});

// `message` is empty for a pure progress tick, which only moves the bar.
function setProgress(percent, message, state) {
  const bar = $("progress");
  bar.classList.add("on");
  bar.classList.toggle("failed", state === "failed");
  bar.classList.toggle("done", state === "done");
  bar.setAttribute("aria-valuenow", String(percent));
  $("fill").style.width = `${percent}%`;
  $("pct-text").textContent = `${percent}%`;
  if (message) $("pct-msg").textContent = message;
}

function fail(message) {
  $("progress").classList.add("failed");
  $("steps").append(el("li", { className: "failed", textContent: message }));
  $("go").disabled = false;
}

function follow(id) {
  const source = new EventSource(`/api/videos/${id}/events`);
  source.onmessage = async (msg) => {
    const ev = JSON.parse(msg.data);
    setProgress(ev.percent ?? 0, ev.message, ev.stage === "done" || ev.stage === "failed" ? ev.stage : undefined);
    if (ev.message === "") return; // a progress tick: the bar is all it changes
    $("steps").querySelectorAll("li.last").forEach((li) => li.classList.remove("last"));
    $("steps").append(el("li", { className: ev.stage === "failed" ? "failed" : "last", textContent: ev.message }));
    if (ev.stage === "done") {
      source.close();
      show(await (await fetch(`/api/videos/${id}`)).json());
      $("go").disabled = false;
    } else if (ev.stage === "failed") {
      source.close();
      $("go").disabled = false;
    }
  };
  // The connection dropped (network blip, proxy timeout): stop streaming and poll the job until it ends.
  source.onerror = () => {
    source.close();
    const poll = setInterval(async () => {
      const res = await fetch(`/api/videos/${id}`).catch(() => null);
      if (res?.status === 404) { clearInterval(poll); return fail("The job is gone (the server restarted or it expired)"); }
      if (!res || !res.ok) return;
      const job = await res.json();
      setProgress(job.percent ?? 0, undefined, job.stage === "done" || job.stage === "failed" ? job.stage : undefined);
      if (job.stage === "done") { clearInterval(poll); show(job); $("go").disabled = false; }
      if (job.stage === "failed") { clearInterval(poll); fail(job.error ?? "Processing failed"); }
    }, 2000);
  };
}

let asked = new Set();
let hls;
function show(job) {
  const r = job.result;
  $("result").style.display = "grid";
  asked = new Set();
  hls?.destroy(); // a second upload must not leave the first player's loader running
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(r.hlsUrl);
    hls.attachMedia(video);
  } else {
    video.src = r.hlsUrl; // Safari plays HLS natively
  }
  $("summary").textContent = r.analysis.summary;
  $("chapters").replaceChildren(...r.analysis.chapters.map((c) =>
    el("li", {}, el("button", { className: "t", textContent: fmt(c.start), onclick: () => { video.currentTime = c.start; video.play(); } }),
      " ", el("strong", { textContent: c.title }), el("div", { className: "small", textContent: c.summary }))));
  $("clips").replaceChildren(...r.clips.map((c) =>
    el("li", {}, el("a", { href: c.url, textContent: c.title }), el("span", { className: "small", textContent: `  ${fmt(c.start)}–${fmt(c.end)}` }))));
  const notes = [`${r.analysis.quiz.length} quiz questions`, `${r.clips.length} clips`];
  if (r.analysisAttempts > 1) notes.push(`model answer rejected ${r.analysisAttempts - 1}x before it validated`);
  if (r.rejectedToolCalls.length) notes.push(`${r.rejectedToolCalls.length} tool call(s) rejected`);
  $("meta").textContent = notes.join(" · ");
  window.currentQuiz = r.analysis.quiz;
}

video.addEventListener("timeupdate", () => {
  const quiz = window.currentQuiz ?? [];
  const q = quiz.find((x, i) => !asked.has(i) && video.currentTime >= x.at && video.currentTime < x.at + 1.5);
  if (!q) return;
  asked.add(quiz.indexOf(q));
  video.pause();
  const box = $("quiz").firstElementChild;
  const note = el("p", { textContent: "" });
  box.replaceChildren(el("h3", { textContent: q.question }));
  q.options.forEach((text, i) => {
    const b = el("button", { className: "opt", textContent: text });
    b.onclick = () => {
      box.querySelectorAll(".opt").forEach((o, j) => { o.disabled = true; if (j === q.answerIndex) o.classList.add("right"); });
      if (i !== q.answerIndex) b.classList.add("wrong");
      note.textContent = q.explanation;
      box.append(el("button", { className: "ghost", textContent: "Continue", onclick: () => { $("quiz").style.display = "none"; video.play(); } }));
    };
    box.append(b);
  });
  box.append(note);
  $("quiz").style.display = "flex";
});

video.addEventListener("seeking", () => { asked = new Set([...asked].filter((i) => (window.currentQuiz[i]?.at ?? 0) < video.currentTime - 1.5)); });
