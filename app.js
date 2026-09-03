import { averageInterval, formatClock } from "./logic.mjs";

(() => {
  "use strict";

  const KEYS = {
    settings: "slowbite.settings.v1",
    session: "slowbite.session.v1",
    history: "slowbite.history.v1"
  };
  const CAMERA_CHIME_AT_SECONDS = 60;
  const defaults = { mealMinutes: 20, biteSeconds: 30, soundEnabled: true, pacingMode: "automatic" };

  let settings = { ...defaults, ...readJSON(KEYS.settings, {}) };
  let session = readJSON(KEYS.session, null);
  let history = readJSON(KEYS.history, []);
  let wakeLock = null;
  let cameraTracker = null;
  let cameraGeneration = 0;

  if (session && !["automatic", "camera"].includes(session.mode)) {
    session = null;
    localStorage.removeItem(KEYS.session);
  }

  const $ = (id) => document.getElementById(id);
  const elements = {
    homeView: $("homeView"), mealView: $("mealView"), startButton: $("startButton"),
    startMinutes: $("startMinutes"), homeDescription: $("homeDescription"), modeNote: $("modeNote"),
    settingsButton: $("settingsButton"), settingsDialog: $("settingsDialog"),
    mealMinutes: $("mealMinutes"), biteSeconds: $("biteSeconds"), pacingMode: $("pacingMode"),
    soundEnabled: $("soundEnabled"), saveSettingsButton: $("saveSettingsButton"),
    historyButton: $("historyButton"), testChimeButton: $("testChimeButton"), audioStatus: $("audioStatus"),
    readyChimeAudio: $("readyChimeAudio"), pacerAudio: $("pacerAudio"), cameraPacerAudio: $("cameraPacerAudio"),
    historyDialog: $("historyDialog"), historyList: $("historyList"),
    closeHistoryButton: $("closeHistoryButton"), clearHistoryButton: $("clearHistoryButton"),
    cancelButton: $("cancelButton"), finishButton: $("finishButton"),
    progressRing: $("progressRing"), mealTimer: $("mealTimer"), targetLabel: $("targetLabel"),
    cameraPanel: $("cameraPanel"), cameraFrame: $("cameraFrame"), cameraVideo: $("cameraVideo"),
    cameraOverlay: $("cameraOverlay"), cameraStatus: $("cameraStatus"), cameraIndicator: $("cameraIndicator"),
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

  function setAudioSource(audio, relativePath, loop) {
    const source = new URL(relativePath, document.baseURI).href;
    if (audio.src !== source) {
      audio.src = source;
      audio.load();
    }
    audio.loop = loop;
  }

  function configureAutomaticAudio() {
    if (!session) return;
    const seconds = Math.round(session.cooldownMs / 1000);
    setAudioSource(elements.pacerAudio, `./pace-${seconds}.mp3`, true);
  }

  function configureCameraAudio() {
    setAudioSource(elements.cameraPacerAudio, "./camera-pacer.mp3", false);
  }

  function playAutomaticPacer(elapsedMs = 0) {
    if (!settings.soundEnabled) return null;
    configureAutomaticAudio();
    try {
      if (elapsedMs > 0 && elements.pacerAudio.readyState >= 1) {
        elements.pacerAudio.currentTime = (elapsedMs / 1000) % (session.cooldownMs / 1000);
      }
      return elements.pacerAudio.play();
    } catch { return null; }
  }

  function seekCameraChime(remainingMs) {
    if (!session) return;
    const audio = elements.cameraPacerAudio;
    const bounded = Math.max(0, Math.min(session.cooldownMs, remainingMs));
    const target = bounded > 0 ? CAMERA_CHIME_AT_SECONDS - bounded / 1000 : CAMERA_CHIME_AT_SECONDS + 5;
    const seek = () => {
      try { audio.currentTime = target; } catch { /* metadata may still be loading */ }
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener("loadedmetadata", seek, { once: true });
  }

  function playCameraPacer(remainingMs) {
    if (!settings.soundEnabled) return null;
    configureCameraAudio();
    seekCameraChime(remainingMs);
    try { return elements.cameraPacerAudio.play(); }
    catch { return null; }
  }

  function resetCameraChime() {
    if (!settings.soundEnabled || !session || session.pausedAt) return;
    configureCameraAudio();
    seekCameraChime(session.cooldownMs);
    if (elements.cameraPacerAudio.paused) elements.cameraPacerAudio.play().catch(() => {});
  }

  function stopAudio() {
    elements.pacerAudio.pause();
    elements.cameraPacerAudio.pause();
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

  function setCameraStatus(message, state = "watching") {
    elements.cameraStatus.textContent = message;
    elements.cameraIndicator.dataset.state = state;
  }

  async function startCameraVision() {
    if (!session || session.mode !== "camera" || cameraTracker) return;
    const generation = ++cameraGeneration;
    setCameraStatus("Preparing detector…", "loading");
    try {
      const { CameraBiteTracker } = await import("./camera.mjs");
      if (generation !== cameraGeneration || !session || session.mode !== "camera") return;
      const tracker = new CameraBiteTracker({
        video: elements.cameraVideo,
        canvas: elements.cameraOverlay,
        onStatus: setCameraStatus,
        onBite: recordCameraBite
      });
      cameraTracker = tracker;
      await tracker.start();
      if (generation !== cameraGeneration || !session || session.mode !== "camera") {
        tracker.stop();
        if (cameraTracker === tracker) cameraTracker = null;
        return;
      }
      tracker.setPaused(Boolean(session.pausedAt));
    } catch {
      if (generation === cameraGeneration) {
        cameraTracker = null;
        setCameraStatus("Camera unavailable—use Automatic mode", "error");
      }
    }
  }

  function stopCameraVision() {
    cameraGeneration += 1;
    cameraTracker?.stop();
    cameraTracker = null;
  }

  function recordCameraBite() {
    if (!session || session.mode !== "camera" || session.pausedAt) return;
    const now = Date.now();
    const elapsed = activeElapsed(now);
    if (session.lastBiteElapsedMs != null && elapsed - session.lastBiteElapsedMs < 2000) return;
    session.detectedBites = (session.detectedBites || 0) + 1;
    session.lastBiteElapsedMs = elapsed;
    session.nextChimeAtElapsed = elapsed + session.cooldownMs;
    persistSession();
    resetCameraChime();
    elements.cameraFrame.classList.add("bite-flash");
    setTimeout(() => elements.cameraFrame.classList.remove("bite-flash"), 450);
    updateMeal(now);
  }

  function startMeal() {
    const now = Date.now();
    const mode = settings.pacingMode === "camera" ? "camera" : "automatic";
    session = {
      mode,
      startedAt: now,
      targetMs: settings.mealMinutes * 60_000,
      cooldownMs: settings.biteSeconds * 1000,
      totalPausedMs: 0,
      pausedAt: null,
      detectedBites: 0,
      nextChimeAtElapsed: settings.biteSeconds * 1000
    };
    persistSession();
    showMeal();
    requestWakeLock();
    updateMeal(now);
    if (mode === "camera") {
      playCameraPacer(session.cooldownMs)?.catch(pauseAfterPlaybackFailure);
      startCameraVision();
    } else {
      playAutomaticPacer(0)?.catch(pauseAfterPlaybackFailure);
    }
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
      if (session.mode === "camera") {
        const remaining = Math.max(0, session.nextChimeAtElapsed - activeElapsed(now));
        playCameraPacer(remaining)?.catch(pauseAfterPlaybackFailure);
        if (cameraTracker) cameraTracker.setPaused(false);
        else startCameraVision();
      } else {
        playAutomaticPacer(activeElapsed(now))?.catch(pauseAfterPlaybackFailure);
      }
    } else {
      session.pausedAt = now;
      if (session.mode === "camera") {
        elements.cameraPacerAudio.pause();
        cameraTracker?.setPaused(true);
      } else {
        elements.pacerAudio.pause();
      }
      releaseWakeLock();
      persistSession();
      updateMeal(now);
    }
  }

  function finishMeal() {
    if (!session) return;
    const endedAt = Date.now();
    const durationMs = activeElapsed(endedAt);
    const automatic = session.mode === "automatic";
    history.unshift({
      id: crypto.randomUUID?.() ?? String(endedAt),
      mode: session.mode,
      startedAt: session.startedAt,
      endedAt,
      durationMs,
      targetMs: session.targetMs,
      intervalMs: session.cooldownMs,
      cues: automatic ? Math.floor(durationMs / session.cooldownMs) + 1 : undefined,
      detectedBites: automatic ? undefined : (session.detectedBites || 0)
    });
    history = history.slice(0, 100);
    writeJSON(KEYS.history, history);
    session = null;
    persistSession();
    releaseWakeLock();
    stopAudio();
    stopCameraVision();
    showHome();
  }

  function cancelMeal() {
    if (!session) return;
    if (activeElapsed() > 5000 && !window.confirm("Discard this meal?")) return;
    session = null;
    persistSession();
    releaseWakeLock();
    stopAudio();
    stopCameraVision();
    showHome();
  }

  function updateMeal(now = Date.now()) {
    if (!session) return;
    const elapsed = activeElapsed(now);
    const progress = Math.min(elapsed / session.targetMs, 1);
    const paused = Boolean(session.pausedAt);
    const cameraMode = session.mode === "camera";

    elements.progressRing.style.setProperty("--progress", `${progress * 360}deg`);
    elements.mealTimer.textContent = formatClock(elapsed);
    elements.targetLabel.textContent = elapsed >= session.targetMs ? "TARGET REACHED" : `OF ${formatClock(session.targetMs)}`;
    elements.targetLabel.classList.toggle("reached", elapsed >= session.targetMs);

    if (cameraMode) {
      const remaining = Math.max(0, session.nextChimeAtElapsed - elapsed);
      const ready = remaining <= 0;
      elements.paceLabel.textContent = paused ? "PAUSED" : ready ? "READY" : "WAIT";
      elements.paceLabel.className = `eyebrow ${paused ? "status-wait" : "status-ready"}`;
      elements.paceMessage.textContent = paused ? "Camera tracking is paused" : ready ? "Take your next bite" : `${Math.ceil(remaining / 1000)} seconds`;
      elements.biteButtonText.textContent = paused ? "Resume camera" : "Pause camera";
      elements.countLabel.textContent = "Detected";
      elements.biteCount.textContent = session.detectedBites || 0;
    } else {
      const remaining = session.cooldownMs - (elapsed % session.cooldownMs);
      const cueCount = Math.floor(elapsed / session.cooldownMs) + 1;
      elements.paceLabel.textContent = paused ? "PAUSED" : "NEXT CHIME";
      elements.paceLabel.className = `eyebrow ${paused ? "status-wait" : "status-ready"}`;
      elements.paceMessage.textContent = paused ? "Pacing is paused" : `${Math.ceil(remaining / 1000)} seconds`;
      elements.biteButtonText.textContent = paused ? "Resume pacing" : "Pause pacing";
      elements.countLabel.textContent = "Cue";
      elements.biteCount.textContent = cueCount;
    }

    elements.biteButton.disabled = false;
    elements.biteButton.className = `bite-button ${paused ? "waiting" : "ready"}`;
    elements.biteIcon.textContent = paused ? "▶" : "Ⅱ";
    elements.buttonCountdown.textContent = "";
  }

  function showMeal() {
    const cameraMode = session?.mode === "camera";
    elements.homeView.hidden = true;
    elements.mealView.hidden = false;
    elements.mealView.classList.toggle("camera-mode", cameraMode);
    elements.cameraPanel.hidden = !cameraMode;
    elements.settingsButton.hidden = true;
  }

  function showHome() {
    const cameraMode = settings.pacingMode === "camera";
    elements.homeView.hidden = false;
    elements.mealView.hidden = true;
    elements.mealView.classList.remove("camera-mode");
    elements.cameraPanel.hidden = true;
    elements.settingsButton.hidden = false;
    elements.startMinutes.textContent = settings.mealMinutes;
    elements.homeDescription.textContent = cameraMode
      ? "The camera watches for hand-to-mouth gestures and restarts the wait automatically."
      : "Start once. SlowBite rings automatically when it is time for your next bite.";
    elements.modeNote.textContent = cameraMode
      ? "Experimental camera · frames stay on this device"
      : `Automatic · bell every ${settings.biteSeconds} seconds`;
  }

  function openSettings() {
    elements.mealMinutes.value = String(settings.mealMinutes);
    elements.biteSeconds.value = String(settings.biteSeconds);
    elements.pacingMode.value = settings.pacingMode;
    elements.soundEnabled.checked = settings.soundEnabled;
    elements.settingsDialog.showModal();
  }

  function saveSettings() {
    settings = {
      mealMinutes: Number(elements.mealMinutes.value),
      biteSeconds: Number(elements.biteSeconds.value),
      pacingMode: elements.pacingMode.value,
      soundEnabled: elements.soundEnabled.checked
    };
    writeJSON(KEYS.settings, settings);
    showHome();
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
    } catch { playback = null; }
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
      const camera = meal.mode === "camera";
      const average = automatic || camera ? meal.intervalMs : averageInterval(meal.bites || []);
      const count = camera ? meal.detectedBites : automatic ? meal.cues : (meal.bites || []).length;
      const duration = meal.durationMs ?? (meal.endedAt - meal.startedAt);
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(meal.startedAt);
      item.innerHTML = `
        <p class="history-date">${date}</p>
        <div class="history-metrics">
          <div class="history-metric"><strong>${formatClock(duration)}</strong><span>Duration</span></div>
          <div class="history-metric"><strong>${count}</strong><span>${camera ? "Detected" : automatic ? "Cues" : "Bites"}</span></div>
          <div class="history-metric"><strong>${average ? `${Math.round(average / 1000)} sec` : "—"}</strong><span>${automatic || camera ? "Interval" : "Average"}</span></div>
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
    if (session.mode === "camera") {
      configureCameraAudio();
      setCameraStatus("Tap Resume to restart the camera", "paused");
    } else {
      configureAutomaticAudio();
    }
    showMeal();
    updateMeal();
  } else {
    showHome();
  }

  setInterval(() => updateMeal(), 200);
})();
