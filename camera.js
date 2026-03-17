/**
 * BiteTrack — camera.js
 *
 * Vision-based bite detection using TensorFlow.js MoveNet.
 * Tracks the dominant wrist keypoint and detects upward velocity
 * spikes (wrist rising toward face) as bite events.
 *
 * This is a CALIBRATION tool — run alongside the gyroscope version
 * to compare bite counts and tune gyroscope thresholds.
 *
 * Detection logic:
 *   - MoveNet runs at ~30fps detecting 17 body keypoints
 *   - We track the RIGHT wrist (index 10) y-position each frame
 *   - "Upward velocity" = how fast the wrist is rising (y decreasing in image coords)
 *   - When velocity exceeds VELOCITY_THRESHOLD, a bite arc starts
 *   - After wrist peaks and comes back down, we finalise one bite
 *   - Cooldown prevents double-counting the return swing
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. CONFIG
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // Wrist upward velocity (pixels/frame, normalised 0-1) to trigger bite start
  VELOCITY_THRESHOLD: 0.008,

  // Minimum number of frames wrist must stay above threshold to count
  MIN_ACTIVE_FRAMES: 4,

  // After bite recorded, ignore motion for this long (ms)
  COOLDOWN_MS: 1200,

  // How long signal must settle (ms) before bite is finalised
  SETTLE_MS: 400,

  // How many wrist positions to keep for the rolling graph (10s at ~30fps)
  GRAPH_HISTORY: 300,

  // Stats refresh interval
  STATS_REFRESH_MS: 500,

  // DataFoundry endpoint
  DATAFOUNDRY_URL:   'https://data.id.tue.nl/api/v1/datasets/entity/19856',
  DATAFOUNDRY_TOKEN: 'OCtQVi9wOTdpQ005L3E1MlIvdDZSRGl5emlMdnhEL2RNbGxNRlZIZjVqND0=',
};

// ─────────────────────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────────────────────
const state = {
  // Camera / model
  detector:       null,
  stream:         null,
  animFrame:      null,
  cameraReady:    false,

  // Wrist tracking
  lastWristY:     null,   // previous normalised y (0=top, 1=bottom)
  wristHistory:   [],     // rolling array of { y, t } for graph

  // Bite detection phases: 'idle' | 'active' | 'settling'
  bitePhase:      'idle',
  biteStartTime:  null,
  activeFrames:   0,      // frames wrist has been above velocity threshold
  settleStart:    null,
  lastBiteEndTime: 0,

  // Meal
  mealActive:     false,
  mealStartTime:  null,
  mealEndTime:    null,
  bites:          [],     // { start, end, duration }
  statsTimer:     null,

  // Charts
  charts: { durations: null, pace: null, gaps: null },
  _lastFrameTime: null,
};

// ─────────────────────────────────────────────────────────────
// 3. DOM REFS
// ─────────────────────────────────────────────────────────────
const ui = {
  btnCamera:        document.getElementById('btnCamera'),
  btnStart:         document.getElementById('btnStart'),
  btnEnd:           document.getElementById('btnEnd'),
  btnReset:         document.getElementById('btnReset'),
  cameraStatusText: document.getElementById('cameraStatusText'),
  statusBadge:      document.getElementById('statusBadge'),
  feedCard:         document.getElementById('feedCard'),
  videoEl:          document.getElementById('videoEl'),
  poseCanvas:       document.getElementById('poseCanvas'),
  biteFlash:          document.getElementById('biteFlash'),
  cameraPlaceholder:  document.getElementById('cameraPlaceholder'),
  chipWrist:          document.getElementById('chipWrist'),
  chipVelocity:       document.getElementById('chipVelocity'),
  chipFps:            document.getElementById('chipFps'),
  phasePill:          document.getElementById('phasePill'),
  signalPhaseLabel:   document.getElementById('signalPhaseLabel'),
  wristCanvas:        document.getElementById('wristCanvas'),
  velocityLabel:      document.getElementById('velocityLabel'),
  biteIndicator:    document.getElementById('biteIndicator'),
  statMealTime:     document.getElementById('statMealTime'),
  statBites:        document.getElementById('statBites'),
  statAvgDuration:  document.getElementById('statAvgDuration'),
  statPace:         document.getElementById('statPace'),
  timelineTrack:    document.getElementById('timelineTrack'),
  timelineEnd:      document.getElementById('timelineEnd'),
  summaryCard:      document.getElementById('summaryCard'),
  sumMealTime:      document.getElementById('sumMealTime'),
  sumBites:         document.getElementById('sumBites'),
  sumAvg:           document.getElementById('sumAvg'),
  sumPace:          document.getElementById('sumPace'),
  surveyCard:       document.getElementById('surveyCard'),
  surveyForm:       document.getElementById('surveyForm'),
  btnSubmit:        document.getElementById('btnSubmit'),
  submitStatus:     document.getElementById('submitStatus'),
  fieldName:        document.getElementById('fieldName'),
  fieldFood:        document.getElementById('fieldFood'),
  fieldContext:     document.getElementById('fieldContext'),
  fieldStress:      document.getElementById('fieldStress'),
  fieldDistraction: document.getElementById('fieldDistraction'),
  fieldNotes:       document.getElementById('fieldNotes'),
};

// Wrist graph canvas context
const wristCtx = ui.wristCanvas.getContext('2d');

// ─────────────────────────────────────────────────────────────
// 4. CAMERA + MODEL SETUP
// ─────────────────────────────────────────────────────────────

async function enableCamera() {
  ui.btnCamera.disabled = true;
  setCameraStatus('Loading model…', 'neutral');

  try {
    // Load MoveNet Lightning (fast, mobile-friendly)
    state.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );
  } catch (err) {
    setCameraStatus('Failed to load model: ' + err.message, false);
    ui.btnCamera.disabled = false;
    return;
  }

  setCameraStatus('Requesting camera…', 'neutral');

  try {
    // Prefer front-facing camera (selfie cam) since phone is propped facing user
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    ui.videoEl.srcObject = state.stream;

    await new Promise(resolve => { ui.videoEl.onloadedmetadata = resolve; });
    ui.videoEl.play();

    // Size the overlay canvas to match the video
    ui.poseCanvas.width  = ui.videoEl.videoWidth;
    ui.poseCanvas.height = ui.videoEl.videoHeight;

    // Show video feed, hide placeholder
    ui.videoEl.classList.add('visible');
    ui.cameraPlaceholder.classList.add('hidden');
    ui.chipFps.textContent = 'model ready';

    state.cameraReady = true;
    ui.btnStart.disabled = false;
    setCameraStatus('Camera active ✓', true);
    setStatusBadge('ready');

    // Start the pose detection loop
    requestAnimationFrame(poseLoop);

  } catch (err) {
    setCameraStatus('Camera error: ' + err.message, false);
    ui.btnCamera.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 5. POSE DETECTION LOOP
// ─────────────────────────────────────────────────────────────

/**
 * Runs every animation frame (~30-60fps).
 * Detects poses, extracts wrist position, runs bite detector.
 */
