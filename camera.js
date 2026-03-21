/**
 * BiteTrack — camera.js
 *
 * Three phases:
 *   SETUP     — camera feed + pose overlay visible, user checks placement
 *   RECORDING — calm pulsing screen, bite detection runs silently in background
 *   REVIEW    — survey → AI feedback → data charts
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. CONFIG
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  VELOCITY_THRESHOLD:    0.002,  // upward wrist velocity to start a bite
  WRIST_HEIGHT_THRESHOLD: 0.7,   // normalised Y (0=top,1=bottom) — wrist must be above this
  COOLDOWN_MS:           1200,   // dead zone after each bite
  GRAPH_HISTORY:         300,    // frames to keep in rolling graph
  STATS_REFRESH_MS:      500,

  // DataFoundry
  DATAFOUNDRY_URL:   'https://data.id.tue.nl/api/v1/datasets/entity/19856',
  DATAFOUNDRY_TOKEN: 'OCtQVi9wOTdpQ005L3E1MlIvdDZSRGl5emlMdnhEL2RNbGxNRlZIZjVqND0=',

  // Anthropic Claude API (for post-meal reflection)
  CLAUDE_MODEL: 'claude-sonnet-4-20250514',
};

// ─────────────────────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────────────────────
const state = {
  // Camera / model
  detector:        null,
  stream:          null,
  animFrame:       null,
  cameraReady:     false,
  _lastFrameTime:  null,

  // Wrist tracking
  lastWristY:      null,
  wristHistory:    [],
  peakVelocity:    0,

  // Bite detection
  bitePhase:       'idle',   // 'idle' | 'active'
  biteStartTime:   null,
  lastBiteEndTime: 0,

  // Meal
  mealActive:      false,
  mealStartTime:   null,
  mealEndTime:     null,
  bites:           [],       // { start, end, duration }
  statsTimer:      null,

  // Charts
  charts: { durations: null, pace: null, gaps: null },
};

// ─────────────────────────────────────────────────────────────
// 3. DOM REFS
// ─────────────────────────────────────────────────────────────
const ui = {
  // Setup view
  setupView:        document.getElementById('setupView'),
  btnCamera:        document.getElementById('btnCamera'),
  btnStart:         document.getElementById('btnStart'),
  cameraStatusText: document.getElementById('cameraStatusText'),
  cameraPlaceholder:document.getElementById('cameraPlaceholder'),
  videoEl:          document.getElementById('videoEl'),
  poseCanvas:       document.getElementById('poseCanvas'),
  biteFlash:        document.getElementById('biteFlash'),
  chipWrist:        document.getElementById('chipWrist'),
  chipVelocity:     document.getElementById('chipVelocity'),
  chipFps:          document.getElementById('chipFps'),
  phasePill:        document.getElementById('phasePill'),
  signalPhaseLabel: document.getElementById('signalPhaseLabel'),
  wristCanvas:      document.getElementById('wristCanvas'),
  velocityLabel:    document.getElementById('velocityLabel'),

  // Recording view
  recordingScreen:  document.getElementById('recordingScreen'),
  recordingTimer:   document.getElementById('recordingTimer'),
  btnEnd:           document.getElementById('btnEnd'),
  btnReset:         document.getElementById('btnReset'),
  statusBadge:      document.getElementById('statusBadge'),

  // Post-meal
  surveyCard:       document.getElementById('surveyCard'),
  surveyForm:       document.getElementById('surveyForm'),
  btnSubmit:        document.getElementById('btnSubmit'),
  submitStatus:     document.getElementById('submitStatus'),
  fieldFood:        document.getElementById('fieldFood'),
  fieldContext:     document.getElementById('fieldContext'),
  fieldStress:      document.getElementById('fieldStress'),
  fieldDistraction: document.getElementById('fieldDistraction'),
  fieldNotes:       document.getElementById('fieldNotes'),

  // Feedback
  feedbackCard:     document.getElementById('feedbackCard'),
  feedbackLoading:  document.getElementById('feedbackLoading'),
  feedbackText:     document.getElementById('feedbackText'),
  feedbackDivider:  document.getElementById('feedbackDivider'),
  feedbackMeta:     document.getElementById('feedbackMeta'),

  // Charts
  summaryCard:      document.getElementById('summaryCard'),
  sumMealTime:      document.getElementById('sumMealTime'),
  sumBites:         document.getElementById('sumBites'),
  sumAvg:           document.getElementById('sumAvg'),
  sumPace:          document.getElementById('sumPace'),
};

const wristCtx = ui.wristCanvas.getContext('2d');

// ─────────────────────────────────────────────────────────────
// 4. CAMERA + MODEL SETUP
// ─────────────────────────────────────────────────────────────

async function enableCamera() {
  ui.btnCamera.disabled = true;
  setCameraStatus('Loading pose model…', 'neutral');

  try {
    state.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );
  } catch (err) {
    setCameraStatus('Model failed: ' + err.message, false);
    ui.btnCamera.disabled = false;
    return;
  }

  setCameraStatus('Requesting camera access…', 'neutral');

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    ui.videoEl.srcObject = state.stream;
    await new Promise(res => { ui.videoEl.onloadedmetadata = res; });
    ui.videoEl.play();

    ui.poseCanvas.width  = ui.videoEl.videoWidth;
    ui.poseCanvas.height = ui.videoEl.videoHeight;

    ui.videoEl.classList.add('visible');
    ui.cameraPlaceholder.classList.add('hidden');
    ui.chipFps.textContent = 'model ready';

    state.cameraReady    = true;
    ui.btnStart.disabled = false;
    setCameraStatus('Camera active ✓', true);
    setStatusBadge('ready');

    requestAnimationFrame(poseLoop);

  } catch (err) {
    setCameraStatus('Camera error: ' + err.message, false);
    ui.btnCamera.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 5. POSE DETECTION LOOP
// ─────────────────────────────────────────────────────────────

async function poseLoop() {
  state.animFrame = requestAnimationFrame(poseLoop);
  if (!state.cameraReady || ui.videoEl.readyState < 2) return;

  let poses;
  try { poses = await state.detector.estimatePoses(ui.videoEl); }
  catch (e) { return; }

  // FPS
  const now2 = performance.now();
  if (state._lastFrameTime) {
    ui.chipFps.textContent = `${Math.round(1000 / (now2 - state._lastFrameTime))} fps`;
  }
  state._lastFrameTime = now2;

  // Only draw overlays during setup phase (not during recording)
  const inSetup = !state.mealActive && !state.mealEndTime;
  const ctx     = ui.poseCanvas.getContext('2d');
  ctx.clearRect(0, 0, ui.poseCanvas.width, ui.poseCanvas.height);

  if (!poses || poses.length === 0) {
    if (inSetup) {
      ui.chipWrist.textContent    = 'Wrist: not visible';
      ui.chipVelocity.textContent = '↑ 0.000';
    }
    updateWristGraph(null, 0);
    return;
  }

  const keypoints  = poses[0].keypoints;
  const leftWrist  = keypoints[9];
  const rightWrist = keypoints[10];

  let wrist = null;
  if (leftWrist.score > 0.3 && rightWrist.score > 0.3) {
    wrist = leftWrist.y < rightWrist.y ? leftWrist : rightWrist;
  } else if (rightWrist.score > 0.3) {
    wrist = rightWrist;
  } else if (leftWrist.score > 0.3) {
    wrist = leftWrist;
  }

  // Draw overlays only in setup
  if (inSetup) {
    drawKeypoints(ctx, keypoints);
    if (wrist) drawWristHighlight(ctx, wrist);
  }

  if (!wrist) {
    if (inSetup) {
      ui.chipWrist.textContent    = 'Wrist: not visible';
      ui.chipVelocity.textContent = '↑ 0.000';
    }
    state.lastWristY = null;
    updateWristGraph(null, 0);
    return;
  }

  const normY    = wrist.y / ui.poseCanvas.height;
  let velocity   = 0;
  if (state.lastWristY !== null) velocity = state.lastWristY - normY;
  state.lastWristY = normY;

  // Track peak velocity for tuning display
  if (velocity > state.peakVelocity) state.peakVelocity = velocity;

  if (inSetup) {
    ui.chipWrist.textContent    = `Wrist: ${(normY * 100).toFixed(0)}%`;
    ui.chipVelocity.textContent = `↑ now: ${velocity.toFixed(4)} | peak: ${state.peakVelocity.toFixed(4)}`;
    ui.velocityLabel.textContent = `vel: ${velocity.toFixed(4)} | peak: ${state.peakVelocity.toFixed(4)}`;
  }

  updateWristGraph(normY, velocity);

  if (state.mealActive) detectBite(velocity, normY);
}

// ─────────────────────────────────────────────────────────────
// 6. BITE DETECTION
// ─────────────────────────────────────────────────────────────

/**
 * Dual-threshold detector with duration tracking.
 * Bite starts when BOTH velocity AND wrist height cross their thresholds.
 * Bite ends (and is recorded) when either drops back below.
 */
