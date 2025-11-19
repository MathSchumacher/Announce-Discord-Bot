/**
 * tests/test_simulation.js
 * Advanced simulation (VERBOSE logs)
 * - 20k members
 * - 3 workers
 * - simulates 429, transient errors, DM closed (50007)
 * - persistence (tests/state_sim.json) and auto-resume
 * - verbose logs: retries, rate-limit, delay adjustments, throughput every 3s
 */

const fs = require('fs');
const path = require('path');

const WORKER_COUNT = 3;
const MEMBER_COUNT = 20000;
const CHUNK_LIMIT = 1000; // used by producer simulation
const SAVE_FILE = path.resolve(__dirname, 'state_sim.json');

const DM_CLOSED_RATIO = 0.15;
const TRANSIENT_ERROR_RATIO = 0.03;
const BASE_429_RATE_PER_SEC = 60;

const INITIAL_DELAY_MS = 350;
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;

const RETRY_LIMIT = 2;
const CHECKPOINT_EVERY = 50;
const THROUGHPUT_INTERVAL = 3000; // ms

// Deterministic pseudo-random for reproducible runs
const random = (seed => {
  let s = seed || 987654321;
  return () => {
    s = Math.imul(48271, s) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
})(1337);

function nowTs() { return new Date().toISOString(); }
function log(...args) { console.log(nowTs(), ...args); }

function ensureDirExists(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e){}
}

// -------------------- Members builder --------------------
function buildMembers(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = {
      id: (100000000000000000 + i).toString(),
      tag: `user#${String(i).padStart(5,'0')}`,
      dmClosed: random() < DM_CLOSED_RATIO
    };
  }
  return arr;
}

// -------------------- Persistence --------------------
function loadState() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return null;
    const raw = fs.readFileSync(SAVE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(nowTs(), "loadState error:", err);
    return null;
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
  } catch (err) {
    console.warn(nowTs(), "saveState error:", err);
  }
}

// -------------------- SimulatedAPI (advanced) --------------------
class SimulatedAPI {
  constructor(members) {
    this.members = members;
    this.sentTimestamps = []; // epoch ms
  }

  async listMembers({ limit = CHUNK_LIMIT, after = null } = {}) {
    // small latency
    await this._sleep(5 + Math.round(random() * 10));
    let start = 0;
    if (after) {
      const idx = this.members.findIndex(m => m.id === after);
      start = (idx >= 0 ? idx + 1 : 0);
    }
    const slice = this.members.slice(start, start + limit);
    return {
      values: slice,
      size: slice.length,
      last: slice.length ? slice[slice.length - 1] : null
    };
  }

  async fetchMember(id) {
    await this._sleep(4 + Math.round(random() * 8));
    const m = this.members.find(x => x.id === id);
    if (!m) throw new Error('MemberNotFound');
    return m;
  }