async function poseLoop() {
  state.animFrame = requestAnimationFrame(poseLoop);

  if (!state.cameraReady || ui.videoEl.readyState < 2) return;

  let poses;
  try {
    poses = await state.detector.estimatePoses(ui.videoEl);
  } catch (e) {
    return; // skip frame on error
  }

  const ctx = ui.poseCanvas.getContext('2d');
  ctx.clearRect(0, 0, ui.poseCanvas.width, ui.poseCanvas.height);

  // FPS counter
  const now2 = performance.now();
  if (state._lastFrameTime) {
    const fps = Math.round(1000 / (now2 - state._lastFrameTime));
    ui.chipFps.textContent = `${fps} fps`;
  }
  state._lastFrameTime = now2;

  if (!poses || poses.length === 0) {
    ui.chipWrist.textContent    = 'Wrist: not visible';
    ui.chipVelocity.textContent = '↑ 0.000';
    updateWristGraph(null, 0);
    return;
  }

  const keypoints = poses[0].keypoints;

  // MoveNet keypoint indices:
  //  9 = left wrist, 10 = right wrist
  // We prefer the wrist with higher confidence; fall back to either
  const leftWrist  = keypoints[9];
  const rightWrist = keypoints[10];

  let wrist = null;
  if (leftWrist.score > 0.3 && rightWrist.score > 0.3) {
    // Use whichever is higher (closer to face = more likely to be eating hand)
    wrist = leftWrist.y < rightWrist.y ? leftWrist : rightWrist;
  } else if (rightWrist.score > 0.3) {
    wrist = rightWrist;
  } else if (leftWrist.score > 0.3) {
    wrist = leftWrist;
  }

  // Draw all visible keypoints for visual feedback
  drawKeypoints(ctx, keypoints);

  if (!wrist) {
    ui.chipWrist.textContent    = 'Wrist: not visible';
    ui.chipVelocity.textContent = '↑ 0.000';
    state.lastWristY = null;
    updateWristGraph(null, 0);
    return;
  }

  // Normalise wrist Y to 0-1 (0 = top of frame, 1 = bottom)
  const normY = wrist.y / ui.poseCanvas.height;

  // Draw wrist highlight
  drawWristHighlight(ctx, wrist);

  // Compute upward velocity (negative = moving up in image = rising wrist)
  let velocity = 0;
  if (state.lastWristY !== null) {
    velocity = state.lastWristY - normY; // positive = wrist moving UP
  }
  state.lastWristY = normY;

  // Update corner chips
  ui.chipWrist.textContent    = `Wrist: ${(normY * 100).toFixed(0)}%`;
  ui.chipVelocity.textContent = `↑ ${velocity.toFixed(4)}`;
  ui.velocityLabel.textContent = `vel: ${velocity.toFixed(4)}`;

  // Update rolling graph
  updateWristGraph(normY, velocity);

  // Run bite detection only during active meal
  if (state.mealActive) {
    detectBite(velocity, normY);
  }
}