function detectBite(velocity, normY) {
  const now        = Date.now();
  const inCooldown = (now - state.lastBiteEndTime) < CONFIG.COOLDOWN_MS;
  const bothAbove  = velocity >= CONFIG.VELOCITY_THRESHOLD &&
                     normY    <= CONFIG.WRIST_HEIGHT_THRESHOLD;

  if (inCooldown) { setPhasePill('settling'); return; }

  if (state.bitePhase === 'idle') {
    if (bothAbove) {
      state.bitePhase    = 'active';
      state.biteStartTime = now;
      setPhasePill('active');
    }
  } else if (state.bitePhase === 'active') {
    if (!bothAbove) {
      const duration = now - state.biteStartTime;
      recordBite(state.biteStartTime, now, duration);
      state.lastBiteEndTime = now;
      state.biteStartTime   = null;
      state.bitePhase       = 'idle';
      setPhasePill('idle');
    }
  }
}

function recordBite(start, end, duration) {
  state.bites.push({ start, end, duration });
  // Flash the overlay briefly even during recording (visible on camera but not to user)
  flashCameraOverlay();
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
  ctx.beginPath();
  ctx.arc(wrist.x, wrist.y, 12, 0, Math.PI * 2);
  ctx.strokeStyle = state.bitePhase === 'active'
    ? 'rgba(212,119,10,1)' : 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────
// 8. WRIST GRAPH
// ─────────────────────────────────────────────────────────────

function updateWristGraph(normY, velocity) {
  state.wristHistory.push({ y: normY, v: velocity, t: Date.now() });
  if (state.wristHistory.length > CONFIG.GRAPH_HISTORY) state.wristHistory.shift();

  const w = ui.wristCanvas.width  = ui.wristCanvas.offsetWidth;
  const h = ui.wristCanvas.height = 70;
  wristCtx.clearRect(0, 0, w, h);

  const hist = state.wristHistory.filter(p => p.y !== null);
  if (hist.length < 2) return;

  // Wrist height line
  wristCtx.beginPath();
  wristCtx.strokeStyle = 'rgba(212,119,10,0.8)';
  wristCtx.lineWidth = 1.5;
  hist.forEach((p, i) => {
    const x = (i / CONFIG.GRAPH_HISTORY) * w;
    const y = p.y * h;
    i === 0 ? wristCtx.moveTo(x, y) : wristCtx.lineTo(x, y);
  });
  wristCtx.stroke();

  // Velocity line (centred)
  wristCtx.beginPath();
  wristCtx.strokeStyle = 'rgba(46,125,79,0.7)';
  wristCtx.lineWidth = 1;
  hist.forEach((p, i) => {
    const x = (i / CONFIG.GRAPH_HISTORY) * w;
    const y = h / 2 - (p.v * h * 8);
    i === 0 ? wristCtx.moveTo(x, y) : wristCtx.lineTo(x, y);
  });
  wristCtx.stroke();

  // Velocity threshold line (red dashed)
  const velThreshY = h / 2 - (CONFIG.VELOCITY_THRESHOLD * h * 8);
  wristCtx.beginPath();
  wristCtx.setLineDash([4, 3]);
  wristCtx.strokeStyle = 'rgba(192,57,43,0.6)';
  wristCtx.lineWidth = 1.5;
  wristCtx.moveTo(0, velThreshY);
  wristCtx.lineTo(w, velThreshY);
  wristCtx.stroke();

  // Wrist height threshold line (blue dashed)
  const heightThreshY = CONFIG.WRIST_HEIGHT_THRESHOLD * h;
  wristCtx.beginPath();
  wristCtx.strokeStyle = 'rgba(55,48,163,0.6)';
  wristCtx.moveTo(0, heightThreshY);
  wristCtx.lineTo(w, heightThreshY);
  wristCtx.stroke();
  wristCtx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────
// 9. MEAL CONTROLS
// ─────────────────────────────────────────────────────────────

function startMeal() {
  Object.assign(state, {
    mealActive: true, mealStartTime: Date.now(), mealEndTime: null,
    bites: [], bitePhase: 'idle', biteStartTime: null,
    lastBiteEndTime: 0, lastWristY: null, peakVelocity: 0,
  });

  // Switch views
  ui.setupView.style.display = 'none';
  ui.recordingScreen.classList.add('active');
  setStatusBadge('eating');

  // Start the live timer display
  state.statsTimer = setInterval(() => {
    const elapsed = Date.now() - state.mealStartTime;
    ui.recordingTimer.textContent = formatDuration(elapsed);
  }, 500);
}

function endMeal() {
  state.mealActive  = false;
  state.mealEndTime = Date.now();
  clearInterval(state.statsTimer);

  // Hide recording screen, show survey
  ui.recordingScreen.classList.remove('active');
  ui.surveyCard.hidden  = false;
  setStatusBadge('done');

  setTimeout(() => ui.surveyCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

function resetAll() {
  clearInterval(state.statsTimer);
  if (state.animFrame) cancelAnimationFrame(state.animFrame);
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());

  Object.assign(state, {
    mealActive: false, mealStartTime: null, mealEndTime: null,
    bites: [], bitePhase: 'idle', biteStartTime: null,
    lastBiteEndTime: 0, lastWristY: null, wristHistory: [],
    cameraReady: false, stream: null, animFrame: null, _lastFrameTime: null,
    peakVelocity: 0,
  });

  ['durations', 'pace', 'gaps'].forEach(k => {
    if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
  });

  // Restore setup view
  ui.setupView.style.display = '';
  ui.recordingScreen.classList.remove('active');
  ui.recordingTimer.textContent = '0:00';
  ui.surveyCard.hidden          = true;
  ui.feedbackCard.hidden        = true;
  ui.summaryCard.hidden         = true;
  ui.surveyForm.reset();
  ui.submitStatus.hidden        = true;
  ui.btnSubmit.disabled         = false;
  ui.btnSubmit.textContent      = 'See My Feedback';
  ui.btnStart.disabled          = true;
  ui.btnCamera.disabled         = false;
  ui.videoEl.classList.remove('visible');
  ui.cameraPlaceholder.classList.remove('hidden');
  ui.chipFps.textContent        = 'model loading…';
  ui.chipWrist.textContent      = 'Wrist: —';
  ui.chipVelocity.textContent   = '↑ 0.000';
  ui.feedbackText.hidden        = true;
  ui.feedbackText.textContent   = '';
  ui.feedbackLoading.style.display = 'flex';
  setCameraStatus('Not started', 'neutral');
  setStatusBadge('idle');
  setPhasePill('idle');
}

// ─────────────────────────────────────────────────────────────
// 10. SURVEY SUBMISSION + AI FEEDBACK
// ─────────────────────────────────────────────────────────────

async function submitSurvey(e) {
  e.preventDefault();

  const food        = ui.fieldFood.value.trim();
  const context     = ui.fieldContext.value;
  const stress      = ui.fieldStress.value;
  const distraction = ui.fieldDistraction.value;
  const notes       = ui.fieldNotes.value.trim();

  if (!context || !stress || !distraction) {
    showSubmitStatus('Please fill in all required fields.', 'error');
    return;
  }

  const { bites, mealStartTime, mealEndTime } = state;
  const mealMs   = mealStartTime && mealEndTime ? mealEndTime - mealStartTime : 0;
  const biteDurs = bites.map(b => +((b.duration / 1000).toFixed(2)));
  const avgDur   = biteDurs.length
    ? +(biteDurs.reduce((s, d) => s + d, 0) / biteDurs.length).toFixed(2) : 0;
  const pace     = mealMs > 0 && bites.length > 0
    ? +(bites.length / (mealMs / 60000)).toFixed(2) : 0;
  const date       = new Date().toISOString().slice(0, 10);
  const identifier = `anonymous_${food || 'unknown'}_${date}`;

  ui.btnSubmit.disabled = true;
  showSubmitStatus('Saving your data…', '');

  // ── Send to DataFoundry ──────────────────────────────────
  try {
    await fetch(CONFIG.DATAFOUNDRY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_token':    CONFIG.DATAFOUNDRY_TOKEN,
        'resource_id':  identifier,
        'token':        identifier,
      },
      body: JSON.stringify({
        detection_method:   'camera',
        food, context, stress, distraction, notes,
        meal_time_seconds:  parseFloat((mealMs / 1000).toFixed(1)),
        bite_count:         bites.length,
        avg_bite_duration:  avgDur,
        pace_bites_per_min: pace,
        bite_durations:     biteDurs.join(','),
      }),
    });
  } catch (err) {
    console.warn('[BiteTrack] DataFoundry error:', err);
    // Don't block feedback if data save fails
  }

  ui.submitStatus.hidden = true;

  // ── Show feedback card + charts ──────────────────────────
  ui.surveyCard.hidden  = false; // keep visible so they can scroll up
  ui.feedbackCard.hidden = false;
  ui.summaryCard.hidden  = false;
  renderSummary();

  ui.feedbackCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // ── Generate AI feedback ─────────────────────────────────
  await generateFeedback({ food, context, stress, distraction, notes, mealMs, bites, pace, avgDur });
}

// ─────────────────────────────────────────────────────────────
// 11. AI FEEDBACK (Claude API)
// ─────────────────────────────────────────────────────────────

async function generateFeedback({ food, context, stress, distraction, notes, mealMs, bites, pace, avgDur }) {
  const mealMins    = (mealMs / 60000).toFixed(1);
  const biteCount   = bites.length;
  const contextMap  = { alone: 'alone', with_others: 'with others', public: 'in a public place' };
  const contextText = contextMap[context] || context;

  // Build inter-bite gaps for richer context
  const gaps = bites.slice(1).map((b, i) => +((b.start - bites[i].end) / 1000).toFixed(1));
  const avgGap = gaps.length ? (gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(1) : 'unknown';

  const prompt = `You are a warm, encouraging eating behaviour researcher giving gentle post-meal feedback to a study participant. 
Your tone is kind, curious, and non-judgmental — like a supportive friend who happens to know about mindful eating. 
You NEVER mention weight, calories, dieting, or body image. You focus only on pace, rhythm, and the experience of eating.

Here is the participant's meal data:
- Food eaten: ${food || 'not specified'}
- Meal duration: ${mealMins} minutes
- Number of bites detected: ${biteCount}
- Average bites per minute: ${pace}
- Average bite duration: ${avgDur}s
- Average pause between bites: ${avgGap}s
- Eating context: ${contextText}
- Stress level today: ${stress}
- Distracted while eating: ${distraction}
- Their own notes: "${notes || 'none'}"

Write 3–4 short paragraphs of personalised reflection covering:
1. Their eating pace — describe it gently and what it might reflect (not judge it)
2. How their stress level or context may have played a role in how they ate
3. One small, specific, and easy thing they could try next time to bring a little more awareness to their meal — frame it as something to explore, not a correction

Keep the whole response under 200 words. No bullet points. No headers. Just warm, flowing paragraphs.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      CONFIG.CLAUDE_MODEL,
        max_tokens: 400,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';

    if (text) {
      ui.feedbackLoading.style.display = 'none';
      ui.feedbackText.hidden           = false;
      ui.feedbackText.textContent      = text;
      ui.feedbackDivider.hidden        = false;
      ui.feedbackMeta.hidden           = false;
      ui.feedbackMeta.textContent      = `Generated from your meal on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    } else {
      throw new Error('Empty response');
    }
  } catch (err) {
    ui.feedbackLoading.style.display = 'none';
    ui.feedbackText.hidden           = false;
    ui.feedbackText.textContent      = 'We couldn\'t generate your reflection right now — but your data has been saved. Thank you for participating!';
    console.error('[BiteTrack] AI feedback error:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 12. POST-MEAL CHARTS
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

  const durData = bites.map(b => +(b.duration / 1000).toFixed(2));
  const avgSec  = +(avgMs / 1000).toFixed(2);

  if (state.charts.durations) state.charts.durations.destroy();
  state.charts.durations = new Chart(document.getElementById('chartBiteDurations'), {
    type: 'bar',
    data: {
      labels: bites.map((_, i) => `#${i + 1}`),
      datasets: [
        { label: 'Duration (s)', data: durData, backgroundColor: durData.map(d => d > avgSec ? 'rgba(212,119,10,0.85)' : 'rgba(212,119,10,0.35)'), borderColor: 'rgba(212,119,10,1)', borderWidth: 1, borderRadius: 4 },
        { type: 'line', label: 'Average', data: durData.map(() => avgSec), borderColor: '#c0392b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0, fill: false },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { ...cd(), boxWidth: 12 } } }, scales: { x: { ticks: { ...cd(), maxRotation: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } }, y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true } } },
  });

  const BUCKET  = 10000;
  const buckets = Math.max(1, Math.ceil(mealMs / BUCKET));
  const counts  = new Array(buckets).fill(0);
  bites.forEach(b => { counts[Math.min(Math.floor((b.start - mealStartTime) / BUCKET), buckets - 1)]++; });
  const smooth  = counts.map((c, i, a) => { const s = a.slice(Math.max(0, i - 1), i + 2); return +(s.reduce((x, y) => x + y, 0) / s.length * 6).toFixed(1); });

  if (state.charts.pace) state.charts.pace.destroy();
  state.charts.pace = new Chart(document.getElementById('chartPace'), {
    type: 'line',
    data: { labels: counts.map((_, i) => formatDuration(i * BUCKET)), datasets: [{ label: 'Bites / min', data: smooth, borderColor: '#2e7d4f', backgroundColor: 'rgba(46,125,79,0.08)', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#2e7d4f', fill: true, tension: 0.4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { ...cd(), boxWidth: 12 } } }, scales: { x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } }, y: { ticks: { ...cd(), callback: v => v + '/min' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true } } },
  });

  if (count >= 2) {
    const gaps   = bites.slice(1).map((b, i) => +((b.start - bites[i].end) / 1000).toFixed(2));
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (state.charts.gaps) state.charts.gaps.destroy();
    state.charts.gaps = new Chart(document.getElementById('chartGaps'), {
      type: 'bar',
      data: { labels: gaps.map((_, i) => `${i + 1}→${i + 2}`), datasets: [{ label: 'Gap (s)', data: gaps, backgroundColor: gaps.map(g => g > avgGap * 1.5 ? 'rgba(63,99,160,0.8)' : 'rgba(63,99,160,0.35)'), borderColor: 'rgba(63,99,160,1)', borderWidth: 1, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { ...cd(), boxWidth: 12 } } }, scales: { x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } }, y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true } } },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 13. UTILITIES
// ─────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let cameraFlashTimer = null;
function flashCameraOverlay() {
  ui.biteFlash.classList.add('flash');
  clearTimeout(cameraFlashTimer);
  cameraFlashTimer = setTimeout(() => ui.biteFlash.classList.remove('flash'), 300);
}

function showSubmitStatus(msg, type) {
  ui.submitStatus.hidden      = false;
  ui.submitStatus.textContent = msg;
  ui.submitStatus.className   = 'submit-status ' + type;
}

function setPhasePill(phase) {
  const labels = { idle: 'idle', active: 'wrist rising ↑', settling: 'settling…' };
  ui.phasePill.textContent         = labels[phase] || phase;
  ui.phasePill.className           = `phase-pill phase-${phase}`;
  if (ui.signalPhaseLabel) ui.signalPhaseLabel.textContent = `(${labels[phase] || phase})`;
}

function setCameraStatus(text, ok) {
  ui.cameraStatusText.textContent = text;
  ui.cameraStatusText.style.color =
    ok === true ? 'var(--success)' : ok === false ? 'var(--danger)' : 'var(--text-secondary)';
}

const BADGE = { idle: 'Idle', ready: 'Ready', eating: 'Eating', done: 'Done' };
function setStatusBadge(s) {
  ui.statusBadge.textContent = BADGE[s] || s;
  ui.statusBadge.className   = `status-badge status-${s}`;
}

// ─────────────────────────────────────────────────────────────
// 14. EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

ui.btnCamera.addEventListener('click',   enableCamera);
ui.btnStart.addEventListener('click',    startMeal);
ui.btnEnd.addEventListener('click',      endMeal);
ui.btnReset.addEventListener('click',    resetAll);
ui.surveyForm.addEventListener('submit', submitSurvey);rveyForm.addEventListener('submit', submitSurvey);