  async sendDM(member, payload) {
    // prune old timestamps older than 2s
    const now = Date.now();
    this.sentTimestamps = this.sentTimestamps.filter(t => now - t < 2000);
    const sendsPerSec = (this.sentTimestamps.length / 2); // rough approx

    // enforce 429 probabilistically when over threshold
    if (sendsPerSec > BASE_429_RATE_PER_SEC && random() < 0.6) {
      const retryAfter = 1000 + Math.round(random() * 3000);
      const e = new Error('RateLimited');
      e.code = 429;
      e.retry_after = retryAfter / 1000;
      throw e;
    }

    // transient errors
    if (random() < TRANSIENT_ERROR_RATIO) {
      const e = new Error('TransientError');
      e.code = 500;
      throw e;
    }

    // DM closed
    if (member.dmClosed) {
      const e = new Error('CannotSendToUser');
      e.code = 50007;
      throw e;
    }

    // success latency
    await this._sleep(15 + Math.round(random() * 50));
    this.sentTimestamps.push(Date.now());
    return { ok: true };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// -------------------- Core runSimulation (verbose) --------------------
async function runSimulation(opts = {}) {
  ensureDirExists(path.dirname(SAVE_FILE));

  log("SIMULATION START (VERBOSE)");
  log(`Members: ${MEMBER_COUNT} | Workers: ${WORKER_COUNT}`);

  const members = buildMembers(MEMBER_COUNT);
  const api = new SimulatedAPI(members);

  // state structure
  let state = loadState();
  if (!state) {
    // fresh job: produce queue using member ids (simulate producer page-by-page)
    log("No saved state found - creating fresh job and queue (producer will page).");
    state = {
      active: true,
      queue: [],       // pending IDs
      sent: [],
      failed: [],
      closed: [],
      stats: { sent: 0, failed: 0, closed: 0 },
      producerAfter: null, // last ID produced
      producerDone: false
    };
    saveState(state);
  } else {
    log("Loaded saved state:", { queue: state.queue.length, sent: state.stats?.sent || 0, producerDone: state.producerDone });
  }

  // limiter state
  let globalDelay = INITIAL_DELAY_MS;
  let lastSendTs = 0;
  let limiterLocked = false;

  function now() { return Date.now(); }

  async function acquireSlot() {
    while (true) {
      const elapsed = now() - lastSendTs;
      if (!limiterLocked && elapsed >= globalDelay) {
        limiterLocked = true;
        return;
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }
  function releaseSlot() { lastSendTs = now(); limiterLocked = false; }

  function onSuccessAdjust() {
    const prev = globalDelay;
    globalDelay = Math.max(MIN_DELAY_MS, Math.round(globalDelay * 0.97));
    if (globalDelay !== prev) log(`Adjust globalDelay down: ${prev} -> ${globalDelay}`);
  }
  function onRateAdjust(retryAfterMs = null) {
    const prev = globalDelay;
    if (retryAfterMs) {
      globalDelay = Math.min(MAX_DELAY_MS, Math.max(globalDelay, Math.round(retryAfterMs)));
    } else {
      globalDelay = Math.min(MAX_DELAY_MS, Math.round(globalDelay * 1.5));
    }
    log(`Adjust globalDelay up: ${prev} -> ${globalDelay}`);
  }

  // throughput monitor
  let lastThroughputCheck = Date.now();
  let lastSentCount = state.stats.sent || 0;
  setInterval(() => {
    const nowT = Date.now();
    const deltaMs = nowT - lastThroughputCheck;
    const sentDelta = (state.stats.sent || 0) - lastSentCount;
    const perSec = (sentDelta / (deltaMs / 1000)).toFixed(2);
    log(`[THROUGHPUT] sentDelta=${sentDelta} perSec=${perSec} queue=${state.queue.length} globalDelay=${globalDelay}`);
    lastThroughputCheck = nowT;
    lastSentCount = state.stats.sent || 0;
  }, THROUGHPUT_INTERVAL);

  // PRODUCER: incremental, page-by-page (small pages to avoid Railway kill)
  async function producer() {
    if (state.producerDone) {
      log("Producer: already done previously, skipping production.");
      return;
    }
    log("Producer: starting incremental pagination...");
    while (true) {
      const page = await api.listMembers({ limit: CHUNK_LIMIT, after: state.producerAfter });
      log(`Producer: loaded page size=${page.size} (after=${state.producerAfter})`);
      if (!page.values || page.values.length === 0) {
        state.producerDone = true;
        saveState(state);
        log("Producer: finished pagination. total queued:", state.queue.length);
        break;
      }
      for (const m of page.values) {
        // respect filters? (none in simulation) — push all
        state.queue.push(m.id);
      }
      state.producerAfter = page.last ? page.last.id : null;
      saveState(state);
      // small sleep to avoid CPU spike
      await new Promise(r => setTimeout(r, 120));
    }
  }

  // Worker implementation (verbose)
  async function workerLoop(idx) {
    log(`Worker ${idx} START`);
    while (true) {
      // reload state (robust to restarts)
      state = loadState();
      if (!state || !state.active) { log(`Worker ${idx} found no active job -> exit`); return; }

      const uid = state.queue.shift();
      if (!uid) {
        if (state.producerDone) {
          log(`Worker ${idx} queue empty & producer done -> finishing`);
          saveState(state);
          return;
        }
        // no item now, wait
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // persist immediate to avoid duplicates if killed now
      saveState(state);

      // fetch
      let member = null;
      try {
        member = await api.fetchMember(uid);
      } catch (err) {
        log(`Worker ${idx} fetchMember ERROR uid=${uid} ->`, err.message);
        state.failed.push(uid);
        state.stats.failed++;
        saveState(state);
        continue;
      }

      // send with retries and 429 handling
      let ok = false;
      for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
        try {
          await acquireSlot();
          await api.sendDM(member, { content: "SIMULATION MESSAGE" });
          releaseSlot();
          ok = true;
          state.sent.push(uid);
          state.stats.sent++;
          log(`Worker ${idx} SENT uid=${uid} tag=${member.tag} attempt=${attempt+1} globalDelay=${globalDelay}`);
          onSuccessAdjust();
          break;
        } catch (err) {
          // free limiter
          limiterLocked = false; lastSendTs = Date.now();
          // DM closed
          if (err.code === 50007) {
            state.closed.push(uid);
            state.stats.closed++;
            log(`Worker ${idx} DM_CLOSED uid=${uid} (${member.tag})`);
            break;
          }
          // rate limit
          if (err.code === 429) {
            const retryAfterMs = err.retry_after ? Math.round(err.retry_after * 1000) : null;
            log(`Worker ${idx} RATE_LIMIT uid=${uid} attempt=${attempt+1} retryAfterMs=${retryAfterMs}`);
            onRateAdjust(retryAfterMs);
            await new Promise(r => setTimeout(r, retryAfterMs || globalDelay));
            continue;
          }
          // transient
          log(`Worker ${idx} TRANSIENT uid=${uid} attempt=${attempt+1} err=${err.message || err}`);
          await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        }
      }

      if (!ok && !state.closed.includes(uid)) {
        state.failed.push(uid);
        state.stats.failed++;
        log(`Worker ${idx} FINAL_FAIL uid=${uid}`);
      }

      // checkpointing periodically
      const totalProcessed = state.stats.sent + state.stats.failed + state.stats.closed;
      if (totalProcessed % CHECKPOINT_EVERY === 0) {
        saveState(state);
        log(`Checkpoint: processed=${totalProcessed} sent=${state.stats.sent} failed=${state.stats.failed} closed=${state.stats.closed} queue=${state.queue.length}`);
      }

      // micro-yield
      await new Promise(r => setTimeout(r, 5));
    }
  }

  // If queue empty and producer not done => start producer
  if ((!state.queue || state.queue.length === 0) && !state.producerDone) {
    log("Main: calling producer()");
    await producer();
  } else {
    log("Main: skipping producer (queue already has items or producer done)");
  }

  // start workers
  const workerPromises = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    workerPromises.push(workerLoop(i));
    await new Promise(r => setTimeout(r, 20));
  }

  await Promise.all(workerPromises);

  // final save & report
  state = loadState();
  saveState(state);
  log("SIMULATION COMPLETE:", { sent: state.stats.sent, failed: state.stats.failed, closed: state.stats.closed, remaining: state.queue.length });
  return state;
}

// Run if main
if (require.main === module) {
  (async () => {
    try {
      log("Starting advanced VERBOSE simulation");
      const result = await runSimulation();
      log("Result:", result.stats || result);
    } catch (err) {
      console.error(nowTs(), "Simulation ERROR:", err);
    }
  })();
}

module.exports = { runSimulation };