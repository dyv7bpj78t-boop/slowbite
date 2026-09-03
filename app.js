import { averageInterval, cooldownRemaining, formatClock, mealProgress } from "./logic.mjs";

(() => {
  "use strict";

  const KEYS = {
    settings: "slowbite.settings.v1",
    session: "slowbite.session.v1",
    history: "slowbite.history.v1"
  };

  const defaults = { mealMinutes: 20, biteSeconds: 30, soundEnabled: true };
  const CHIME_AT_SECONDS = 60;
  let settings = readJSON(KEYS.settings, defaults);
  let session = readJSON(KEYS.session, null);
  let history = readJSON(KEYS.history, []);
  let wakeLock = null;
  let readySignalledForBite = session?.readySignalledForBite ?? 0;
  let targetSignalled = session?.targetSignalled ?? false;

  const $ = (id) => document.getElementById(id);
  const elements = {
    homeView: $("homeView"), mealView: $("mealView"), startButton: $("startButton"),
    startMinutes: $("startMinutes"), settingsButton: $("settingsButton"),
    settingsDialog: $("settingsDialog"), mealMinutes: $("mealMinutes"),
    biteSeconds: $("biteSeconds"), soundEnabled: $("soundEnabled"),
    saveSettingsButton: $("saveSettingsButton"), historyButton: $("historyButton"),
    testChimeButton: $("testChimeButton"), audioStatus: $("audioStatus"),
    readyChimeAudio: $("readyChimeAudio"),
    historyDialog: $("historyDialog"), historyList: $("historyList"),
    closeHistoryButton: $("closeHistoryButton"), clearHistoryButton: $("clearHistoryButton"),
    cancelButton: $("cancelButton"), finishButton: $("finishButton"),
    progressRing: $("progressRing"), mealTimer: $("mealTimer"), targetLabel: $("targetLabel"),
    paceLabel: $("paceLabel"), paceMessage: $("paceMessage"), biteButton: $("biteButton"),
    biteButtonText: $("biteButtonText"), buttonCountdown: $("buttonCountdown"),
    biteCount: $("biteCount")
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

  function stopReadyChime() {
    elements.readyChimeAudio.pause();
  }

  function playReadyChimeAfter(delayMs = 0) {
    if (!settings.soundEnabled) return null;
    const audio = elements.readyChimeAudio;
    try {
      audio.pause();
      audio.currentTime = Math.max(0, CHIME_AT_SECONDS - delayMs / 1000);
      // This begins real media playback inside the user's tap. The MP3 is silent
      // until its 60-second mark, so the audible cue survives delayed-playback
      // restrictions in iOS and other browsers.
      return audio.play();
    } catch {
      return null;
    }
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
    if (session) {
      session.readySignalledForBite = readySignalledForBite;
      session.targetSignalled = targetSignalled;
      writeJSON(KEYS.session, session);
    } else {
      localStorage.removeItem(KEYS.session);
    }
  }

  function startMeal() {
    const now = Date.now();
    session = {
      startedAt: now,
      targetMs: settings.mealMinutes * 60_000,
      cooldownMs: settings.biteSeconds * 1000,
      bites: []
    };
    readySignalledForBite = 0;
    targetSignalled = false;
    persistSession();
    showMeal();
    requestWakeLock();
    updateMeal(now);
  }

  function takeBite() {
    if (!session) return;
    const now = Date.now();
    const lastBite = session.bites.at(-1);
    if (lastBite && now - lastBite < session.cooldownMs) return;
    session.bites.push(now);
    const playback = playReadyChimeAfter(session.cooldownMs);
    readySignalledForBite = playback ? session.bites.length : session.bites.length - 1;
    playback?.catch(() => {
      readySignalledForBite = Math.min(readySignalledForBite, session ? session.bites.length - 1 : 0);
      persistSession();
    });
    persistSession();
    updateMeal(now);
  }

  function finishMeal() {
    if (!session) return;
    const endedAt = Date.now();
    history.unshift({
      id: crypto.randomUUID?.() ?? String(endedAt),
      startedAt: session.startedAt,
      endedAt,
      targetMs: session.targetMs,
      bites: session.bites
    });
    history = history.slice(0, 100);
    writeJSON(KEYS.history, history);
    session = null;
    persistSession();
    releaseWakeLock();
    stopReadyChime();
    showHome();
  }

  function cancelMeal() {
    if (!session) return;
    if (session.bites.length && !window.confirm("Discard this meal?")) return;
    session = null;
    persistSession();
    releaseWakeLock();
    stopReadyChime();
    showHome();
  }

  function updateMeal(now = Date.now()) {
    if (!session) return;
    const elapsed = Math.max(0, now - session.startedAt);
    const progress = mealProgress(session.startedAt, now, session.targetMs);
    const lastBite = session.bites.at(-1);
    const remaining = lastBite ? cooldownRemaining(lastBite, now, session.cooldownMs) : 0;
    const ready = remaining <= 0;

    elements.progressRing.style.setProperty("--progress", `${progress * 360}deg`);
    elements.mealTimer.textContent = formatClock(elapsed);
    elements.targetLabel.textContent = elapsed >= session.targetMs ? "TARGET REACHED" : `OF ${formatClock(session.targetMs)}`;
    elements.targetLabel.classList.toggle("reached", elapsed >= session.targetMs);
    elements.paceLabel.textContent = ready ? "READY" : "WAIT";
    elements.paceLabel.className = `eyebrow ${ready ? "status-ready" : "status-wait"}`;
    elements.paceMessage.textContent = ready
      ? (session.bites.length ? "Take your next bite" : "Take your first bite")
      : `${Math.ceil(remaining / 1000)} seconds`;
    elements.biteButton.disabled = !ready;
    elements.biteButton.className = `bite-button ${ready ? "ready" : "waiting"}`;
    elements.biteButtonText.textContent = session.bites.length ? "Next bite" : "First bite";
    elements.buttonCountdown.textContent = ready ? "" : String(Math.ceil(remaining / 1000));
    elements.biteCount.textContent = session.bites.length;

    if (ready && session.bites.length > readySignalledForBite) {
      readySignalledForBite = session.bites.length;
      playReadyChimeAfter(0)?.catch(() => {});
      persistSession();
    }
    if (elapsed >= session.targetMs && !targetSignalled) {
      targetSignalled = true;
      persistSession();
    }
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
      elements.audioStatus.textContent = "Turn on Ready sound first.";
      return;
    }
    const playback = playReadyChimeAfter(0);
    if (!playback) {
      elements.audioStatus.textContent = "Audio is unavailable in this browser.";
      return;
    }
    elements.audioStatus.textContent = "Playing the bundled MP3…";
    playback.then(() => {
      elements.audioStatus.textContent = "Chime played. If it is silent, raise your media volume.";
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
      const average = averageInterval(meal.bites);
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(meal.startedAt);
      item.innerHTML = `
        <p class="history-date">${date}</p>
        <div class="history-metrics">
          <div class="history-metric"><strong>${formatClock(meal.endedAt - meal.startedAt)}</strong><span>Duration</span></div>
          <div class="history-metric"><strong>${meal.bites.length}</strong><span>Bites</span></div>
          <div class="history-metric"><strong>${average ? `${Math.round(average / 1000)} sec` : "—"}</strong><span>Average</span></div>
        </div>`;
      return item;
    }));
  }

  elements.startButton.addEventListener("click", startMeal);
  elements.biteButton.addEventListener("click", takeBite);
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
    if (document.visibilityState === "visible" && session) requestWakeLock();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  if (session) {
    showMeal();
    requestWakeLock();
    updateMeal();
  } else {
    showHome();
  }

  setInterval(() => updateMeal(), 200);
})();
