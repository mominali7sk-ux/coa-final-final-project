'use strict';

/**
 * CacheOracle — Cache Optimization & Analysis Lab
 * Professional interactive simulator for six replacement policies.
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const COLORS = {
  "Belady's OPT": '#ab8cff',
  'AI Predictor': '#09d7e8',
  LRU: '#38d996',
  FIFO: '#ffbf5f',
  LFU: '#64a5ff',
  Random: '#ff6582'
};

const POLICIES = ["Belady's OPT", 'AI Predictor', 'LRU', 'FIFO', 'LFU', 'Random'];

const PRESETS = {
  loop: { label: 'Tight loop', description: "A small loop body re-referenced over and over — LRU's dream.", body: 8, count: 1024, pattern: 'loop' },
  sequential: { label: 'Sequential scan', description: 'A streaming pass through memory with little temporal locality.', body: 256, count: 1024, pattern: 'sequential' },
  stride: { label: 'Strided access', description: 'Repeated jumps through an array reveal how the working set maps to cache sets.', body: 32, count: 768, pattern: 'stride' },
  thrash: { label: 'Conflict thrash', description: 'Blocks mapping to the same set compete for a small number of cache lines.', body: 12, count: 768, pattern: 'thrash' },
  working: { label: 'Hot and cold set', description: 'A compact hot set is mixed with occasional cold references.', body: 20, count: 1024, pattern: 'working' },
  random: { label: 'Random workload', description: 'Deterministic pseudo-random accesses across a broad memory region.', body: 256, count: 1024, pattern: 'random' }
};

let trace = [];
let results = null;
let activeTraceTab = 'presets';
let activeResultTab = 'comparison';
let selectedPolicy = 'AI Predictor';
let selectedStep = 0;
let zoom = 1;
let selectedAccess = -1;
let currentPreset = 'thrash';
let playTimer = null;
let playSpeed = 400; // ms per step

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

function getGeometry() {
  const cacheKB = Number($('#cache-size-number')?.value || 16);
  const blockBytes = Number($('#block-size-number')?.value || 64);
  const selectedWays = $('#associativity')?.value || '4';
  const totalLines = Math.floor((cacheKB * 1024) / blockBytes);
  const ways = selectedWays === 'fully' ? totalLines : Number($('#ways-number')?.value || selectedWays);
  const sets = Math.max(1, Math.floor(totalLines / Math.max(1, ways)));
  return { cacheKB, blockBytes, selectedWays, totalLines, ways, sets };
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function updateGeometry() {
  const geometry = getGeometry();
  const error = $('#geometry-error');
  if (results && Object.keys(geometry).some((key) => geometry[key] !== results.geometry[key])) {
    results = null;
    $('#results').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#export-button').disabled = true;
    $('#ask-ai').disabled = true;
    stopPlay();
    showToast('Cache geometry changed — rerun the benchmark to compare policies.');
  }
  const valid =
    Number.isFinite(geometry.cacheKB) &&
    geometry.cacheKB > 0 &&
    Number.isFinite(geometry.blockBytes) &&
    geometry.blockBytes > 0 &&
    Number.isInteger(geometry.cacheKB) &&
    Number.isInteger(geometry.blockBytes) &&
    Number.isInteger(geometry.ways) &&
    geometry.totalLines <= 65536 &&
    isPowerOfTwo(geometry.blockBytes) &&
    geometry.totalLines % geometry.ways === 0 &&
    isPowerOfTwo(geometry.sets) &&
    geometry.totalLines >= 1 &&
    geometry.ways >= 1 &&
    geometry.ways <= geometry.totalLines;
  error.textContent = valid
    ? ''
    : geometry.totalLines > 65536
      ? 'Cache geometry is limited to 65,536 lines for responsive local simulation.'
      : 'Use a power-of-two block size and a whole-line geometry with power-of-two sets.';
  $('#run-benchmark').disabled = !valid || trace.length === 0;
  if (!valid) return false;
  $('#ways-number').disabled = geometry.selectedWays === 'fully';
  if (geometry.selectedWays === 'fully') $('#ways-number').value = geometry.totalLines;

  const offsetBits = Math.floor(Math.log2(geometry.blockBytes));
  const indexBits = Math.floor(Math.log2(Math.max(1, geometry.sets)));
  $('#offset-bits').textContent = `${offsetBits} b`;
  $('#index-bits').textContent = `${indexBits} b`;
  $('#tag-bits').textContent = `${Math.max(0, 32 - offsetBits - indexBits)} b`;
  $('#set-count').textContent = geometry.sets.toLocaleString();
  $('#ways-count').textContent = geometry.ways.toLocaleString();
  $('#line-count').textContent = (geometry.sets * geometry.ways).toLocaleString();
  updateRunCaption();
  return true;
}

function setGeometryValue(selectId, inputId, value) {
  $(selectId).value = value;
  $(inputId).value = value;
  updateGeometry();
}

/* -------------------------------------------------------------------------- */
/* Trace generation & management                                              */
/* -------------------------------------------------------------------------- */

function updateTraceCount() {
  $('#trace-count').textContent = `${trace.length.toLocaleString()} ${trace.length === 1 ? 'address' : 'addresses'}`;
  updateRunCaption();
  $('#run-benchmark').disabled = !trace.length || Boolean($('#geometry-error').textContent);
  if (results) {
    results = null;
    $('#results').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#export-button').disabled = true;
    $('#ask-ai').disabled = true;
    stopPlay();
  }
}

function updateRunCaption() {
  const count = trace.length.toLocaleString();
  $('#run-caption').textContent = `LRU · FIFO · LFU · Random · Belady OPT · AI — on ${count} ${trace.length === 1 ? 'access' : 'accesses'}`;
  $('#timeline-caption').textContent = `${count} accesses · click to inspect`;
}

function generateTrace(pattern, count, body, blockBytes) {
  const safeCount = Math.max(1, Math.min(50000, Math.floor(Number(count) || 1)));
  const safeBody = Math.max(1, Math.min(10000, Math.floor(Number(body) || 1)));
  let seed = 78321;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const addresses = [];
  for (let i = 0; i < safeCount; i++) {
    let block;
    switch (pattern) {
      case 'loop':
        block = i % safeBody;
        break;
      case 'sequential':
        block = i;
        break;
      case 'stride':
        block = (i % safeBody) * 16;
        break;
      case 'thrash':
        block = (i % safeBody) * 64;
        break;
      case 'working':
        block =
          random() < 0.8
            ? Math.floor(random() * Math.max(1, Math.ceil(safeBody / 4)))
            : safeBody + Math.floor(random() * safeBody * 5);
        break;
      case 'random':
        block = Math.floor(random() * safeBody * 2);
        break;
      default:
        block = i % safeBody;
    }
    addresses.push((block * blockBytes) >>> 0);
  }
  return addresses;
}

