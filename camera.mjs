const MEDIAPIPE_VERSION = "0.10.35";
const SDK_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const MOUTH_POINTS = [13, 14, 61, 291];
const CHEEK_POINTS = [234, 454];
const HAND_TIPS = [4, 8, 12];
const INFERENCE_INTERVAL_MS = 125;
const MIN_NEAR_TIME_MS = 160;
const MIN_BITE_GAP_MS = 2500;

function averagePoint(landmarks, indices) {
  const total = indices.reduce((point, index) => ({
    x: point.x + landmarks[index].x,
    y: point.y + landmarks[index].y
  }), { x: 0, y: 0 });
  return { x: total.x / indices.length, y: total.y / indices.length };
}

function distance(a, b, aspect) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

export class CameraBiteTracker {
  constructor({ video, canvas, onStatus, onBite }) {
    this.video = video;
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.onBite = onBite;
    this.stream = null;
    this.faceLandmarker = null;
    this.handLandmarker = null;
    this.animationFrame = 0;
    this.running = false;
    this.paused = false;
    this.lastInferenceAt = 0;
    this.lastVideoTime = -1;
    this.lastStatus = "";
    this.near = false;
    this.nearSince = 0;
    this.confirmed = false;
    this.lastBiteAt = -Infinity;
  }

  status(message, state = "watching") {
    const key = `${state}:${message}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.onStatus(message, state);
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is unavailable in this browser.");
    }

    this.status("Requesting camera…", "loading");
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 20 }
        }
      });
      const sdkPromise = import(SDK_URL);
      const [stream, tasks] = await Promise.all([streamPromise, sdkPromise]);
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();

      this.status("Loading hand and face models…", "loading");
      const vision = await tasks.FilesetResolver.forVisionTasks(WASM_URL);
      await this.createLandmarkers(tasks, vision, "GPU").catch(async () => {
        this.faceLandmarker?.close?.();
        this.handLandmarker?.close?.();
        this.faceLandmarker = null;
        this.handLandmarker = null;
        await this.createLandmarkers(tasks, vision, "CPU");
      });

      this.running = true;
      this.status("Watching hand and mouth", "watching");
      this.loop();
    } catch (error) {
      this.stop(false);
      const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
      const message = denied ? "Camera permission was denied" : "Camera detector could not start";
      this.status(message, "error");
      throw error;
    }
  }

  async createLandmarkers(tasks, vision, delegate) {
    this.faceLandmarker = await tasks.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    this.handLandmarker = await tasks.HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.45,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.45
    });
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      this.status("Camera paused", "paused");
      this.clearOverlay();
    } else if (this.running) {
      this.video.play().catch(() => {});
      this.status("Watching hand and mouth", "watching");
    }
  }

  loop = () => {
    if (!this.running) return;
    this.animationFrame = requestAnimationFrame(this.loop);
    if (this.paused || this.video.readyState < 2) return;

    const now = performance.now();
    if (now - this.lastInferenceAt < INFERENCE_INTERVAL_MS || this.video.currentTime === this.lastVideoTime) return;
    this.lastInferenceAt = now;
    this.lastVideoTime = this.video.currentTime;

    try {
      const faces = this.faceLandmarker.detectForVideo(this.video, now);
      const hands = this.handLandmarker.detectForVideo(this.video, now);
      this.process(faces.faceLandmarks?.[0], hands.landmarks?.[0], now);
    } catch {
      this.status("Detector paused—move back into view", "error");
    }
  };

  process(face, hand, now) {
    if (!face) {
      this.handleProximity(false, now);
      this.clearOverlay();
      this.status("Move your face into view", "searching");
      return;
    }
    if (!hand) {
      this.handleProximity(false, now);
      this.draw(face, null, false, 0);
      this.status("Face found—looking for your hand", "searching");
      return;
    }

    const aspect = this.video.videoWidth / this.video.videoHeight;
    const mouth = averagePoint(face, MOUTH_POINTS);
    const faceWidth = distance(face[CHEEK_POINTS[0]], face[CHEEK_POINTS[1]], aspect);
    const threshold = Math.max(0.08, Math.min(0.22, faceWidth * 0.48));
    const nearestTip = HAND_TIPS
      .map((index) => hand[index])
      .sort((a, b) => distance(a, mouth, aspect) - distance(b, mouth, aspect))[0];
    const near = distance(nearestTip, mouth, aspect) <= threshold;

    this.handleProximity(near, now);
    this.draw(face, nearestTip, near, threshold);
    this.status(near ? "Hand near mouth…" : "Watching hand and mouth", near ? "near" : "watching");
  }

  handleProximity(near, now) {
    if (near) {
      if (!this.near) {
        this.near = true;
        this.nearSince = now;
        this.confirmed = false;
      }
      if (now - this.nearSince >= MIN_NEAR_TIME_MS) this.confirmed = true;
      return;
    }

    if (this.near && this.confirmed && now - this.lastBiteAt >= MIN_BITE_GAP_MS) {
      this.lastBiteAt = now;
      this.onBite();
      this.status("Bite detected", "detected");
    }
    this.near = false;
    this.nearSince = 0;
    this.confirmed = false;
  }

  draw(face, handTip, near, threshold) {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const mouth = averagePoint(face, MOUTH_POINTS);
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.lineWidth = Math.max(3, width / 180);
    context.strokeStyle = near ? "#74d59b" : "rgba(255, 173, 66, .85)";
    context.fillStyle = near ? "#74d59b" : "#ffad42";
    context.beginPath();
    const radius = Math.max(28, threshold * height);
    context.arc(mouth.x * width, mouth.y * height, radius, 0, Math.PI * 2);
    context.stroke();
    if (handTip) {
      context.beginPath();
      context.arc(handTip.x * width, handTip.y * height, Math.max(7, width / 75), 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(handTip.x * width, handTip.y * height);
      context.lineTo(mouth.x * width, mouth.y * height);
      context.stroke();
    }
    context.restore();
  }

  clearOverlay() {
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  stop(updateStatus = true) {
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
    this.faceLandmarker?.close?.();
    this.handLandmarker?.close?.();
    this.stream = null;
    this.faceLandmarker = null;
    this.handLandmarker = null;
    this.clearOverlay();
    if (updateStatus) this.status("Camera stopped", "paused");
  }
}
