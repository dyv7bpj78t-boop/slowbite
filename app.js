import { averageInterval, formatClock } from "./logic.mjs";

(() => {
  "use strict";

  const KEYS = {
    settings: "slowbite.settings.v1",
    session: "slowbite.session.v1",
    history: "slowbite.history.v1"
  };

  const defaults = { mealMinutes: 20, biteSeconds: 30, soundEnabled: true };
  let settings = readJSON(KEYS.settings, defaults);
  let session = readJSON(KEYS.session, null);
  let history = readJSON(KEYS.history, []);
  let wakeLock = null;

  // Manual sessions from older versions cannot be resumed meaningfully now
  // that pacing is automatic.
  if (session && session.mode !== "automatic") {
    session = null;
    localStorage.removeItem(KEYS.session);
  }

  const $ = (id) => document.getElementById(id);
  const elements = {
    homeView: $("homeView"), mealView: $("mealView"), startButton: $("startButton"),
    startMinutes: $("startMinutes"), settingsButton: $("settingsButton"),
    settingsDialog: $("settingsDialog"), mealMinutes: $("mealMinutes"),
    biteSeconds: $("biteSeconds"), soundEnabled: $("soundEnabled"),
    saveSettingsButton: $("saveSettingsButton"), historyButton: $("historyButton"),
    testChimeButton: $("testChimeButton"), audioStatus: $("audioStatus"),
    readyChimeAudio: $("readyChimeAudio"), pacerAudio: $("pacerAudio"),
    historyDialog: $("historyDialog"), historyList: $("historyList"),
    closeHistoryButton: $("closeHistoryButton"), clearHistoryButton: $("clearHistoryButton"),
    cancelButton: $("cancelButton"), finishButton: $("finishButton"),
    progressRing: $("progressRing"), mealTimer: $("mealTimer"), targetLabel: $("targetLabel"),
    paceLabel: $("paceLabel"), paceMessage: $("paceMessage"), biteButton: $("biteButton"),
    biteIcon: $("biteIcon"), biteButtonText: $("biteButtonText"),
    buttonCountdown: $("buttonCountdown"), countLabel: $("countLabel"), biteCount: $("biteCount")
  };

  function readJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch { return fallback; }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function activeElapsed(now = Date.now()) {
    if (!session) return 0;
    const currentPause = session.pausedAt ? now - session.pausedAt : 0;
    return Math.max(0, now - session.startedAt - (session.totalPausedMs || 0) - currentPause);
  }

  function configurePacerAudio() {
    if (!session) return;
    const seconds = Math.round(session.cooldownMs / 1000);
    const source = new URL(`./pace-${seconds}.mp3`, document.baseURI).href;
    if (elements.pacerAudio.src !== source) {
      elements.pacerAudio.src = source;
      elements.pacerAudio.load();
    }
    elements.pacerAudio.loop = true;
  }

  function playPacer(elapsedMs = 0) {
    if (!settings.soundEnabled) return null;
    configurePacerAudio();
    const audio = elements.pacerAudio;
    try {
      if (elapsedMs > 0 && audio.readyState >= 1) {
        audio.currentTime = (elapsedMs / 1000) % (session.cooldownMs / 1000);
      }
      return audio.play();
    } catch {
      return null;
    }
  }

  function stopAudio() {
    elements.pacerAudio.pause();
    elements.readyChimeAudio.pause();
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch { wakeLock = null; }
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  function persistSession() {
    if (session) writeJSON(KEYS.session, session);
    else localStorage.removeItem(KEYS.session);
  }

  function pauseAfterPlaybackFailure() {
    if (!session || session.pausedAt) return;
    session.pausedAt = Date.now();
    persistSession();
    updateMeal();
  }

  function startMeal() {
    const now = Date.now();
    session = {
      mode: "automatic",
      startedAt: now,
      targetMs: settings.mealMinutes * 60_000,
      cooldownMs: settings.biteSeconds * 1000,
      totalPausedMs: 0,
      pausedAt: null
    };
    persistSession();
    showMeal();
    requestWakeLock();
    updateMeal(now);
    playPacer(0)?.catch(pauseAfterPlaybackFailure);
  }

  function togglePacing() {
    if (!session) return;
    const now = Date.now();
    if (session.pausedAt) {
      session.totalPausedMs = (session.totalPausedMs || 0) + now - session.pausedAt;
      session.pausedAt = null;
      persistSession();
      updateMeal(now);
      requestWakeLock();
      playPacer(activeElapsed(now))?.catch(pauseAfterPlaybackFailure);
    } else {
      session.pausedAt = now;
      elements.pacerAudio.pause();
      releaseWakeLock();
      persistSession();
      updateMeal(now);
    }
  }

  function finishMeal() {
    if (!session) return;
    const endedAt = Date.now();
    const durationMs = activeElapsed(endedAt);
    history.unshift({
      id: crypto.randomUUID?.() ?? String(endedAt),
      mode: "automatic",
      startedAt: session.startedAt,
      endedAt,
      durationMs,
      targetMs: session.targetMs,
      intervalMs: session.cooldownMs,
      cues: Math.floor(durationMs / session.cooldownMs) + 1
    });
    history = history.slice(0, 100);
    writeJSON(KEYS.history, history);
    session = null;
    persistSession();
    releaseWakeLock();
    stopAudio();
    showHome();
  }

  function cancelMeal() {
    if (!session) return;
    if (activeElapsed() > 5000 && !window.confirm("Discard this meal?")) return;
    session = null;
    persistSession();
    releaseWakeLock();
    stopAudio();
    showHome();
  }

  function updateMeal(now = Date.now()) {
    if (!session) return;
    const elapsed = activeElapsed(now);
    const progress = Math.min(elapsed / session.targetMs, 1);
    const paused = Boolean(session.pausedAt);
    const remaining = session.cooldownMs - (elapsed % session.cooldownMs);
    const cueCount = Math.floor(elapsed / session.cooldownMs) + 1;

    elements.progressRing.style.setProperty("--progress", `${progress * 360}deg`);
    elements.mealTimer.textContent = formatClock(elapsed);
    elements.targetLabel.textContent = elapsed >= session.targetMs ? "TARGET REACHED" : `OF ${formatClock(session.targetMs)}`;
    elements.targetLabel.classList.toggle("reached", elapsed >= session.targetMs);
    elements.paceLabel.textContent = paused ? "PAUSED" : "NEXT CHIME";
    elements.paceLabel.className = `eyebrow ${paused ? "status-wait" : "status-ready"}`;
    elements.paceMessage.textContent = paused ? "Pacing is paused" : `${Math.ceil(remaining / 1000)} seconds`;
    elements.biteButton.disabled = false;
    elements.biteButton.className = `bite-button ${paused ? "waiting" : "ready"}`;
    elements.biteIcon.textContent = paused ? "▶" : "Ⅱ";
    elements.biteButtonText.textContent = paused ? "Resume pacing" : "Pause pacing";
    elements.buttonCountdown.textContent = "";
    elements.countLabel.textContent = "Cue";
    elements.biteCount.textContent = cueCount;
  }

  function showMeal() {
    elements.homeView.hidden = true;
    elements.mealView.hidden = false;
    elements.settingsButton.hidden = true;
  }

  function showHome() {
    elements.homeView.hidden = false;
    elements.mealView.hidden = true;
    elements.settingsButton.hidden = false;
    elements.startMinutes.textContent = settings.mealMinutes;
  }

  function openSettings() {
    elements.mealMinutes.value = String(settings.mealMinutes);
    elements.biteSeconds.value = String(settings.biteSeconds);
    elements.soundEnabled.checked = settings.soundEnabled;
    elements.settingsDialog.showModal();
  }

  function saveSettings() {
    settings = {
      mealMinutes: Number(elements.mealMinutes.value),
      biteSeconds: Number(elements.biteSeconds.value),
      soundEnabled: elements.soundEnabled.checked
    };
    writeJSON(KEYS.settings, settings);
    elements.startMinutes.textContent = settings.mealMinutes;
  }

  function testChime() {
    settings.soundEnabled = elements.soundEnabled.checked;
    elements.audioStatus.textContent = "";
    if (!settings.soundEnabled) {
      elements.audioStatus.textContent = "Turn on Pacing sound first.";
      return;
    }
    let playback;
    try {
      elements.readyChimeAudio.pause();
      elements.readyChimeAudio.currentTime = 0;
      playback = elements.readyChimeAudio.play();
    } catch {
      playback = null;
    }
    if (!playback) {
      elements.audioStatus.textContent = "Audio is unavailable in this browser.";
      return;
    }
    elements.audioStatus.textContent = "Playing the meditation bell…";
    playback.then(() => {
      elements.audioStatus.textContent = "Bell played. If it is silent, raise your media volume.";
    }).catch(() => {
      elements.audioStatus.textContent = "Playback was blocked. Tap Test chime again.";
    });
  }

  function renderHistory() {
    if (!history.length) {
      elements.historyList.innerHTML = '<p class="empty-history">No meals yet.<br>Finished meals will appear here.</p>';
      elements.clearHistoryButton.hidden = true;
      return;
    }
    elements.clearHistoryButton.hidden = false;
    elements.historyList.replaceChildren(...history.map((meal) => {
      const item = document.createElement("article");
      item.className = "history-item";
      const automatic = meal.mode === "automatic";
      const average = automatic ? meal.intervalMs : averageInterval(meal.bites || []);
      const count = automatic ? meal.cues : (meal.bites || []).length;
      const duration = meal.durationMs ?? (meal.endedAt - meal.startedAt);
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(meal.startedAt);
      item.innerHTML = `
        <p class="history-date">${date}</p>
        <div class="history-metrics">
          <div class="history-metric"><strong>${formatClock(duration)}</strong><span>Duration</span></div>
          <div class="history-metric"><strong>${count}</strong><span>${automatic ? "Cues" : "Bites"}</span></div>
          <div class="history-metric"><strong>${average ? `${Math.round(average / 1000)} sec` : "—"}</strong><span>${automatic ? "Interval" : "Average"}</span></div>
        </div>`;
      return item;
    }));
  }

  elements.startButton.addEventListener("click", startMeal);
  elements.biteButton.addEventListener("click", togglePacing);
  elements.finishButton.addEventListener("click", finishMeal);
  elements.cancelButton.addEventListener("click", cancelMeal);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.testChimeButton.addEventListener("click", testChime);
  elements.historyButton.addEventListener("click", () => { renderHistory(); elements.historyDialog.showModal(); });
  elements.closeHistoryButton.addEventListener("click", () => elements.historyDialog.close());
  elements.clearHistoryButton.addEventListener("click", () => {
    if (!window.confirm("Clear all meal history?")) return;
    history = [];
    writeJSON(KEYS.history, history);
    renderHistory();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && session && !session.pausedAt) requestWakeLock();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  if (session) {
    if (!session.pausedAt) {
      session.pausedAt = Date.now();
      persistSession();
    }
    configurePacerAudio();
    showMeal();
    updateMeal();
  } else {
    showHome();
  }

  setInterval(() => updateMeal(), 200);
})();