// ─────────────────────────────────────────────────────────────
// 6. BITE DETECTION (velocity-based)
// ─────────────────────────────────────────────────────────────

/**
 * Detects one bite per full wrist arc (up toward face, back down).
 *
 * @param {number} velocity  Upward velocity (positive = wrist moving up)
 * @param {number} normY     Normalised wrist Y position (0=top, 1=bottom)
 */
function detectBite(velocity, normY) {
  const now        = Date.now();
  const inCooldown = (now - state.lastBiteEndTime) < CONFIG.COOLDOWN_MS;

  if (state.bitePhase === 'idle') {
    // ── IDLE → ACTIVE: wrist starts moving upward strongly
    if (velocity >= CONFIG.VELOCITY_THRESHOLD && !inCooldown) {
      state.activeFrames++;
      if (state.activeFrames >= CONFIG.MIN_ACTIVE_FRAMES) {
        state.bitePhase    = 'active';
        state.biteStartTime = now;
        state.activeFrames  = 0;
        setPhasePill('active');
      }
    } else {
      state.activeFrames = 0;
    }

  } else if (state.bitePhase === 'active') {
    // ── ACTIVE: wrist is on its way up
    if (velocity < CONFIG.VELOCITY_THRESHOLD) {
      state.bitePhase   = 'settling';
      state.settleStart = now;
      setPhasePill('settling');
    }
    if (now - state.biteStartTime > 4000) {
      state.bitePhase    = 'idle';
      state.biteStartTime = null;
      state.settleStart   = null;
      setPhasePill('idle');
    }

  } else if (state.bitePhase === 'settling') {
    if (velocity >= CONFIG.VELOCITY_THRESHOLD) {
      state.bitePhase   = 'active';
      state.settleStart = null;
      setPhasePill('active');
    } else if (now - state.settleStart >= CONFIG.SETTLE_MS) {
      const duration = state.settleStart - state.biteStartTime;

      if (duration >= 150 && duration <= 3000) {
        recordBite(state.biteStartTime, state.settleStart, duration);
      }

      state.lastBiteEndTime = now;
      state.bitePhase       = 'idle';
      state.biteStartTime   = null;
      state.settleStart     = null;
      state.activeFrames    = 0;
      setPhasePill('idle');
    }
  }
}

function recordBite(start, end, duration) {
  state.bites.push({ start, end, duration });
  flashBiteIndicator();
  flashCameraOverlay();
  addTimelineTick(start);
}

