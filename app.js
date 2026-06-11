'use strict';

// ── Storage key ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'meditationPresets';

// ── State ────────────────────────────────────────────────────────────────────
let presets = loadPresets();

const session = {
  presetId: null,
  phases: [],
  status: 'idle',       // idle | running | paused | done
  currentIndex: 0,
  elapsed: 0,
  resumeTimestamp: null,
  elapsedAtResume: 0,
  intervalId: null,
};

let editingPresetId = null; // null = new preset
let wakeLock = null;
let audioCtx = null;

// ── Audio ────────────────────────────────────────────────────────────────────
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function ringBell(freq, decaySec, startOffset = 0) {
  const ctx = getAudioCtx();
  const t = ctx.currentTime + startOffset;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(freq, t);
  gain1.gain.setValueAtTime(0.55, t);
  gain1.gain.exponentialRampToValueAtTime(0.001, t + decaySec);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(t);
  osc1.stop(t + decaySec);

  // Non-harmonic partial for warmth
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2.756, t);
  gain2.gain.setValueAtTime(0.18, t);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + decaySec * 0.55);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(t);
  osc2.stop(t + decaySec * 0.55);
}

function ringPhaseBell() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  ringBell(528, 3.0);
}

function ringEndBell() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  ringBell(440, 4.0, 0);
  ringBell(440, 4.0, 1.4);
  ringBell(440, 4.0, 2.8);
}

// ── Persistence ──────────────────────────────────────────────────────────────
function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function savePresets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

function upsertPreset(preset) {
  const idx = presets.findIndex(p => p.id === preset.id);
  if (idx >= 0) presets[idx] = preset;
  else presets.push(preset);
  savePresets();
}

