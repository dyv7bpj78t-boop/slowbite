export function formatClock(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function cooldownRemaining(lastBite, now, cooldownMs) {
  return Math.max(0, cooldownMs - (now - lastBite));
}

export function mealProgress(startedAt, now, targetMs) {
  if (targetMs <= 0) return 1;
  return Math.min(1, Math.max(0, now - startedAt) / targetMs);
}

export function averageInterval(bites) {
  if (bites.length < 2) return null;
  let total = 0;
  for (let index = 1; index < bites.length; index += 1) {
    total += bites[index] - bites[index - 1];
  }
  return total / (bites.length - 1);
}