function renderTraceTab() {
  const target = $('#trace-content');
  if (activeTraceTab === 'presets') {
    const preset = PRESETS[currentPreset];
    target.innerHTML = `
      <select class="trace-select" id="preset-select" aria-label="Trace preset">
        ${Object.entries(PRESETS)
          .map(
            ([key, item]) =>
              `<option value="${key}" ${key === currentPreset ? 'selected' : ''}>${escapeHTML(item.label)}</option>`
          )
          .join('')}
      </select>
      <p class="trace-description">${escapeHTML(preset.description)}</p>
      <div class="trace-options">
        <label>COUNT<input id="preset-count" type="number" min="1" max="50000" value="${preset.count}"></label>
        <label>BODY (BLOCKS)<input id="preset-body" type="number" min="1" max="10000" value="${preset.body}"></label>
        <label>PASSES<input id="preset-passes" type="number" value="${Math.ceil(preset.count / preset.body)}" disabled></label>
      </div>
      <div class="trace-row">
        <button class="button button-quiet generate-button" id="generate-trace">↻ <span>Generate trace</span></button>
        <button class="button button-quiet generate-button" id="save-current-trace">＋ <span>Save trace</span></button>
      </div>`;
    $('#preset-select').addEventListener('change', (event) => {
      currentPreset = event.target.value;
      renderTraceTab();
    });
    const updatePassCount = () => {
      const count = Math.max(1, Number($('#preset-count').value) || 1);
      const body = Math.max(1, Number($('#preset-body').value) || 1);
      $('#preset-passes').value = Math.ceil(count / body);
    };
    $('#preset-count').addEventListener('input', updatePassCount);
    $('#preset-body').addEventListener('input', updatePassCount);
    $('#generate-trace').addEventListener('click', () => {
      const count = Number($('#preset-count').value);
      const body = Number($('#preset-body').value);
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 50000 ||
        !Number.isInteger(body) ||
        body < 1 ||
        body > 10000
      ) {
        showToast('Enter a count from 1–50,000 and a body size from 1–10,000 blocks.', true);
        return;
      }
      trace = generateTrace(PRESETS[currentPreset].pattern, count, body, getGeometry().blockBytes);
      updateTraceCount();
      showToast(`${trace.length.toLocaleString()} address trace generated.`);
    });
    $('#save-current-trace').addEventListener('click', () => saveTrace(PRESETS[currentPreset].label));
  } else if (activeTraceTab === 'paste') {
    target.innerHTML = `
      <textarea class="trace-textarea" id="paste-addresses" placeholder="0x1000, 0x1040, 4160, …" aria-label="Paste memory addresses"></textarea>
      <p class="trace-help">Separate decimal or 0x-prefixed hexadecimal addresses with spaces, commas, or new lines. Maximum 50,000.</p>
      <div class="trace-row"><button class="button button-quiet" id="load-pasted">Load addresses</button><button class="button button-quiet" id="save-pasted" disabled>Save trace</button></div>`;
    $('#load-pasted').addEventListener('click', loadPastedTrace);
    $('#save-pasted').addEventListener('click', () => saveTrace('Pasted trace'));
    $('#paste-addresses').addEventListener('input', () => {
      $('#save-pasted').disabled = true;
    });
  } else {
    const saved = readSavedTraces();
    target.innerHTML = saved.length
      ? saved
          .map(
            (item, index) =>
              `<div class="saved-item"><div><strong>${escapeHTML(item.name)}</strong><small>${item.addresses.length.toLocaleString()} addresses</small></div><div><button class="small-button" data-load-saved="${index}">Load</button> <button class="small-button" data-delete-saved="${index}" aria-label="Delete ${escapeHTML(item.name)}">×</button></div></div>`
          )
          .join('')
      : '<div class="saved-empty">No saved traces yet. Generate a pattern or paste addresses and save it here.</div>';
    $$('[data-load-saved]', target).forEach((button) =>
      button.addEventListener('click', () => {
        const item = readSavedTraces()[Number(button.dataset.loadSaved)];
        if (item) {
          trace = item.addresses;
          updateTraceCount();
          showToast(`Loaded ${item.name}.`);
        }
      })
    );
    $$('[data-delete-saved]', target).forEach((button) =>
      button.addEventListener('click', () => {
        const list = readSavedTraces();
        list.splice(Number(button.dataset.deleteSaved), 1);
        writeSavedTraces(list);
        renderTraceTab();
      })
    );
  }
}

function loadPastedTrace() {
  const raw = $('#paste-addresses').value.trim();
  if (!raw) {
    showToast('Paste at least one memory address.', true);
    return;
  }
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length > 50000) {
    showToast('A trace can contain at most 50,000 addresses.', true);
    return;
  }
  const parsed = [];
  for (const token of tokens) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(token)) {
      showToast(`Invalid address: ${token}`, true);
      return;
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      showToast(`Address is outside the 32-bit address space: ${token}`, true);
      return;
    }
    parsed.push(value);
  }
  trace = parsed;
  updateTraceCount();
  $('#save-pasted').disabled = false;
  showToast(`${trace.length.toLocaleString()} addresses loaded.`);
}

function readSavedTraces() {
  try {
    const data = JSON.parse(localStorage.getItem('cacheoracle-traces') || '[]');
    return Array.isArray(data)
      ? data.filter((item) => item && typeof item.name === 'string' && Array.isArray(item.addresses))
      : [];
  } catch (error) {
    console.warn('Unable to read saved traces.', error);
    showToast(`Unable to read saved traces: ${error.message}`, true);
    return [];
  }
}

function writeSavedTraces(items) {
  try {
    localStorage.setItem('cacheoracle-traces', JSON.stringify(items));
    return true;
  } catch (error) {
    showToast(`Could not save trace: ${error.message}`, true);
    return false;
  }
}

function saveTrace(defaultName = PRESETS[currentPreset]?.label || 'Custom trace') {
  const cleanName = defaultName.trim().slice(0, 60);
  if (!cleanName) {
    showToast('A saved trace needs a name.', true);
    return;
  }
  const saved = readSavedTraces();
  if (saved.length >= 20) {
    showToast('You can save up to 20 traces. Delete one before saving another.', true);
    return;
  }
  saved.push({ name: cleanName, addresses: [...trace] });
  if (writeSavedTraces(saved)) showToast(`Saved “${cleanName}”.`);
}

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
  );
}

/* -------------------------------------------------------------------------- */
/* Core simulation engine                                                     */
/* -------------------------------------------------------------------------- */

function makeFutureLookup(blocks) {
  const positions = new Map();
  blocks.forEach((block, index) => {
    if (!positions.has(block)) positions.set(block, []);
    positions.get(block).push(index);
  });
  return (block, from) => {
    const hits = positions.get(block);
    if (!hits) return Infinity;
    let low = 0;
    let high = hits.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (hits[mid] <= from) low = mid + 1;
      else high = mid;
    }
    return hits[low] ?? Infinity;
  };
}