function deletePreset(id) {
  presets = presets.filter(p => p.id !== id);
  savePresets();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function newId() { return crypto.randomUUID(); }

function formatTime(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function totalDuration(phases) {
  return phases.reduce((sum, p) => sum + p.duration, 0);
}

function blankPhase() {
  return { id: newId(), name: 'Phase', duration: 120, bellOnStart: true };
}

// ── View switching ────────────────────────────────────────────────────────────
function showView(name) {
  document.body.setAttribute('data-view', name);
}

// ── Library view ─────────────────────────────────────────────────────────────
function renderLibrary() {
  const list = document.getElementById('preset-list');
  const empty = document.getElementById('library-empty');

  // Remove old cards (keep empty hint)
  list.querySelectorAll('.preset-card').forEach(el => el.remove());

  if (presets.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  presets.forEach(preset => {
    const card = document.createElement('li');
    card.className = 'preset-card';
    card.innerHTML = `
      <div class="preset-card-info">
        <div class="preset-card-name">${escHtml(preset.name || 'Untitled')}</div>
        <div class="preset-card-meta">${preset.phases.length} phase${preset.phases.length !== 1 ? 's' : ''} &middot; ${formatTime(totalDuration(preset.phases))}</div>
      </div>
      <button class="preset-card-delete" aria-label="Delete preset" title="Delete">&#128465;</button>
    `;
    card.querySelector('.preset-card-info').addEventListener('click', () => openEditor(preset.id));
    card.querySelector('.preset-card-delete').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete "${preset.name || 'Untitled'}"?`)) {
        deletePreset(preset.id);
        renderLibrary();
      }
    });
    list.appendChild(card);
  });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Editor view ──────────────────────────────────────────────────────────────
function openEditor(presetId) {
  editingPresetId = presetId || null;
  const preset = presetId ? presets.find(p => p.id === presetId) : null;

  document.getElementById('preset-name').value = preset ? preset.name : '';
  renderPhaseList(preset ? JSON.parse(JSON.stringify(preset.phases)) : [blankPhase()]);
  showView('editor');
}

function renderPhaseList(phases) {
  const list = document.getElementById('phase-list');
  list.innerHTML = '';
  phases.forEach((phase, i) => addPhaseRow(list, phase, i));
  updateTotalDuration();
}

function addPhaseRow(list, phase) {
  const li = document.createElement('li');
  li.className = 'phase-row';
  li.dataset.id = phase.id;
  const mm = Math.floor(phase.duration / 60);
  const ss = phase.duration % 60;
  li.innerHTML = `
    <div class="phase-row-top">
      <input class="phase-name-input" type="text" placeholder="Phase name" value="${escHtml(phase.name)}" />
      <button class="btn-delete-phase" aria-label="Delete phase">&#10005;</button>
    </div>
    <div class="phase-row-bottom">
      <div class="duration-group">
        <label>min</label>
        <input class="duration-input dur-min" type="number" min="0" max="99" value="${mm}" />
      </div>
      <div class="duration-group">
        <label>sec</label>
        <input class="duration-input dur-sec" type="number" min="0" max="59" value="${ss}" />
      </div>
      <label class="bell-label">
        <input type="checkbox" class="bell-check" ${phase.bellOnStart ? 'checked' : ''} />
        &#128276; Bell on start
      </label>
    </div>
  `;

  li.querySelector('.btn-delete-phase').addEventListener('click', () => {
    li.remove();
    updateTotalDuration();
  });
  li.querySelector('.dur-min').addEventListener('change', updateTotalDuration);
  li.querySelector('.dur-sec').addEventListener('change', updateTotalDuration);

  list.appendChild(li);
}

function getEditorPhases() {
  return Array.from(document.querySelectorAll('#phase-list .phase-row')).map(row => {
    const mm = parseInt(row.querySelector('.dur-min').value, 10) || 0;
    const ss = parseInt(row.querySelector('.dur-sec').value, 10) || 0;
    return {
      id: row.dataset.id,
      name: row.querySelector('.phase-name-input').value.trim() || 'Phase',
      duration: mm * 60 + ss,
      bellOnStart: row.querySelector('.bell-check').checked,
    };
  });
}

function updateTotalDuration() {
  const phases = getEditorPhases();
  const total = totalDuration(phases);
  document.getElementById('total-duration-display').textContent =
    phases.length ? `Total: ${formatTime(total)}` : '';
}

function saveCurrentPreset() {
  const name = document.getElementById('preset-name').value.trim() || 'Untitled';
  const phases = getEditorPhases();
  if (phases.length === 0) { alert('Add at least one phase.'); return null; }
  if (phases.some(p => p.duration === 0)) { alert('All phases must have a duration > 0.'); return null; }

  const preset = {
    id: editingPresetId || newId(),
    name,
    createdAt: Date.now(),
    phases,
  };
  editingPresetId = preset.id;
  upsertPreset(preset);
  return preset;
}

// ── Timer state machine ──────────────────────────────────────────────────────
function startSession(phases, presetId) {
  session.presetId = presetId;
  session.phases = JSON.parse(JSON.stringify(phases));
  session.status = 'idle';
  session.currentIndex = 0;
  session.elapsed = 0;
  session.intervalId = null;

  renderSessionUI();
  showView('session');
  resumeTimer();
}

function resumeTimer() {
  if (session.status === 'done') return;
  session.status = 'running';
  session.resumeTimestamp = Date.now();
  session.elapsedAtResume = session.elapsed;

  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  if (session.elapsed === 0 && session.currentIndex === 0) {
    // Session just started — ring bell for phase 0 if enabled
    if (session.phases[0]?.bellOnStart) ringPhaseBell();
  }

  updatePlayPauseBtn();
  acquireWakeLock();

  session.intervalId = setInterval(tick, 250);
}

function pauseTimer() {
  if (session.status !== 'running') return;
  clearInterval(session.intervalId);
  session.intervalId = null;
  session.status = 'paused';
  updatePlayPauseBtn();
  releaseWakeLock();
}

function tick() {
  if (session.status !== 'running') return;
  const wallElapsed = Math.floor((Date.now() - session.resumeTimestamp) / 1000);
  session.elapsed = session.elapsedAtResume + wallElapsed;

  const phase = session.phases[session.currentIndex];
  if (session.elapsed >= phase.duration) {
    advancePhase();
  } else {
    updateCountdownUI();
  }
}

function advancePhase() {
  clearInterval(session.intervalId);
  session.intervalId = null;

  if (session.currentIndex < session.phases.length - 1) {
    session.currentIndex++;
    session.elapsed = 0;
    const next = session.phases[session.currentIndex];
    if (next.bellOnStart) ringPhaseBell();
    session.status = 'running';
    session.resumeTimestamp = Date.now();
    session.elapsedAtResume = 0;
    session.intervalId = setInterval(tick, 250);
    updateSessionUI();
  } else {
    session.status = 'done';
    session.elapsed = session.phases[session.currentIndex].duration;
    updateCountdownUI();
    updateQueueUI();
    ringEndBell();
    releaseWakeLock();
    document.getElementById('done-banner').classList.remove('hidden');
  }
}

function skipPhase() {
  if (session.status === 'done') return;
  clearInterval(session.intervalId);
  session.intervalId = null;
  session.elapsed = session.phases[session.currentIndex].duration;
  advancePhase();
}

function resetSession() {
  clearInterval(session.intervalId);
  session.intervalId = null;
  session.status = 'idle';
  session.elapsed = 0;
  session.currentIndex = 0;
  releaseWakeLock();
  document.getElementById('done-banner').classList.add('hidden');
}

// ── Session UI ───────────────────────────────────────────────────────────────
function renderSessionUI() {
  document.getElementById('session-preset-name').textContent = session.phases.length
    ? (presets.find(p => p.id === session.presetId)?.name || 'Session') : '';
  renderQueueList();
  updateSessionUI();
}

function updateSessionUI() {
  updateCountdownUI();
  updateQueueUI();
}

function updateCountdownUI() {
  const phase = session.phases[session.currentIndex];
  if (!phase) return;
  const remaining = Math.max(0, phase.duration - session.elapsed);
  document.getElementById('countdown').textContent = formatTime(remaining);
  document.getElementById('current-phase-name').textContent = phase.name;

  const phaseProgress = phase.duration > 0 ? (session.elapsed / phase.duration) * 100 : 100;
  document.getElementById('phase-progress-bar').style.width = Math.min(100, phaseProgress) + '%';

  const totalSec = totalDuration(session.phases);
  const elapsedTotal = session.phases.slice(0, session.currentIndex).reduce((s, p) => s + p.duration, 0) + session.elapsed;
  const overallProgress = totalSec > 0 ? (elapsedTotal / totalSec) * 100 : 0;
  document.getElementById('overall-progress-bar').style.width = Math.min(100, overallProgress) + '%';

  const idx = session.currentIndex + 1;
  const total = session.phases.length;
  document.getElementById('phase-counter').textContent = `Phase ${idx} of ${total}`;

  document.title = `${phase.name} — ${formatTime(remaining)} | Meditation Timer`;
}

function renderQueueList() {
  const ul = document.getElementById('phase-queue');
  ul.innerHTML = '';
  session.phases.forEach((phase, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.index = i;
    li.innerHTML = `
      <span class="queue-dot"></span>
      <span class="queue-item-name">${escHtml(phase.name)}</span>
      <span class="queue-item-duration">${formatTime(phase.duration)}</span>
    `;
    ul.appendChild(li);
  });
}

function updateQueueUI() {
  document.querySelectorAll('#phase-queue .queue-item').forEach((li, i) => {
    li.classList.toggle('active', i === session.currentIndex && session.status !== 'done');
    li.classList.toggle('done', i < session.currentIndex || session.status === 'done');
  });
}

function updatePlayPauseBtn() {
  const btn = document.getElementById('btn-play-pause');
  btn.textContent = session.status === 'running' ? '⏸' : '▶';
  btn.setAttribute('aria-label', session.status === 'running' ? 'Pause' : 'Play');
}

// ── Wake Lock ────────────────────────────────────────────────────────────────
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not critical */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ── Event wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-new-timer').addEventListener('click', () => openEditor(null));

document.getElementById('btn-back-library').addEventListener('click', () => {
  showView('library');
  renderLibrary();
});

document.getElementById('btn-add-phase').addEventListener('click', () => {
  const list = document.getElementById('phase-list');
  addPhaseRow(list, blankPhase());
  updateTotalDuration();
});

document.getElementById('btn-save').addEventListener('click', () => {
  const preset = saveCurrentPreset();
  if (preset) alert(`"${preset.name}" saved!`);
});

document.getElementById('btn-start').addEventListener('click', () => {
  const preset = saveCurrentPreset();
  if (!preset) return;
  startSession(preset.phases, preset.id);
});

document.getElementById('btn-play-pause').addEventListener('click', () => {
  if (session.status === 'running') pauseTimer();
  else if (session.status === 'paused' || session.status === 'idle') resumeTimer();
});

document.getElementById('btn-skip').addEventListener('click', skipPhase);

document.getElementById('btn-reset').addEventListener('click', () => {
  if (session.status !== 'idle') {
    if (!confirm('Reset session and return to editor?')) return;
  }
  resetSession();
  openEditor(session.presetId);
});

document.getElementById('btn-back-editor').addEventListener('click', () => {
  if (session.status === 'running') pauseTimer();
  openEditor(session.presetId);
});

document.getElementById('btn-done-reset').addEventListener('click', () => {
  resetSession();
  renderLibrary();
  showView('library');
});

// ── Service Worker registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
renderLibrary();
showView('library');
