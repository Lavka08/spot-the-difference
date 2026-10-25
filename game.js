(() => {
  "use strict";

  const LEVELS = window.LEVELS;
  const DIFFS_PER_LEVEL = 5;
  const MISS_PENALTY = 5;     // секунд за промах
  const HINT_PENALTY = 15;    // секунд за подсказку
  const MIN_TOUCH_RADIUS = 26; // минимальный радиус попадания в CSS-пикселях (под палец)
  const BEST_KEY = "spot5-best";

  const $ = (id) => document.getElementById(id);
  const screens = ["start", "game", "level-done", "result"];

  const state = {
    level: 0,
    found: [],          // индексы найденных отличий на текущем уровне
    levelStart: 0,      // performance.now() начала уровня
    penalty: 0,         // штрафные секунды на текущем уровне
    misses: 0,          // промахи на текущем уровне
    hints: 0,
    results: [],        // { time, misses, hints } по уровням
    timerId: null,
    hintShown: null,
    busy: false,
  };

  /* ---------------- Экраны ---------------- */
  function show(name) {
    screens.forEach((s) => $("screen-" + s).classList.toggle("active", s === name));
    window.scrollTo(0, 0);
  }

  /* ---------------- Время ---------------- */
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function levelTime() {
    return (performance.now() - state.levelStart) / 1000 + state.penalty;
  }
  function tick() { $("hud-time").textContent = fmt(levelTime()); }

  /* ---------------- Лучший результат ---------------- */
  function loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)); } catch { return null; }
  }
  function saveBest(r) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(r)); } catch { /* приватный режим */ }
  }
  function isBetter(a, b) {
    if (!b) return true;
    if (Math.round(a.time) !== Math.round(b.time)) return a.time < b.time;
    return a.misses < b.misses;
  }
  function renderBestOnStart() {
    const best = loadBest();
    const el = $("best-start");
    if (best) {
      el.textContent = `🏅 Твой рекорд: ${fmt(best.time)}, промахов: ${best.misses}`;
      el.classList.remove("hidden");
    } else el.classList.add("hidden");
  }

  /* ---------------- Звук (без файлов, через WebAudio) ---------------- */
  let audio;
  function beep(freqs, dur = 0.12, type = "sine", vol = 0.15) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      freqs.forEach((f, i) => {
        const t = audio.currentTime + i * dur * 0.8;
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + dur);
      });
    } catch { /* звук не обязателен */ }
  }
  const sfx = {
    found: () => beep([660, 990], 0.12, "triangle"),
    miss: () => beep([180], 0.18, "square", 0.08),
    win: () => beep([523, 659, 784, 1047], 0.14, "triangle"),
  };
  function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

  /* ---------------- Уровень ---------------- */
  const boards = [...document.querySelectorAll(".board")];
  const imgA = $("img-a");
  const imgB = $("img-b");

  function loadImage(img, src) {
    return new Promise((res) => {
      img.onload = res;
      img.onerror = res;
      img.src = src;
    });
  }

  async function startLevel(i) {
    state.level = i;
    state.found = [];
    state.penalty = 0;
    state.misses = 0;
    state.hintShown = null;
    state.busy = true;
    const lvl = LEVELS[i];

    boards.forEach((b) => (b.querySelector(".overlay").innerHTML = ""));
    document.querySelectorAll(".miss-mark").forEach((m) => m.remove());
    $("hud-level").textContent = `Уровень ${i + 1} / ${LEVELS.length} · ${lvl.name || ""}`;
    updateFound();
    $("hud-time").textContent = "0:00";
    $("btn-hint").disabled = false;
    show("game");

    await Promise.all([loadImage(imgA, lvl.a), loadImage(imgB, lvl.b)]);
    const ratio = imgA.naturalWidth / imgA.naturalHeight || 4 / 3;
    document.documentElement.style.setProperty("--ratio", ratio);

    state.levelStart = performance.now();
    clearInterval(state.timerId);
    state.timerId = setInterval(tick, 250);
    state.busy = false;
  }

  function updateFound(bump) {
    const el = $("hud-found");
    el.textContent = `Найдено: ${state.found.length} из ${DIFFS_PER_LEVEL}`;
    if (bump) {
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
  }

  // Рисует кружок на обеих картинках
  function drawRing(d, cls) {
    const ratio = imgA.naturalWidth / imgA.naturalHeight || 4 / 3;
    return boards.map((b) => {
      const svg = b.querySelector(".overlay");
      const e = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      e.setAttribute("cx", d.x * 100);
      e.setAttribute("cy", d.y * 100);
      e.setAttribute("rx", d.r * 100);
      e.setAttribute("ry", d.r * 100 * ratio);
      e.setAttribute("class", cls);
      svg.appendChild(e);
      return e;
    });
  }

  function onTap(ev) {
    if (state.busy) return;
    const board = ev.currentTarget;
    const rect = board.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const nx = px / rect.width;
    const ny = py / rect.height;
    const diffs = LEVELS[state.level].diffs;

    // ищем ближайшее отличие, в зону которого попали
    let hit = -1, hitDist = Infinity, onFound = false;
    diffs.forEach((d, i) => {
      const dist = Math.hypot((nx - d.x) * rect.width, (ny - d.y) * rect.height);
      const radius = Math.max(d.r * rect.width, MIN_TOUCH_RADIUS);
      if (dist <= radius) {
        if (state.found.includes(i)) onFound = true;
        else if (dist < hitDist) { hit = i; hitDist = dist; }
      }
    });

    if (hit >= 0) return found(hit);
    if (onFound) return; // повторный тап по уже найденному — не штрафуем
    miss(board, px, py);
  }

  function found(i) {
    state.found.push(i);
    if (state.hintShown && state.hintShown.index === i) clearHint();
    drawRing(LEVELS[state.level].diffs[i], "found-ring");
    updateFound(true);
    sfx.found();
    vibrate(30);
    if (state.found.length >= DIFFS_PER_LEVEL) levelComplete();
  }

  function miss(board, px, py) {
    state.misses++;
    state.penalty += MISS_PENALTY;
    tick();

    const mark = document.createElement("div");
    mark.className = "miss-mark";
    mark.style.left = px + "px";
    mark.style.top = py + "px";
    board.appendChild(mark);
    setTimeout(() => mark.remove(), 750);

    boards.forEach((b) => {
      b.classList.remove("flash");
      void b.offsetWidth;
      b.classList.add("flash");
    });
    const wrap = $("boards");
    wrap.classList.remove("shake");
    void wrap.offsetWidth;
    wrap.classList.add("shake");

    const pen = $("penalty");
    pen.classList.remove("show");
    void pen.offsetWidth;
    pen.classList.add("show");

    sfx.miss();
    vibrate([60, 40, 60]);
  }

  /* ---------------- Подсказка ---------------- */
  function clearHint() {
    if (state.hintShown) state.hintShown.els.forEach((e) => e.remove());
    state.hintShown = null;
  }
  function hint() {
    if (state.busy || state.hintShown) return;
    const left = LEVELS[state.level].diffs.map((_, i) => i).filter((i) => !state.found.includes(i));
    if (!left.length) return;
    const i = left[Math.floor(Math.random() * left.length)];
    state.hints++;
    state.penalty += HINT_PENALTY;
    tick();
    const els = drawRing(LEVELS[state.level].diffs[i], "hint-ring");
    state.hintShown = { index: i, els };
    beep([440, 554], 0.1, "sine");
  }

  /* ---------------- Завершение уровня и игры ---------------- */
  function levelComplete() {
    state.busy = true;
    clearInterval(state.timerId);
    const time = levelTime();
    state.results[state.level] = { time, misses: state.misses };
    sfx.win();

    setTimeout(() => {
      if (state.level < LEVELS.length - 1) {
        $("ld-title").textContent = `Уровень ${state.level + 1} пройден!`;
        $("ld-stats").textContent = `Время: ${fmt(time)} · промахов: ${state.misses}`;
        show("level-done");
      } else {
        finishGame();
      }
    }, 900);
  }

  let lastResult = null;

  function finishGame() {
    const time = state.results.reduce((s, r) => s + r.time, 0);
    const misses = state.results.reduce((s, r) => s + r.misses, 0);
    lastResult = { time, misses, hints: state.hints, date: new Date().toISOString() };

    $("res-time").textContent = fmt(time);
    $("res-miss").textContent = misses;
    $("res-hints").textContent = state.hints;
    $("res-table").innerHTML = state.results
      .map((r, i) => `<tr><td>Уровень ${i + 1} · ${LEVELS[i].name || ""}</td>
        <td class="mono">${fmt(r.time)} · промахов: ${r.misses}</td></tr>`)
      .join("");

    const prev = loadBest();
    const bestEl = $("res-best");
    if (isBetter(lastResult, prev)) {
      saveBest(lastResult);
      bestEl.textContent = prev ? `🔥 Новый рекорд! Было ${fmt(prev.time)}` : "🏅 Это твой первый рекорд!";
    } else {
      bestEl.textContent = `Рекорд: ${fmt(prev.time)}, промахов: ${prev.misses}`;
    }
    $("share-msg").textContent = "";
    show("result");
  }

  /* ---------------- Поделиться ---------------- */
  function gameUrl() {
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // запасной путь для старых браузеров / не-https
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function share() {
    if (!lastResult) return;
    const text = `🔍 Нашёл все 15 отличий за ${fmt(lastResult.time)}, промахов: ${lastResult.misses}. ` +
      `Попробуй быстрее: ${gameUrl()}`;
    const ok = await copyText(text);
    $("share-msg").textContent = ok ? "Скопировано! Вставь в чат 👍" : text;
  }

  /* ---------------- Запуск ---------------- */
  function newGame() {
    state.results = [];
    state.hints = 0;
    startLevel(0);
  }

  boards.forEach((b) => b.addEventListener("pointerdown", onTap));
  $("btn-start").addEventListener("click", newGame);
  $("btn-again").addEventListener("click", newGame);
  $("btn-next").addEventListener("click", () => startLevel(state.level + 1));
  $("btn-hint").addEventListener("click", hint);
  $("btn-share").addEventListener("click", share);

  // предзагрузка картинок
  LEVELS.forEach((l) => { new Image().src = l.a; new Image().src = l.b; });

  renderBestOnStart();
})();