/**
 * Simulate one replacement policy over a full address trace.
 * Returns events, hit/miss counts, and optional final cache state.
 * Belady's OPT uses true future knowledge.
 * AI Predictor is a first-order online Markov transition heuristic.
 */
function simulatePolicy(policy, addresses, geometry, options = {}) {
  const { blockBytes, ways, sets, totalLines } = geometry;
  const stopAt = options.stopAt ?? addresses.length - 1;
  const fullBlocks = options.fullBlocksForFuture ?? null; // for correct OPT snapshots
  const blocks = addresses.map((address) => Math.floor(address / blockBytes));
  const futureSource = fullBlocks || blocks;
  const futureLookup = policy === "Belady's OPT" ? makeFutureLookup(futureSource) : null;
  const cache = Array.from({ length: sets }, () => []);
  const transitions = new Map();
  const seen = new Set();
  let previousBlock = null;
  let seed = 4199;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const events = [];
  const total = Math.min(addresses.length, stopAt + 1);

  // Fully-associative LRU of size totalLines — used only as a capacity-miss proxy
  // when OPT is not yet available. Later overwritten with true OPT classification.
  const faCache = new Map();
  const faMiss = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    if (faCache.has(block)) {
      faCache.delete(block);
      faCache.set(block, true);
    } else {
      faMiss[i] = 1;
      faCache.set(block, true);
      if (faCache.size > totalLines) faCache.delete(faCache.keys().next().value);
    }
  }

  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    const setIndex = sets > 0 ? block % sets : 0;
    const lines = cache[setIndex];
    const hitAt = lines.findIndex((line) => line.block === block);
    const hit = hitAt >= 0;
    const firstTouch = !seen.has(block);
    let victim = null;
    let victimReason = '';
    let missType = '';

    if (!hit) {
      if (firstTouch) missType = 'compulsory';
      else if (faMiss[i]) missType = 'capacity';
      else missType = 'conflict';

      if (lines.length >= ways) {
        let victimAt = 0;
        if (policy === 'LRU') {
          victimAt = lines.reduce((best, line, index) => (line.last < lines[best].last ? index : best), 0);
          victimReason = 'least-recently used';
        } else if (policy === 'FIFO') {
          victimAt = lines.reduce((best, line, index) => (line.inserted < lines[best].inserted ? index : best), 0);
          victimReason = 'first-in (oldest insertion)';
        } else if (policy === 'LFU') {
          victimAt = lines.reduce(
            (best, line, index) =>
              line.frequency < lines[best].frequency ||
              (line.frequency === lines[best].frequency && line.last < lines[best].last)
                ? index
                : best,
            0
          );
          victimReason = 'least-frequently used';
        } else if (policy === "Belady's OPT") {
          victimAt = lines.reduce(
            (best, line, index) =>
              futureLookup(line.block, i) > futureLookup(lines[best].block, i) ? index : best,
            0
          );
          const next = futureLookup(lines[victimAt].block, i);
          victimReason = next === Infinity ? 'never reused (OPT)' : `farthest reuse at +${next - i}`;
        } else if (policy === 'Random') {
          victimAt = Math.floor(random() * lines.length);
          victimReason = 'uniform random choice';
        } else if (policy === 'AI Predictor') {
          const outgoing = previousBlock === null ? null : transitions.get(previousBlock);
          const totalTransitions = outgoing ? [...outgoing.values()].reduce((s, v) => s + v, 0) : 0;
          const probability = (candidate) =>
            totalTransitions ? (outgoing.get(candidate) || 0) / totalTransitions : 0;
          victimAt = lines.reduce((best, line, index) => {
            const score = probability(line.block);
            const bestScore = probability(lines[best].block);
            return score < bestScore || (score === bestScore && line.last < lines[best].last)
              ? index
              : best;
          }, 0);
          victimReason = 'lowest Markov transition probability from previous block';
        }
        victim = lines[victimAt].block;
        lines.splice(victimAt, 1);
      }
      lines.push({ block, inserted: i, last: i, frequency: 0 });
    } else if (policy === 'LRU') {
      // Move to most-recently-used position
      const [line] = lines.splice(hitAt, 1);
      line.last = i;
      lines.push(line);
    }

    if (hit) {
      const line = lines.find((item) => item.block === block);
      line.frequency += 1;
      line.last = i;
    }

    if (previousBlock !== null) {
      if (!transitions.has(previousBlock)) transitions.set(previousBlock, new Map());
      const targets = transitions.get(previousBlock);
      targets.set(block, (targets.get(block) || 0) + 1);
    }
    previousBlock = block;
    seen.add(block);

    events.push({
      index: i,
      address: addresses[i],
      block,
      set: setIndex,
      hit,
      victim,
      victimReason,
      missType,
      capacityMiss: Boolean(faMiss[i])
    });
  }

  return {
    events,
    hits: events.filter((e) => e.hit).length,
    misses: events.filter((e) => !e.hit).length,
    cache // final state for optional use
  };
}

/**
 * Re-simulate up to a given index to obtain the exact set state for step-through.
 * For Belady's OPT the full original trace is supplied so future knowledge remains correct.
 */
function simulateSnapshot(policy, atIndex) {
  if (!results || atIndex < 0) return [];
  const geometry = results.geometry;
  const prefix = trace.slice(0, atIndex + 1);
  const fullBlocks = results.fullBlocks; // pre-computed once at benchmark time
  const partial = simulatePolicy(policy, prefix, geometry, {
    stopAt: atIndex,
    fullBlocksForFuture: fullBlocks
  });
  const setIndex = Math.floor(trace[atIndex] / geometry.blockBytes) % geometry.sets;
  return partial.cache[setIndex].map((line) => ({ ...line }));
}

function countMisses(events) {
  return events.reduce(
    (total, event) => {
      if (!event.hit && event.missType) total[event.missType] += 1;
      return total;
    },
    { compulsory: 0, capacity: 0, conflict: 0 }
  );
}

/* -------------------------------------------------------------------------- */
/* Benchmark orchestration                                                    */
/* -------------------------------------------------------------------------- */