// ─────────────────────────────────────────────────────────────
// 7. DRAWING HELPERS
// ─────────────────────────────────────────────────────────────

function drawKeypoints(ctx, keypoints) {
  keypoints.forEach(kp => {
    if (kp.score < 0.3) return;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(212,119,10,0.7)';
    ctx.fill();
  });
}

function drawWristHighlight(ctx, wrist) {
  // Larger ring around the wrist
  ctx.beginPath();
  ctx.arc(wrist.x, wrist.y, 12, 0, Math.PI * 2);
  ctx.strokeStyle = state.bitePhase === 'active'
    ? 'rgba(212,119,10,1)'
    : 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────
// 8. WRIST GRAPH (rolling 10s strip)
// ─────────────────────────────────────────────────────────────

function updateWristGraph(normY, velocity) {
  const now = Date.now();
  state.wristHistory.push({ y: normY, v: velocity, t: now });

  // Keep only last GRAPH_HISTORY frames
  if (state.wristHistory.length > CONFIG.GRAPH_HISTORY) {
    state.wristHistory.shift();
  }

  // Draw
  const w = ui.wristCanvas.width  = ui.wristCanvas.offsetWidth;
  const h = ui.wristCanvas.height = 60;
  wristCtx.clearRect(0, 0, w, h);

  const hist = state.wristHistory.filter(p => p.y !== null);
  if (hist.length < 2) return;

  // Draw wrist Y line (inverted: low y = high position)
  wristCtx.beginPath();
  wristCtx.strokeStyle = 'rgba(212,119,10,0.8)';
  wristCtx.lineWidth = 1.5;
  hist.forEach((p, i) => {
    const x  = (i / CONFIG.GRAPH_HISTORY) * w;
    const py = p.y * h; // 0=top 1=bottom
    i === 0 ? wristCtx.moveTo(x, py) : wristCtx.lineTo(x, py);
  });
  wristCtx.stroke();

  // Draw velocity line (centred at h/2)
  wristCtx.beginPath();
  wristCtx.strokeStyle = 'rgba(46,125,79,0.7)';
  wristCtx.lineWidth = 1;
  hist.forEach((p, i) => {
    const x  = (i / CONFIG.GRAPH_HISTORY) * w;
    const py = h / 2 - (p.v * h * 8); // scale velocity for visibility
    i === 0 ? wristCtx.moveTo(x, py) : wristCtx.lineTo(x, py);
  });
  wristCtx.stroke();

  // Threshold line
  const threshY = h / 2 - (CONFIG.VELOCITY_THRESHOLD * h * 8);
  wristCtx.beginPath();
  wristCtx.setLineDash([4, 3]);
  wristCtx.strokeStyle = 'rgba(192,57,43,0.5)';
  wristCtx.lineWidth = 1;
  wristCtx.moveTo(0, threshY);
  wristCtx.lineTo(w, threshY);
  wristCtx.stroke();
  wristCtx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────
// 9. MEAL CONTROLS
// ─────────────────────────────────────────────────────────────

function startMeal() {
  Object.assign(state, {
    mealActive: true,
    mealStartTime: Date.now(),
    mealEndTime: null,
    bites: [],
    bitePhase: 'idle',
    biteStartTime: null,
    settleStart: null,
    activeFrames: 0,
    lastBiteEndTime: 0,
    lastWristY: null,
  });

  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(t => t.remove());
  ui.timelineEnd.textContent = '—';
  ui.btnStart.disabled = true;
  ui.btnEnd.disabled   = false;
  ui.btnReset.disabled = true;
  setStatusBadge('eating');
  state.statsTimer = setInterval(refreshStats, CONFIG.STATS_REFRESH_MS);
}

function endMeal() {
  state.mealActive  = false;
  state.mealEndTime = Date.now();
  clearInterval(state.statsTimer);
  refreshStats();

  ui.btnEnd.disabled   = true;
  ui.btnStart.disabled = true;
  ui.btnReset.disabled = false;
  setStatusBadge('done');

  ui.timelineEnd.textContent = formatDuration(state.mealEndTime - state.mealStartTime);
  rescaleTimeline();
  renderSummary();

  ui.summaryCard.hidden = false;
  ui.surveyCard.hidden  = false;
  setTimeout(() => ui.summaryCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
}

function resetAll() {
  clearInterval(state.statsTimer);
  if (state.animFrame) cancelAnimationFrame(state.animFrame);
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());

  Object.assign(state, {
    mealActive: false, mealStartTime: null, mealEndTime: null,
    bites: [], bitePhase: 'idle', biteStartTime: null,
    settleStart: null, activeFrames: 0, lastBiteEndTime: 0,
    lastWristY: null, wristHistory: [], cameraReady: false,
    stream: null, animFrame: null,
  });

  ['durations', 'pace', 'gaps'].forEach(k => {
    if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
  });

  ui.statMealTime.textContent    = '0:00';
  ui.statBites.textContent       = '0';
  ui.statAvgDuration.textContent = '0.0s';
  ui.statPace.textContent        = '0.0';
  ui.biteIndicator.classList.remove('visible');
  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(t => t.remove());
  ui.timelineEnd.textContent = '—';
  ui.summaryCard.hidden      = true;
  ui.surveyCard.hidden       = true;
  ui.feedCard.hidden         = true;
  ui.surveyForm.reset();
  ui.submitStatus.hidden     = true;
  ui.btnSubmit.disabled      = false;
  ui.btnSubmit.textContent   = 'Submit';
  ui.btnCamera.disabled      = false;
  ui.btnStart.disabled       = true;
  ui.btnEnd.disabled         = true;
  setCameraStatus('Not started', 'neutral');
  setStatusBadge('idle');
  setPhasePill('idle');
  if (ui.signalPhaseLabel) ui.signalPhaseLabel.textContent = '(waiting)';
  if (ui.chipFps) ui.chipFps.textContent = 'model loading…';
  if (ui.chipWrist) ui.chipWrist.textContent = 'Wrist: —';
  if (ui.chipVelocity) ui.chipVelocity.textContent = '↑ 0.000';
  if (ui.cameraPlaceholder) ui.cameraPlaceholder.classList.remove('hidden');
  if (ui.videoEl) ui.videoEl.classList.remove('visible');
}

// ─────────────────────────────────────────────────────────────
// 10. LIVE STATS
// ─────────────────────────────────────────────────────────────

function refreshStats() {
  const now     = state.mealActive ? Date.now() : (state.mealEndTime || Date.now());
  const elapsed = state.mealStartTime ? now - state.mealStartTime : 0;
  const count   = state.bites.length;

  ui.statMealTime.textContent = formatDuration(elapsed);
  ui.statBites.textContent    = count;

  const avg = count > 0 ? state.bites.reduce((s, b) => s + b.duration, 0) / count : 0;
  ui.statAvgDuration.textContent = (avg / 1000).toFixed(1) + 's';

  const pace = elapsed > 0 && count > 0 ? count / (elapsed / 60000) : 0;
  ui.statPace.textContent = pace.toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// 11. TIMELINE
// ─────────────────────────────────────────────────────────────

function addTimelineTick(biteStart) {
  if (!state.mealStartTime) return;
  const elapsed = Date.now() - state.mealStartTime;
  if (elapsed <= 0) return;
  const relMs = biteStart - state.mealStartTime;
  const pct   = Math.max(0, Math.min((relMs / elapsed) * 100, 100));
  const tick  = document.createElement('div');
  tick.className      = 'timeline-tick';
  tick.style.left     = pct + '%';
  tick.dataset.biteMs = relMs;
  ui.timelineTrack.appendChild(tick);
}

function rescaleTimeline() {
  const totalMs = state.mealEndTime - state.mealStartTime;
  if (totalMs <= 0) return;
  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(tick => {
    const pct = Math.max(0, Math.min((parseFloat(tick.dataset.biteMs) / totalMs) * 100, 100));
    tick.style.left = pct + '%';
  });
}

// ─────────────────────────────────────────────────────────────
// 12. POST-MEAL SUMMARY + CHARTS
// ─────────────────────────────────────────────────────────────

function cd() {
  return { color: '#6b6460', font: { family: "'DM Mono', monospace", size: 11 } };
}

function renderSummary() {
  const { bites, mealStartTime, mealEndTime } = state;
  const mealMs = mealEndTime - mealStartTime;
  const count  = bites.length;
  const avgMs  = count > 0 ? bites.reduce((s, b) => s + b.duration, 0) / count : 0;
  const pace   = count > 0 && mealMs > 0 ? count / (mealMs / 60000) : 0;

  ui.sumMealTime.textContent = formatDuration(mealMs);
  ui.sumBites.textContent    = count;
  ui.sumAvg.textContent      = (avgMs / 1000).toFixed(1) + 's';
  ui.sumPace.textContent     = pace.toFixed(1);

  if (count === 0) return;

  // Chart 1: bite durations
  const durData   = bites.map(b => +(b.duration / 1000).toFixed(2));
  const avgSec    = +(avgMs / 1000).toFixed(2);
  if (state.charts.durations) state.charts.durations.destroy();
  state.charts.durations = new Chart(document.getElementById('chartBiteDurations'), {
    type: 'bar',
    data: {
      labels: bites.map((_, i) => `#${i + 1}`),
      datasets: [
        {
          label: 'Duration (s)',
          data: durData,
          backgroundColor: durData.map(d => d > avgSec ? 'rgba(212,119,10,0.85)' : 'rgba(212,119,10,0.35)'),
          borderColor: 'rgba(212,119,10,1)', borderWidth: 1, borderRadius: 4,
        },
        {
          type: 'line', label: 'Average', data: durData.map(() => avgSec),
          borderColor: '#c0392b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0, fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { ...cd(), boxWidth: 12 } }, tooltip: { callbacks: { label: c => ` ${c.parsed.y}s` } } },
      scales: {
        x: { ticks: { ...cd(), maxRotation: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
      },
    },
  });

  // Chart 2: rolling pace
  const BUCKET = 10000;
  const buckets = Math.max(1, Math.ceil(mealMs / BUCKET));
  const counts  = new Array(buckets).fill(0);
  bites.forEach(b => {
    const idx = Math.min(Math.floor((b.start - mealStartTime) / BUCKET), buckets - 1);
    counts[idx]++;
  });
  const smooth = counts.map((c, i, a) => {
    const s = a.slice(Math.max(0, i - 1), i + 2);
    return +(s.reduce((x, y) => x + y, 0) / s.length * 6).toFixed(1);
  });
  if (state.charts.pace) state.charts.pace.destroy();
  state.charts.pace = new Chart(document.getElementById('chartPace'), {
    type: 'line',
    data: {
      labels: counts.map((_, i) => formatDuration(i * BUCKET)),
      datasets: [{
        label: 'Bites / min', data: smooth,
        borderColor: '#2e7d4f', backgroundColor: 'rgba(46,125,79,0.08)',
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#2e7d4f', fill: true, tension: 0.4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { ...cd(), boxWidth: 12 } }, tooltip: { callbacks: { label: c => ` ${c.parsed.y} bites/min` } } },
      scales: {
        x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { ticks: { ...cd(), callback: v => v + '/min' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
      },
    },
  });

  // Chart 3: inter-bite gaps
  if (count >= 2) {
    const gaps = bites.slice(1).map((b, i) => +((b.start - bites[i].end) / 1000).toFixed(2));
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (state.charts.gaps) state.charts.gaps.destroy();
    state.charts.gaps = new Chart(document.getElementById('chartGaps'), {
      type: 'bar',
      data: {
        labels: gaps.map((_, i) => `${i + 1}→${i + 2}`),
        datasets: [{
          label: 'Gap (s)', data: gaps,
          backgroundColor: gaps.map(g => g > avgGap * 1.5 ? 'rgba(63,99,160,0.8)' : 'rgba(63,99,160,0.35)'),
          borderColor: 'rgba(63,99,160,1)', borderWidth: 1, borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { ...cd(), boxWidth: 12 } }, tooltip: { callbacks: { label: c => ` ${c.parsed.y}s pause` } } },
        scales: {
          x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
        },
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 13. SURVEY SUBMISSION
// ─────────────────────────────────────────────────────────────

async function submitSurvey(e) {
  e.preventDefault();

  const name        = ui.fieldName.value.trim();
  const food        = ui.fieldFood.value.trim();
  const context     = ui.fieldContext.value;
  const stress      = ui.fieldStress.value;
  const distraction = ui.fieldDistraction.value;
  const notes       = ui.fieldNotes.value.trim();

  if (!name || !context || !stress || !distraction) {
    showSubmitStatus('Please fill in all required fields.', 'error');
    return;
  }

  const { bites, mealStartTime, mealEndTime } = state;
  const mealMs   = mealStartTime && mealEndTime ? mealEndTime - mealStartTime : 0;
  const biteDurs = bites.map(b => +((b.duration / 1000).toFixed(2)));
  const avgDur   = biteDurs.length ? +(biteDurs.reduce((s, d) => s + d, 0) / biteDurs.length).toFixed(2) : 0;
  const pace     = mealMs > 0 && bites.length > 0 ? +(bites.length / (mealMs / 60000)).toFixed(2) : 0;
  const date     = new Date().toISOString().slice(0, 10);
  const identifier = `${name}_${food || 'unknown'}_${date}`;

  ui.btnSubmit.disabled = true;
  showSubmitStatus('Sending…', '');

  try {
    const res = await fetch(CONFIG.DATAFOUNDRY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_token':    CONFIG.DATAFOUNDRY_TOKEN,
        'resource_id':  identifier,
        'token':        identifier,
      },
      body: JSON.stringify({
        detection_method: 'camera',   // so you can tell apart camera vs gyro data
        name, food, context, stress, distraction, notes,
        meal_time_seconds:  parseFloat((mealMs / 1000).toFixed(1)),
        bite_count:         bites.length,
        avg_bite_duration:  avgDur,
        pace_bites_per_min: pace,
        bite_durations:     biteDurs.join(','),
      }),
    });

    if (res.ok) {
      showSubmitStatus('Submitted successfully! ✓', 'success');
      ui.btnSubmit.textContent = 'Submitted ✓';
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    showSubmitStatus('Submission failed: ' + err.message, 'error');
    ui.btnSubmit.disabled = false;
    console.error('[BiteTrack Camera]', err);
  }
}

function showSubmitStatus(msg, type) {
  ui.submitStatus.hidden      = false;
  ui.submitStatus.textContent = msg;
  ui.submitStatus.className   = 'submit-status ' + type;
}

// ─────────────────────────────────────────────────────────────
// 14. UTILITIES
// ─────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let biteFlashTimer = null;
function flashBiteIndicator() {
  ui.biteIndicator.classList.add('visible');
  clearTimeout(biteFlashTimer);
  biteFlashTimer = setTimeout(() => ui.biteIndicator.classList.remove('visible'), 700);
}

let cameraFlashTimer = null;
function flashCameraOverlay() {
  ui.biteFlash.classList.add('flash');
  clearTimeout(cameraFlashTimer);
  cameraFlashTimer = setTimeout(() => ui.biteFlash.classList.remove('flash'), 300);
}

function setPhasePill(phase) {
  const labels = { idle: 'idle', active: 'wrist rising ↑', settling: 'settling…' };
  ui.phasePill.textContent  = labels[phase] || phase;
  ui.phasePill.className    = `phase-pill phase-${phase}`;
  ui.signalPhaseLabel.textContent = `(${labels[phase] || phase})`;
}

function setCameraStatus(text, state) {
  ui.cameraStatusText.textContent = text;
  ui.cameraStatusText.style.color =
    state === true ? 'var(--success)' :
    state === false ? 'var(--danger)' :
    'var(--text-secondary)';
}

const BADGE = { idle: 'Idle', ready: 'Ready', eating: 'Eating', done: 'Done' };
function setStatusBadge(s) {
  ui.statusBadge.textContent = BADGE[s] || s;
  ui.statusBadge.className   = `status-badge status-${s}`;
}

// ─────────────────────────────────────────────────────────────
// 15. EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

ui.btnCamera.addEventListener('click',   enableCamera);
ui.btnStart.addEventListener('click',    startMeal);
ui.btnEnd.addEventListener('click',      endMeal);
ui.btnReset.addEventListener('click',    resetAll);
ui.surveyForm.addEventListener('submit', submitSurvey);
