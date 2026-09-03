import { averageInterval, formatClock, pacingPhase } from "./logic.mjs";

(() => {
  "use strict";

  const KEYS = {
    settings: "slowbite.settings.v1",
    session: "slowbite.session.v1",
    history: "slowbite.history.v1"
  };
  const CAMERA_CHIME_AT_SECONDS = 60;
  const defaults = {
    mealMinutes: 30,
    biteSeconds: 30,
    breakEveryMinutes: 5,
    restSeconds: 30,
    soundEnabled: true,
    pacingMode: "automatic"
  };

  const storedSettings = readJSON(KEYS.settings, {});
  const needsStructuredDefaults = storedSettings.breakEveryMinutes == null;
  let settings = { ...defaults, ...storedSettings };
  if (needsStructuredDefaults) {
    settings.mealMinutes = 30;
    settings.breakEveryMinutes = 5;
    settings.restSeconds = 30;
    writeJSON(KEYS.settings, settings);
  }
  let session = readJSON(KEYS.session, null);
  let history = readJSON(KEYS.history, []);
  let wakeLock = null;
  let cameraTracker = null;
  let cameraGeneration = 0;
  let scheduledPhase = null;
  let restBellStopTimer = null;

  if (session && !["automatic", "camera"].includes(session.mode)) {
    session = null;
    localStorage.removeItem(KEYS.session);
  }
  if (session) {
    session.eatingBlockMs ??= 0;
    session.restMs ??= 0;
  }

  const $ = (id) => document.getElementById(id);
  const elements = {
    homeView: $("homeView"), mealView: $("mealView"), startButton: $("startButton"),
    startMinutes: $("startMinutes"), homeDescription: $("homeDescription"), modeNote: $("modeNote"),
    settingsButton: $("settingsButton"), settingsDialog: $("settingsDialog"),
    mealMinutes: $("mealMinutes"), biteSeconds: $("biteSeconds"), pacingMode: $("pacingMode"),
    breakEveryMinutes: $("breakEveryMinutes"), restSeconds: $("restSeconds"),
    breakEveryRow: $("breakEveryRow"), restSecondsRow: $("restSecondsRow"),
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
    phaseHint: $("phaseHint"),
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

  function currentPhase(elapsed = activeElapsed()) {
    return pacingPhase(elapsed, session?.eatingBlockMs || 0, session?.restMs || 0);
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
      const seek = () => {
        elements.pacerAudio.currentTime = (elapsedMs / 1000) % (session.cooldownMs / 1000);
      };
      if (elements.pacerAudio.readyState >= 1) seek();
      else elements.pacerAudio.addEventListener("loadedmetadata", seek, { once: true });
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
    if (!settings.soundEnabled || !session || session.pausedAt || currentPhase().resting) return;
    configureCameraAudio();
    seekCameraChime(session.cooldownMs);
    if (elements.cameraPacerAudio.paused) elements.cameraPacerAudio.play().catch(() => {});
  }

  function stopAudio() {
    clearTimeout(restBellStopTimer);
    restBellStopTimer = null;
    elements.pacerAudio.pause();
    elements.cameraPacerAudio.pause();
    elements.readyChimeAudio.pause();
  }

  function ringThenPauseForRest() {
    if (!settings.soundEnabled || !session) return;
    const audio = session.mode === "camera" ? elements.cameraPacerAudio : elements.pacerAudio;
    if (session.mode === "camera") {
      configureCameraAudio();
      const seek = () => { audio.currentTime = CAMERA_CHIME_AT_SECONDS; };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    } else {
      configureAutomaticAudio();
      const seek = () => { audio.currentTime = 0; };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }
    audio.play().catch(() => {});
    clearTimeout(restBellStopTimer);
    restBellStopTimer = setTimeout(() => {
      if (session && currentPhase().resting) audio.pause();
    }, 4800);
  }

  function resumeAfterRest(elapsed) {
    clearTimeout(restBellStopTimer);
    restBellStopTimer = null;
    if (!session || session.pausedAt) return;
    if (session.mode === "camera") {
      session.nextChimeAtElapsed = elapsed;
      persistSession();
      cameraTracker?.setPaused(false);
      configureCameraAudio();
      const audio = elements.cameraPacerAudio;
      const seek = () => { audio.currentTime = CAMERA_CHIME_AT_SECONDS; };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
      audio.play().catch(() => {});
    } else {
      playAutomaticPacer(0)?.catch(pauseAfterPlaybackFailure);
    }
  }

  function syncScheduledPhase(phase, elapsed) {
    const nextPhase = phase.resting ? "rest" : "eat";
    if (scheduledPhase === null) {
      scheduledPhase = nextPhase;
      return;
    }
    if (nextPhase === scheduledPhase) return;
    scheduledPhase = nextPhase;
    if (!session || session.pausedAt) return;

    if (nextPhase === "rest") {
      if (session.mode === "camera") {
        cameraTracker?.setPaused(true);
        setCameraStatus("Fork-down pause—tracking stopped", "paused");
      }
      ringThenPauseForRest();
    } else {
      resumeAfterRest(elapsed);
    }
  }

  function automaticCueCount(phase) {
    if (!session?.eatingBlockMs) return Math.floor(phase.eatingElapsedMs / session.cooldownMs) + 1;
    const cuesPerBlock = Math.ceil(session.eatingBlockMs / session.cooldownMs);
    const previousCues = phase.completedBlocks * cuesPerBlock;
    if (phase.resting) return previousCues + cuesPerBlock;
    return previousCues + Math.max(1, Math.ceil(phase.eatingInBlockMs / session.cooldownMs));
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
    if (currentPhase(elapsed).resting) return;
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
      eatingBlockMs: settings.breakEveryMinutes * 60_000,
      restMs: settings.breakEveryMinutes > 0 ? settings.restSeconds * 1000 : 0,
      totalPausedMs: 0,
      pausedAt: null,
      detectedBites: 0,
      nextChimeAtElapsed: settings.biteSeconds * 1000
    };
    scheduledPhase = null;
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
      const phase = currentPhase(activeElapsed(now));
      if (phase.resting) {
        elements.pacerAudio.pause();
        elements.cameraPacerAudio.pause();
        cameraTracker?.setPaused(true);
        if (session.mode === "camera") setCameraStatus("Fork-down pause—tracking stopped", "paused");
      } else if (session.mode === "camera") {
        const remaining = Math.max(0, session.nextChimeAtElapsed - activeElapsed(now));
        playCameraPacer(remaining)?.catch(pauseAfterPlaybackFailure);
        if (cameraTracker) cameraTracker.setPaused(false);
        else startCameraVision();
      } else {
        playAutomaticPacer(phase.eatingInBlockMs)?.catch(pauseAfterPlaybackFailure);
      }
    } else {
      session.pausedAt = now;
      clearTimeout(restBellStopTimer);
      restBellStopTimer = null;
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
    const phase = currentPhase(durationMs);
    history.unshift({
      id: crypto.randomUUID?.() ?? String(endedAt),
      mode: session.mode,
      startedAt: session.startedAt,
      endedAt,
      durationMs,
      targetMs: session.targetMs,
      intervalMs: session.cooldownMs,
      cues: automatic ? automaticCueCount(phase) : undefined,
      detectedBites: automatic ? undefined : (session.detectedBites || 0)
    });
    history = history.slice(0, 100);
    writeJSON(KEYS.history, history);
    session = null;
    persistSession();
    releaseWakeLock();
    stopAudio();
    stopCameraVision();
    scheduledPhase = null;
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
    scheduledPhase = null;
    showHome();
  }

  function updateMeal(now = Date.now()) {
    if (!session) return;
    const elapsed = activeElapsed(now);
    const progress = Math.min(elapsed / session.targetMs, 1);
    const paused = Boolean(session.pausedAt);
    const cameraMode = session.mode === "camera";
    const phase = currentPhase(elapsed);
    syncScheduledPhase(phase, elapsed);
    elements.mealView.classList.toggle("rest-mode", phase.resting && !paused);

    elements.progressRing.style.setProperty("--progress", `${progress * 360}deg`);
    elements.mealTimer.textContent = formatClock(elapsed);
    elements.targetLabel.textContent = elapsed >= session.targetMs ? "TARGET REACHED" : `OF ${formatClock(session.targetMs)}`;
    elements.targetLabel.classList.toggle("reached", elapsed >= session.targetMs);

    if (paused) {
      elements.paceLabel.textContent = "PAUSED";
      elements.paceLabel.className = "eyebrow status-wait";
      elements.paceMessage.textContent = phase.resting ? "Fork-down pause is paused" : "Meal pacing is paused";
      elements.phaseHint.textContent = "";
      elements.biteButtonText.textContent = cameraMode ? "Resume camera" : "Resume pacing";
      elements.countLabel.textContent = cameraMode ? "Detected" : "Cue";
      elements.biteCount.textContent = cameraMode ? (session.detectedBites || 0) : automaticCueCount(phase);
    } else if (phase.resting) {
      elements.paceLabel.textContent = "FORK-DOWN PAUSE";
      elements.paceLabel.className = "eyebrow status-rest";
      elements.paceMessage.textContent = `Rest for ${Math.ceil(phase.remainingMs / 1000)} seconds`;
      elements.phaseHint.textContent = "Put the fork down completely";
      elements.biteButtonText.textContent = cameraMode ? "Pause camera" : "Pause pacing";
      elements.countLabel.textContent = cameraMode ? "Detected" : "Cue";
      elements.biteCount.textContent = cameraMode ? (session.detectedBites || 0) : automaticCueCount(phase);
    } else if (cameraMode) {
      const remaining = Math.max(0, session.nextChimeAtElapsed - elapsed);
      const ready = remaining <= 0;
      elements.paceLabel.textContent = ready ? "READY" : "WAIT";
      elements.paceLabel.className = "eyebrow status-ready";
      elements.paceMessage.textContent = ready ? "Take your next bite" : `${Math.ceil(remaining / 1000)} seconds`;
      elements.phaseHint.textContent = Number.isFinite(phase.remainingMs) ? `Fork-down pause in ${formatClock(phase.remainingMs)}` : "Long pauses are off";
      elements.biteButtonText.textContent = "Pause camera";
      elements.countLabel.textContent = "Detected";
      elements.biteCount.textContent = session.detectedBites || 0;
    } else {
      const remaining = session.cooldownMs - (phase.eatingInBlockMs % session.cooldownMs);
      const cueCount = automaticCueCount(phase);
      elements.paceLabel.textContent = "NEXT CHIME";
      elements.paceLabel.className = "eyebrow status-ready";
      elements.paceMessage.textContent = `${Math.ceil(remaining / 1000)} seconds`;
      elements.phaseHint.textContent = Number.isFinite(phase.remainingMs) ? `Fork-down pause in ${formatClock(phase.remainingMs)}` : "Long pauses are off";
      elements.biteButtonText.textContent = "Pause pacing";
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
    elements.mealView.classList.remove("rest-mode");
    elements.cameraPanel.hidden = true;
    elements.settingsButton.hidden = false;
    elements.startMinutes.textContent = settings.mealMinutes;
    elements.homeDescription.textContent = cameraMode
      ? "The camera watches for hand-to-mouth gestures and restarts the wait automatically."
      : "SlowBite spaces out each bite and builds real fork-down pauses into the meal.";
    const restSummary = settings.breakEveryMinutes > 0
      ? `${settings.restSeconds}s pause every ${settings.breakEveryMinutes}m`
      : "no long pauses";
    elements.modeNote.textContent = cameraMode
      ? `Experimental camera · ${restSummary}`
      : `Every ${settings.biteSeconds}s · ${restSummary}`;
  }

  function syncRestControls() {
    const enabled = Number(elements.breakEveryMinutes.value) > 0;
    elements.restSeconds.disabled = !enabled;
    elements.restSecondsRow.classList.toggle("disabled", !enabled);
  }

  function openSettings() {
    elements.mealMinutes.value = String(settings.mealMinutes);
    elements.biteSeconds.value = String(settings.biteSeconds);
    elements.pacingMode.value = settings.pacingMode;
    elements.breakEveryMinutes.value = String(settings.breakEveryMinutes);
    elements.restSeconds.value = String(settings.restSeconds);
    elements.soundEnabled.checked = settings.soundEnabled;
    syncRestControls();
    elements.settingsDialog.showModal();
  }

  function saveSettings() {
    settings = {
      mealMinutes: Number(elements.mealMinutes.value),
      biteSeconds: Number(elements.biteSeconds.value),
      pacingMode: elements.pacingMode.value,
      breakEveryMinutes: Number(elements.breakEveryMinutes.value),
      restSeconds: Number(elements.restSeconds.value),
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
  elements.breakEveryMinutes.addEventListener("change", syncRestControls);
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