function runBenchmark() {
  if (!updateGeometry() || trace.length === 0) return;
  const geometry = getGeometry();
  $('#run-benchmark').disabled = true;
  $('#run-benchmark').innerHTML = '◌ <span>Running benchmark…</span>';
  stopPlay();

  window.setTimeout(() => {
    try {
      const t0 = performance.now();
      const fullBlocks = trace.map((a) => Math.floor(a / geometry.blockBytes));
      const policyResults = {};

      // Run OPT first so we can use true optimal misses for 3C classification
      policyResults["Belady's OPT"] = simulatePolicy("Belady's OPT", trace, geometry);
      const optimalEvents = policyResults["Belady's OPT"].events;

      for (const policy of POLICIES) {
        if (policy === "Belady's OPT") continue;
        policyResults[policy] = simulatePolicy(policy, trace, geometry);
      }

      // Consistent 3C classification using true Belady OPT
      for (const policy of POLICIES) {
        policyResults[policy].events.forEach((event, index) => {
          const optMiss = !optimalEvents[index].hit;
          event.optWouldMiss = optMiss;
          if (!event.hit) {
            if (!event.missType || event.missType === 'compulsory') {
              // keep compulsory
            } else {
              event.missType = optMiss ? 'capacity' : 'conflict';
            }
          }
        });
      }

      const elapsed = performance.now() - t0;
      results = {
        policies: policyResults,
        geometry,
        accesses: trace.length,
        fullBlocks,
        simTimeMs: elapsed
      };
      selectedStep = 0;
      selectedAccess = -1;
      $('#empty-state').classList.add('hidden');
      $('#results').classList.remove('hidden');
      $('#export-button').disabled = false;
      $('#ask-ai').disabled = false;
      renderResults();
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast(`Benchmark complete — ${trace.length.toLocaleString()} accesses in ${elapsed.toFixed(0)} ms.`);
    } catch (error) {
      console.error('Benchmark failed.', error);
      showToast(`Benchmark failed: ${error.message}`, true);
    } finally {
      $('#run-benchmark').disabled = false;
      $('#run-benchmark').innerHTML = '▶ <span>Run benchmark</span>';
    }
  }, 20);
}

/* -------------------------------------------------------------------------- */
/* Results rendering                                                          */
/* -------------------------------------------------------------------------- */

function renderResults() {
  if (!results) return;
  renderTimeline();
  $('#result-content').innerHTML = '';
  if (activeResultTab === 'comparison') renderComparison();
  else if (activeResultTab === 'step') renderStepThrough();
  else renderInsights();
  $$('.results-tabs .tab').forEach((tab) => {
    const active = tab.dataset.resultTab === activeResultTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function renderTimeline() {
  const eventList = results.policies[selectedPolicy].events;
  const visible = Math.max(1, Math.ceil(eventList.length / zoom));
  const width = 1200;
  const height = 104;
  let rects = '';
  const plotCount = Math.min(visible, eventList.length);
  const bins = Math.min(plotCount, width);
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor((bin * plotCount) / bins);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * plotCount) / bins));
    const group = eventList.slice(start, end);
    const hits = group.filter((item) => item.hit).length;
    const evictions = group.filter((item) => item.victim !== null).length;
    const optMisses = group.filter((item) => item.optWouldMiss).length;
    const x = (bin * width) / bins;
    const barWidth = Math.max(0.65, width / bins - 0.45);
    const color = hits > group.length / 2 ? COLORS.LRU : evictions ? '#ffbf5f' : COLORS[selectedPolicy];
    const y = hits > group.length / 2 ? 37 : 20;
    const barHeight = hits > group.length / 2 ? 49 : 66;
    rects += `<rect x="${x.toFixed(2)}" y="${y}" width="${barWidth.toFixed(2)}" height="${barHeight}" rx=".7" fill="${color}" opacity="${hits > group.length / 2 ? '.74' : '.85'}"/>`;
    if (optMisses)
      rects += `<rect x="${x.toFixed(2)}" y="12" width="${barWidth.toFixed(2)}" height="4" fill="${COLORS["Belady's OPT"]}" opacity=".75"/>`;
  }
  const playIndex = selectedAccess >= 0 ? selectedAccess : selectedStep;
  const playX = (playIndex / visible) * width;
  const playhead =
    playIndex < visible
      ? `<line x1="${playX}" y1="5" x2="${playX}" y2="98" stroke="#09d7e8" stroke-width="2"/><circle cx="${playX}" cy="5" r="3" fill="#09d7e8"/>`
      : '';
  $('#timeline').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Timeline of ${visible} cache accesses">${[20, 45, 70, 95]
    .map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(120,150,180,.12)" stroke-width="1"/>`)
    .join('')}${rects}${playhead}</svg>`;
  $('#timeline-policy').textContent = selectedPolicy;
  $('#timeline-caption').textContent = `${visible.toLocaleString()} of ${eventList.length.toLocaleString()} accesses · click to inspect`;
  $('#timeline').onclick = (event) => {
    const bounds = $('#timeline').getBoundingClientRect();
    const index = Math.min(
      visible - 1,
      Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * visible))
    );
    selectedAccess = index;
    selectedStep = index;
    const row = eventList[index];
    const description = row.hit
      ? `Access ${index + 1} · address 0x${row.address.toString(16).toUpperCase()} · HIT in set ${row.set}.`
      : `Access ${index + 1} · address 0x${row.address.toString(16).toUpperCase()} · MISS (${row.missType})${
          row.victim === null ? '' : ` · evicted block ${formatBlock(row.victim)} (${row.victimReason || ''})`
        }.`;
    $('#timeline-inspector').textContent = description;
    $('#timeline-inspector').classList.remove('hidden');
    renderTimeline();
    if (activeResultTab === 'step') renderStepThrough();
  };
  $$('.zoom-control button').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.zoom) === zoom);
    button.onclick = () => {
      zoom = Number(button.dataset.zoom);
      renderTimeline();
    };
  });
}

function renderComparison() {
  const ranked = [...POLICIES].sort(
    (a, b) => results.policies[b].hits - results.policies[a].hits
  );
  const bestPractical = ranked.find((p) => p !== "Belady's OPT") || ranked[0];
  const bestRate = (results.policies[bestPractical].hits / results.accesses) * 100;
  const optRate = (results.policies["Belady's OPT"].hits / results.accesses) * 100;
  const hasEvictions = POLICIES.some((policy) =>
    results.policies[policy].events.some((event) => event.victim !== null)
  );
  const workloadNotice = hasEvictions
    ? ''
    : `<div class="workload-notice"><strong>No replacement decisions were needed.</strong> The working set fits in the cache, so all policies produced the same result. Choose Conflict thrash or Random to exercise evictions and reveal policy differences.</div>`;

  const cards = POLICIES.map((policy) => {
    const result = results.policies[policy];
    const rate = (result.hits / results.accesses) * 100;
    const evictions = result.events.filter((event) => event.victim !== null).length;
    const missTypes = countMisses(result.events);
    const convergence = optRate ? Math.min(100, Math.round((rate / optRate) * 100)) : 100;
    const rank = ranked.indexOf(policy) + 1;
    const tag =
      policy === "Belady's OPT" ? 'UPPER BOUND' : policy === 'AI Predictor' ? 'MARKOV' : rank === 1 ? 'BEST' : '';
    return `<button class="policy-card ${policy === selectedPolicy ? 'selected' : ''}" data-policy="${escapeHTML(policy)}">
      <div class="policy-top"><span class="policy-name">${escapeHTML(policy)}</span><span class="policy-badge">${tag}</span></div>
      <div class="policy-hit">${rate.toFixed(1)}<small>% hit</small></div>
      <div class="policy-stats">${result.hits.toLocaleString()} hits / ${result.misses.toLocaleString()} misses · ${evictions.toLocaleString()} evictions</div>
      <div class="convergence"><span>OPT CONVERGENCE</span><strong>${convergence}%</strong></div>
      <div class="miss-types"><span>C1 ${missTypes.compulsory}</span><span>C2 ${missTypes.capacity}</span><span>C3 ${missTypes.conflict}</span></div>
    </button>`;
  }).join('');

  const baseline = results.policies[bestPractical];
  const baselineEvictions = baseline.events.filter((e) => e.victim !== null).length;
  const rankingRows = ranked
    .map((policy, idx) => {
      const r = results.policies[policy];
      const rate = (r.hits / results.accesses) * 100;
      const missRate = 100 - rate;
      const evictions = r.events.filter((e) => e.victim !== null).length;
      const mt = countMisses(r.events);
      const deltaHits = r.hits - baseline.hits;
      const deltaMisses = r.misses - baseline.misses;
      const deltaHitRate = rate - bestRate;
      const deltaMissRate = missRate - (100 - bestRate);
      const deltaEvictions = evictions - baselineEvictions;
      const signed = (value, digits = 0, suffix = '') => {
        const formatted = Number(value).toFixed(digits);
        return value === 0 ? `0${suffix}` : `${Number(value) > 0 ? '+' : ''}${formatted}${suffix}`;
      };
      return `<tr class="${policy === selectedPolicy ? 'selected-row' : ''}">
        <td>${idx + 1}</td>
        <td>${escapeHTML(policy)}</td>
        <td>${results.accesses.toLocaleString()}</td>
        <td>${r.hits.toLocaleString()}</td>
        <td>${r.misses.toLocaleString()}</td>
        <td>${rate.toFixed(2)}%</td>
        <td>${missRate.toFixed(2)}%</td>
        <td>${evictions.toLocaleString()}</td>
        <td>${mt.compulsory}</td>
        <td>${mt.capacity}</td>
        <td>${mt.conflict}</td>
        <td class="${deltaHits === 0 ? 'difference-neutral' : deltaHits > 0 ? 'difference-better' : 'difference-worse'}">${signed(deltaHits)}</td>
        <td class="${deltaMisses === 0 ? 'difference-neutral' : deltaMisses < 0 ? 'difference-better' : 'difference-worse'}">${signed(deltaMisses)}</td>
        <td class="${Math.abs(deltaHitRate) < 0.005 ? 'difference-neutral' : deltaHitRate > 0 ? 'difference-better' : 'difference-worse'}">${Math.abs(deltaHitRate) < 0.005 ? '0.00%' : signed(deltaHitRate, 2, '%')}</td>
        <td class="${Math.abs(deltaMissRate) < 0.005 ? 'difference-neutral' : deltaMissRate < 0 ? 'difference-better' : 'difference-worse'}">${Math.abs(deltaMissRate) < 0.005 ? '0.00%' : signed(deltaMissRate, 2, '%')}</td>
        <td class="${deltaEvictions === 0 ? 'difference-neutral' : deltaEvictions < 0 ? 'difference-better' : 'difference-worse'}">${signed(deltaEvictions)}</td>
      </tr>`;
    })
    .join('');

  $('#result-content').innerHTML = `
    ${workloadNotice}
    <div class="policy-grid">${cards}</div>
    <section class="chart-card ranking-card">
      <h3 class="chart-title">Full comparison table</h3>
      <p class="chart-subtitle">Identical trace, geometry and initial empty cache for every policy. Differences are compared with the best practical policy (${escapeHTML(bestPractical)}). Positive hit differences and negative miss/eviction differences are better.</p>
      <div class="table-wrap">
        <table class="rank-table">
          <thead>
            <tr>
              <th>#</th><th>Algorithm</th><th>Accesses</th><th>Hits</th><th>Misses</th>
              <th>Hit %</th><th>Miss %</th><th>Evictions</th>
              <th>Comp.</th><th>Cap.</th><th>Conf.</th>
              <th>Δ Hits</th><th>Δ Misses</th><th>Δ Hit %</th><th>Δ Miss %</th><th>Δ Evictions</th>
            </tr>
          </thead>
          <tbody>${rankingRows}</tbody>
        </table>
      </div>
      <p class="chart-subtitle" style="margin-top:12px">Best practical policy for this workload: <strong>${escapeHTML(bestPractical)}</strong> (${bestRate.toFixed(1)}%). Belady OPT theoretical ceiling: ${optRate.toFixed(1)}%. Simulation wall time: ${results.simTimeMs.toFixed(1)} ms.</p>
    </section>
    <div class="chart-grid">
      <section class="chart-card"><h3 class="chart-title">Hit rate by policy</h3><p class="chart-subtitle">Higher is better. Belady's OPT is the theoretical ceiling.</p><div class="chart" id="hit-rate-chart"></div></section>
      <section class="chart-card"><h3 class="chart-title">Miss anatomy (3C)</h3><p class="chart-subtitle">Compulsory first-touch, capacity and conflict misses (classified via Belady OPT).</p><div class="chart" id="miss-chart"></div></section>
    </div>`;

  $$('[data-policy]').forEach((card) =>
    card.addEventListener('click', () => {
      selectedPolicy = card.dataset.policy;
      renderResults();
    })
  );
  drawHitRateChart();
  drawMissChart();
}

function drawHitRateChart() {
  const width = 540;
  const rowHeight = 31;
  const top = 12;
  const left = 112;
  const chartHeight = top + POLICIES.length * rowHeight + 15;
  let content = '';
  for (let tick = 0; tick <= 100; tick += 25) {
    const x = left + ((width - left - 12) * tick) / 100;
    content += `<line class="grid-line" x1="${x}" y1="${top - 3}" x2="${x}" y2="${chartHeight - 9}"/><text class="chart-tick" x="${x}" y="${chartHeight + 4}" text-anchor="middle">${tick}</text>`;
  }
  POLICIES.forEach((policy, index) => {
    const rate = (results.policies[policy].hits / results.accesses) * 100;
    const y = top + index * rowHeight;
    const barWidth = ((width - left - 12) * rate) / 100;
    content += `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${escapeHTML(policy)}</text><rect x="${left}" y="${y}" width="${barWidth}" height="17" rx="4" fill="${COLORS[policy]}" opacity=".86"/><text class="chart-label" x="${left + barWidth + 6}" y="${y + 13}">${rate.toFixed(1)}%</text>`;
  });
  $('#hit-rate-chart').innerHTML = `<svg viewBox="0 0 ${width} ${chartHeight + 10}" role="img" aria-label="Hit rate comparison chart">${content}</svg>`;
}

function drawMissChart() {
  const width = 540;
  const rowHeight = 31;
  const top = 12;
  const left = 112;
  const chartHeight = top + POLICIES.length * rowHeight + 15;
  const misses = POLICIES.map((policy) => countMisses(results.policies[policy].events));
  const maximum = Math.max(1, ...misses.map((item) => item.compulsory + item.capacity + item.conflict));
  let content = '';
  for (let tick = 0; tick <= 4; tick++) {
    const value = (maximum * tick) / 4;
    const x = left + ((width - left - 12) * tick) / 4;
    content += `<line class="grid-line" x1="${x}" y1="${top - 3}" x2="${x}" y2="${chartHeight - 9}"/><text class="chart-tick" x="${x}" y="${chartHeight + 4}" text-anchor="middle">${Math.round(value)}</text>`;
  }
  POLICIES.forEach((policy, index) => {
    const item = misses[index];
    const y = top + index * rowHeight;
    const factor = (width - left - 12) / maximum;
    const compulsory = item.compulsory * factor;
    const capacity = item.capacity * factor;
    const conflict = item.conflict * factor;
    content += `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${escapeHTML(policy)}</text><rect x="${left}" y="${y}" width="${compulsory}" height="17" rx="3" fill="#09d7e8"/><rect x="${left + compulsory}" y="${y}" width="${capacity}" height="17" fill="#ffbf5f"/><rect x="${left + compulsory + capacity}" y="${y}" width="${conflict}" height="17" rx="3" fill="#ab8cff"/>`;
  });
  $('#miss-chart').innerHTML = `<svg viewBox="0 0 ${width} ${chartHeight + 10}" role="img" aria-label="Compulsory, capacity, conflict miss chart">${content}</svg><div class="miss-types"><span style="color:#09d7e8">■ Compulsory</span><span style="color:#ffbf5f">■ Capacity</span><span style="color:#ab8cff">■ Conflict</span></div>`;
}

function renderStepThrough() {
  const result = results.policies[selectedPolicy];
  selectedStep = Math.min(Math.max(0, selectedStep), result.events.length - 1);
  const event = result.events[selectedStep];
  const setLines = simulateSnapshot(selectedPolicy, selectedStep);
  const geometry = results.geometry;
  const outcome = event.hit
    ? '<span style="color:var(--green)">HIT</span>'
    : '<span style="color:var(--red)">MISS</span>';
  const cause = event.hit
    ? 'The requested block was already resident in this set.'
    : `${event.missType[0].toUpperCase()}${event.missType.slice(1)} miss — the block was not present in this set.`;
  const victimText =
    event.victim === null
      ? 'No eviction'
      : `Block ${formatBlock(event.victim)} (${event.victimReason || 'policy rule'})`;

  const runningHits = result.events.slice(0, selectedStep + 1).filter((e) => e.hit).length;
  const runningRate = (((runningHits / (selectedStep + 1)) * 100) || 0).toFixed(1);
  const progressPct = ((selectedStep + 1) / result.events.length * 100).toFixed(1);

  let occupancyHTML = '';
  if (geometry.sets <= 32) {
    const fullSnap = simulatePolicy(selectedPolicy, trace.slice(0, selectedStep + 1), geometry, {
      stopAt: selectedStep,
      fullBlocksForFuture: results.fullBlocks
    });
    const cells = [];
    for (let s = 0; s < geometry.sets; s++) {
      const lines = fullSnap.cache[s] || [];
      const fill = lines.length;
      const isActive = s === event.set;
      const hasRef = lines.some((l) => l.block === event.block);
      let cls = 'occ-cell';
      if (isActive) cls += ' occ-active';
      if (hasRef) cls += ' occ-hit';
      if (fill === 0) cls += ' occ-empty';
      else if (fill >= geometry.ways) cls += ' occ-full';
      cells.push(`<div class="${cls}" title="Set ${s}: ${fill}/${geometry.ways} lines">${s}<small>${fill}</small></div>`);
    }
    occupancyHTML = `<div class="occ-grid" style="--cols:${Math.min(8, geometry.sets)}">${cells.join('')}</div>
      <p class="occ-legend"><span class="occ-swatch occ-active"></span>Active set
      <span class="occ-swatch occ-hit"></span>Contains referenced block
      <span class="occ-swatch occ-full"></span>Full
      <span class="occ-swatch occ-empty"></span>Empty</p>`;
  } else {
    occupancyHTML = `<p class="trace-help">Cache has ${geometry.sets.toLocaleString()} sets — showing only the active set below for clarity.</p>`;
  }

  const offsetBits = Math.floor(Math.log2(geometry.blockBytes));
  const indexBits = Math.floor(Math.log2(Math.max(1, geometry.sets)));
  const tagBits = Math.max(0, 32 - offsetBits - indexBits);
  const addr = event.address >>> 0;
  const offset = addr & ((1 << offsetBits) - 1);
  const index = (addr >>> offsetBits) & ((1 << indexBits) - 1);
  const tag = addr >>> (offsetBits + indexBits);

  $('#result-content').innerHTML = `
    <section class="step-card">
      <div class="step-head">
        <div>
          <p class="eyebrow">ACCESS ${String(selectedStep + 1).padStart(4, '0')}</p>
          <h3>${outcome} <span class="subtle">· ${escapeHTML(selectedPolicy)}</span></h3>
          <div class="step-position">of ${result.events.length.toLocaleString()} references · running hit rate <strong>${runningRate}%</strong> · progress ${progressPct}%</div>
        </div>
        <div class="step-controls">
          <button id="step-first" aria-label="First access" title="First">|‹</button>
          <button id="step-prev" aria-label="Previous access" title="Previous">‹</button>
          <button id="step-play" aria-label="Play / Pause" title="Play / Pause">${playTimer ? '❚❚' : '▶'}</button>
          <button id="step-next" aria-label="Next access" title="Next">›</button>
          <button id="step-last" aria-label="Last access" title="Last">›|</button>
        </div>
      </div>
      <div class="progress-bar" aria-hidden="true"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      <div class="trace-row" style="gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px">
        <label class="field-label" for="step-policy">POLICY</label>
        <select class="trace-select" id="step-policy" style="max-width:220px">${POLICIES.map(
          (name) => `<option ${name === selectedPolicy ? 'selected' : ''}>${escapeHTML(name)}</option>`
        ).join('')}</select>
        <label class="field-label" for="play-speed">SPEED</label>
        <select class="trace-select" id="play-speed" style="max-width:110px">
          <option value="800" ${playSpeed === 800 ? 'selected' : ''}>Slow</option>
          <option value="400" ${playSpeed === 400 ? 'selected' : ''}>Normal</option>
          <option value="150" ${playSpeed === 150 ? 'selected' : ''}>Fast</option>
          <option value="40" ${playSpeed === 40 ? 'selected' : ''}>Very fast</option>
        </select>
      </div>
      <div class="step-address"><small>MEMORY ADDRESS</small><strong>0x${event.address
        .toString(16)
        .toUpperCase()
        .padStart(8, '0')}</strong>
        <div class="bit-breakdown">
          <span class="bit-tag">TAG ${tagBits}b → 0x${tag.toString(16).toUpperCase()}</span>
          <span class="bit-index">INDEX ${indexBits}b → ${index}</span>
          <span class="bit-offset">OFFSET ${offsetBits}b → ${offset}</span>
        </div>
      </div>
      <div class="step-detail-grid">
        <div class="detail-box"><span>BLOCK</span><strong>${formatBlock(event.block)}</strong></div>
        <div class="detail-box"><span>SET INDEX</span><strong>${event.set}</strong></div>
        <div class="detail-box"><span>RESULT</span><strong>${event.hit ? 'Cache hit' : 'Cache miss'}</strong></div>
        <div class="detail-box"><span>EVICTION</span><strong>${victimText}</strong></div>
      </div>
      <p class="step-narrative">${cause} ${
    event.optWouldMiss
      ? "Belady's OPT also misses at this access."
      : "Belady's OPT has this block available at this access."
  }${event.victim !== null ? ` Victim chosen because: <em>${escapeHTML(event.victimReason || 'policy rule')}</em>.` : ''}</p>

      <div class="cache-overview">
        <h4>CACHE OCCUPANCY (all sets)</h4>
        ${occupancyHTML}
      </div>

      <div class="cache-state">
        <h4>SET ${event.set} · RESIDENT BLOCKS (${setLines.length}/${geometry.ways})</h4>
        ${
          setLines.length
            ? `<table class="cache-table"><thead><tr><th>WAY</th><th>BLOCK</th><th>LAST</th><th>FREQ</th><th>STATUS</th></tr></thead><tbody>${setLines
                .map((line, index) => {
                  let status = 'Resident';
                  let cls = '';
                  if (line.block === event.block) {
                    status = event.hit ? 'Referenced (HIT)' : 'Just inserted';
                    cls = 'hit-row';
                  }
                  return `<tr class="${cls}"><td>${index}</td><td class="cache-line">${formatBlock(
                    line.block
                  )}</td><td>${line.last}</td><td>${line.frequency}</td><td>${status}</td></tr>`;
                })
                .join('')}</tbody></table>`
            : '<p class="trace-help">No blocks are resident in this set yet.</p>'
        }
        ${
          event.victim !== null
            ? `<p class="evict-note">Evicted: <strong>${formatBlock(event.victim)}</strong> — ${escapeHTML(
                event.victimReason || 'policy decision'
              )}</p>`
            : ''
        }
      </div>
    </section>`;

  $('#step-policy').addEventListener('change', (change) => {
    selectedPolicy = change.target.value;
    stopPlay();
    renderResults();
  });
  $('#play-speed').addEventListener('change', (e) => {
    playSpeed = Number(e.target.value);
    if (playTimer) {
      stopPlay();
      startPlay();
    }
  });
  $('#step-first').onclick = () => { stopPlay(); moveStep(0); };
  $('#step-prev').onclick = () => { stopPlay(); moveStep(Math.max(0, selectedStep - 1)); };
  $('#step-next').onclick = () => { stopPlay(); moveStep(Math.min(result.events.length - 1, selectedStep + 1)); };
  $('#step-last').onclick = () => { stopPlay(); moveStep(result.events.length - 1); };
  $('#step-play').onclick = () => {
    if (playTimer) stopPlay();
    else startPlay();
    renderStepThrough();
  };
}

function buildInsightsHTML() {
  const ai = results.policies['AI Predictor'];
  const opt = results.policies["Belady's OPT"];
  const lru = results.policies.LRU;
  const fifo = results.policies.FIFO;
  const lfu = results.policies.LFU;
  const random = results.policies.Random;
  const rate = (item) => (item.hits / results.accesses) * 100;
  const gap = Math.max(0, rate(opt) - rate(ai));
  const practical = POLICIES.filter((n) => n !== "Belady's OPT");
  const sortedPractical = [...practical].sort(
    (a, b) => results.policies[b].hits - results.policies[a].hits
  );
  const bestPractical = sortedPractical[0];
  const worstPractical = sortedPractical[sortedPractical.length - 1];
  const best = results.policies[bestPractical];
  const worst = results.policies[worstPractical];
  const aiMisses = countMisses(ai.events);
  const compulsoryPct = ai.misses ? (aiMisses.compulsory / ai.misses) * 100 : 0;
  const geometry = results.geometry;
  const uniqueBlocks = new Set(trace.map((a) => Math.floor(a / geometry.blockBytes))).size;
  const improvement =
    rate(worst) > 0 ? (((rate(best) - rate(worst)) / rate(worst)) * 100).toFixed(1) : '∞';
  const optGapBest = (rate(opt) - rate(best)).toFixed(1);

  const strengths = [
    ['LRU', rate(lru), 'Excels on temporal locality (tight loops, reuse). Weak on scans that pollute the cache.'],
    ['FIFO', rate(fifo), 'Simple and fair. Ignores recency and frequency; can evict hot blocks.'],
    ['LFU', rate(lfu), 'Protects frequently used blocks. Slow to adapt when working set changes.'],
    ['Random', rate(random), 'Surprisingly robust under conflict thrashing; no pathological patterns.'],
    ['AI Predictor', rate(ai), 'Online 1st-order Markov on block transitions. Good when access patterns are predictable; cold-start limited.'],
    ["Belady's OPT", rate(opt), 'Theoretical upper bound using future knowledge. Not implementable online.']
  ];

  const strengthRows = strengths
    .map(
      ([name, r, desc]) =>
        `<tr><td><strong>${escapeHTML(name)}</strong></td><td>${r.toFixed(1)}%</td><td>${escapeHTML(desc)}</td></tr>`
    )
    .join('');

  const cards = [
    [
      '↗',
      'Predictor vs. optimal',
      `The online first-order Markov predictor achieved <span class="insight-highlight">${rate(ai).toFixed(
        1
      )}%</span> hit rate, ${gap.toFixed(1)} points below Belady's offline upper bound (${rate(opt).toFixed(
        1
      )}%). It only observes past block-to-block transitions; it has no future knowledge and is not a trained neural model.`
    ],
    [
      '◈',
      'Best & worst practical',
      `<span class="insight-highlight">${escapeHTML(bestPractical)}</span> leads implementable policies at ${rate(
        best
      ).toFixed(1)}% (${best.hits.toLocaleString()} hits). <span class="insight-highlight">${escapeHTML(
        worstPractical
      )}</span> is lowest at ${rate(worst).toFixed(1)}%. Relative improvement of best over worst: ${improvement}%. Gap from OPT: ${optGapBest} points.`
    ],
    [
      '⌗',
      'Why misses happen',
      `${compulsoryPct.toFixed(1)}% of AI-predictor misses are compulsory first touches. ${
        aiMisses.capacity
      } capacity and ${aiMisses.conflict} conflict misses remain under the current mapping (classified against true Belady OPT).`
    ],
    [
      '▤',
      'Geometry & working set',
      `Cache: ${geometry.totalLines.toLocaleString()} lines · ${geometry.sets.toLocaleString()} sets · ${
        geometry.ways
      }-way · ${geometry.blockBytes} B blocks. Trace references ${uniqueBlocks.toLocaleString()} unique blocks.`
    ],
    [
      '⌁',
      'Locality signal',
      `LRU recorded ${lru.hits.toLocaleString()} hits. Tight loops favour temporal policies (LRU/LFU); sequential scans and conflict thrashing expose capacity and mapping limits.`
    ],
    [
      '◎',
      'Experiment tip',
      `Change associativity or block size and re-run the identical trace. Compare the 3C breakdown to separate pure capacity pressure from set-mapping conflicts.`
    ]
  ];
  return `<div class="insight-grid">${cards
    .map(
      ([icon, title, copy]) =>
        `<article class="insight-card"><span class="insight-icon">${icon}</span><h3>${title}</h3><p>${copy}</p></article>`
    )
    .join('')}</div>
    <section class="chart-card" style="margin-top:14px">
      <h3 class="chart-title">Policy strengths on this workload</h3>
      <p class="chart-subtitle">Hit rates and characteristic behaviour under the current trace + geometry.</p>
      <div class="table-wrap">
        <table class="rank-table strength-table">
          <thead><tr><th>Policy</th><th>Hit %</th><th>Characteristic</th></tr></thead>
          <tbody>${strengthRows}</tbody>
        </table>
      </div>
    </section>
    <p class="ai-disclaimer">AI Predictor limitations: pure online 1st-order Markov on block transitions, deterministic LCG seed, no address-bit features, no offline training. Useful as a baseline heuristic, not a production ML replacement policy. Belady OPT is the only policy with future knowledge and therefore an upper bound, not a practical online algorithm.</p>`;
}

function renderInsights() {
  $('#result-content').innerHTML = buildInsightsHTML();
}



function startPlay() {
  stopPlay();
  const result = results.policies[selectedPolicy];
  playTimer = window.setInterval(() => {
    if (selectedStep >= result.events.length - 1) {
      stopPlay();
      renderStepThrough();
      return;
    }
    moveStep(selectedStep + 1);
  }, playSpeed);
}

function stopPlay() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function moveStep(index) {
  selectedStep = index;
  selectedAccess = index;
  renderResults();
}

function formatBlock(block) {
  return `0x${block.toString(16).toUpperCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Export & dialogs                                                           */
/* -------------------------------------------------------------------------- */

function exportCSV() {
  if (!results) return;
  const rows = [
    [
      'policy',
      'accesses',
      'hits',
      'misses',
      'hit_rate_percent',
      'miss_rate_percent',
      'evictions',
      'compulsory_misses',
      'capacity_misses',
      'conflict_misses'
    ]
  ];
  for (const policy of POLICIES) {
    const result = results.policies[policy];
    const categories = countMisses(result.events);
    const hitRate = (result.hits / results.accesses) * 100;
    rows.push([
      policy,
      results.accesses,
      result.hits,
      result.misses,
      hitRate.toFixed(2),
      (100 - hitRate).toFixed(2),
      result.events.filter((e) => e.victim !== null).length,
      categories.compulsory,
      categories.capacity,
      categories.conflict
    ]);
  }
  downloadFile(
    'cacheoracle-benchmark.csv',
    rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
    'text/csv'
  );
  showToast('Benchmark exported as CSV.');
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showAIReadout() {
  if (!results) return;
  $('#ai-dialog-content').innerHTML = buildInsightsHTML();
  $('#ai-dialog').showModal();
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

/* -------------------------------------------------------------------------- */
/* Initialisation                                                             */
/* -------------------------------------------------------------------------- */

function initialise() {
  // Seed the demo with a conflict-heavy trace so policy differences are visible.
  trace = generateTrace('thrash', PRESETS.thrash.count, PRESETS.thrash.body, 64);

  const savedTheme = localStorage.getItem('cacheoracle-theme');
  if (savedTheme === 'light') document.body.classList.add('light');

  $('#theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('light');
    localStorage.setItem(
      'cacheoracle-theme',
      document.body.classList.contains('light') ? 'light' : 'dark'
    );
  });

  $('#cache-size').addEventListener('change', (event) =>
    setGeometryValue('#cache-size', '#cache-size-number', event.target.value)
  );
  $('#cache-size-number').addEventListener('change', (event) =>
    setGeometryValue('#cache-size', '#cache-size-number', event.target.value)
  );
  $('#block-size').addEventListener('change', (event) =>
    setGeometryValue('#block-size', '#block-size-number', event.target.value)
  );
  $('#block-size-number').addEventListener('change', (event) =>
    setGeometryValue('#block-size', '#block-size-number', event.target.value)
  );
  $('#associativity').addEventListener('change', (event) => {
    $('#ways-number').disabled = event.target.value === 'fully';
    if (event.target.value !== 'fully') $('#ways-number').value = event.target.value;
    updateGeometry();
  });
  $('#ways-number').addEventListener('change', updateGeometry);

  $$('[data-trace-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      activeTraceTab = tab.dataset.traceTab;
      $$('[data-trace-tab]').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
      renderTraceTab();
    })
  );

  $$('[data-result-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      activeResultTab = tab.dataset.resultTab;
      stopPlay();
      renderResults();
    })
  );

  $('#run-benchmark').addEventListener('click', runBenchmark);
  $('#load-demo').addEventListener('click', runBenchmark);
  $('#export-button').addEventListener('click', exportCSV);
  $('#ask-ai').addEventListener('click', showAIReadout);
  $('.close-dialog').addEventListener('click', () => $('#ai-dialog').close());
  $('#ai-dialog').addEventListener('click', (event) => {
    if (event.target === $('#ai-dialog')) $('#ai-dialog').close();
  });

  // Keyboard navigation for step-through
  document.addEventListener('keydown', (e) => {
    if (!results || activeResultTab !== 'step') return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'n') {
      e.preventDefault();
      stopPlay();
      moveStep(Math.min(results.policies[selectedPolicy].events.length - 1, selectedStep + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'p') {
      e.preventDefault();
      stopPlay();
      moveStep(Math.max(0, selectedStep - 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      if (playTimer) stopPlay();
      else startPlay();
      renderStepThrough();
    }
  });

  renderTraceTab();
  updateGeometry();
  updateTraceCount();
}

initialise();
