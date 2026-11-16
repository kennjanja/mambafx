import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB } from "../support/fakeIndexedDB.js";
import { createLiveResearch, sourceId } from "../../src/super-mathes/live.js";
import { coordinateResearch } from "../../src/super-mathes/coordination.js";

const endpoint = "wss://public.example";
const source = sourceId(endpoint, "R_100", 2);
const tick = epoch => ({ endpoint, symbol: "R_100", epoch, rawQuote: "1.23", decimals: 2 });
const prediction = timestamp => ({ id: "p", source, timestamp, selectedDigit: 3,
  probabilities: Array(10).fill(0.1), hazards: Array(5).fill(0.1), model: "fixture", assumptions: "fixture" });
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for coordinator");
}

class TestLocks {
  constructor() { this.tail = Promise.resolve(); }
  request(_name, callback) {
    const result = this.tail.then(() => callback({ name: "test" }));
    this.tail = result.catch(() => {});
    return result;
  }
}
class TestChannel {
  static channels = new Set();
  constructor(name) { this.name = name; TestChannel.channels.add(this); }
  postMessage(data) {
    for (const other of TestChannel.channels) if (other !== this && other.name === this.name) {
      queueMicrotask(() => { if (other.onmessage) other.onmessage({ data: structuredClone(data) }); });
    }
  }
  close() { TestChannel.channels.delete(this); }
}

test("stale and disconnected intervals persist and never score across a gap", async () => {
  const fake = installFakeIndexedDB();
  let time = 100000;
  try {
    const live = createLiveResearch({ now: () => time, staleMs: 2000, report: () => {} });
    await live.ingest(tick(1));
    await live.createPrediction(prediction(1), 1);
    time += 2001;
    assert.equal(await live.checkStale(), true);
    const record = await live.getPrediction("p");
    assert.equal(record.status, "Unscorable");
    let gaps = await live.listIntervals(source);
    assert.equal(gaps[0].reason, "Feed stale; continuity unknown");
    assert.equal(gaps[0].afterSequence, 1);
    assert.equal(gaps[0].endedAt, null);
    time++;
    await live.ingest(tick(8));
    gaps = await live.listIntervals(source);
    assert.equal(gaps[0].resumedSequence, 2);
    assert.equal(gaps[0].resumedEpoch, 8);
    assert.equal(gaps[0].endedAt, time);
    assert.equal((await live.getSource(source)).segment, 2);
    assert.equal((await live.getPrediction("p")).observations.length, 0);
  } finally { fake.teardown(); }
});

test("a provider sequence gap or regression is not treated as a consecutive outcome", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    await live.ingest({ ...tick(1), providerSequence: 10 });
    await live.createPrediction(prediction(1), 1);
    await live.ingest({ ...tick(2), providerSequence: 12 });
    assert.equal((await live.getPrediction("p")).status, "Unscorable");
    assert.equal((await live.listIntervals(source))[0].reason, "Provider sequence gap");
    await assert.rejects(live.ingest({ ...tick(3), providerSequence: 11 }), /provider sequence/);
    assert.equal((await live.getSource(source)).connected, false);
  } finally { fake.teardown(); }
});

test("prediction creation itself detects a stale feed even if the timer is delayed", async () => {
  const fake = installFakeIndexedDB();
  let time = 100000;
  try {
    const live = createLiveResearch({ now: () => time, staleMs: 2000, report: () => {} });
    await live.ingest(tick(1));
    time += 2001;
    await assert.rejects(live.createPrediction(prediction(1), 1), /active feed/);
    assert.equal((await live.getSource(source)).connected, false);
    assert.equal((await live.listIntervals(source))[0].reason, "Feed stale; continuity unknown");
  } finally { fake.teardown(); }
});

test("a delayed model prediction is pinned to its accepted sequence and catches up lifecycle observations", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    for (let epoch = 1; epoch <= 22; epoch++) await live.ingest(tick(epoch));
    const record = await live.createModelPrediction(20, "combined", 0.5, 20);
    assert.equal(record.originSequence, 20);
    assert.equal(record.prediction.timestamp, 20);
    assert.deepEqual(record.observations.map(row => row.sequence), [21, 22]);
    await live.ingest(tick(23));
    assert.equal((await live.getPrediction(record.id)).observations.at(-1).sequence, 23);
  } finally { fake.teardown(); }
});

test("concurrent tabs elect one collector and safely hand over pending predictions", async () => {
  const fake = installFakeIndexedDB(), locks = new TestLocks();
  const options = { locks, Channel: TestChannel, heartbeatMs: 20, report: () => {} };
  const first = coordinateResearch(createLiveResearch({ autoRecover: false, report: () => {} }), options);
  const second = coordinateResearch(createLiveResearch({ autoRecover: false, report: () => {} }), options);
  const accepted = [];
  first.subscribeObservations(observation => accepted.push(observation));
  try {
    await waitFor(() => first.status.role === "collector" && second.status.role === "follower");
    await Promise.all([first.ingest(tick(1)), second.ingest(tick(1))]);
    assert.equal((await first.getSource(source)).lastSeq, 1);
    assert.equal(first.status.segment, 1);
    assert.equal(first.status.lastSequence, 1);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].sequence, 1);
    await first.ingest(tick(1));
    assert.equal(accepted.length, 1);
    assert.equal(first.status.lastSequence, null);
    const interrupted = first.interrupt("Feed disconnected");
    assert.equal(first.status.activeSource, null);
    assert.equal(first.status.segment, null);
    await interrupted;
    await first.ingest(tick(2));
    assert.equal(first.status.segment, 2);
    await first.createPrediction(prediction(2), 2);
    await assert.rejects(second.createPrediction(prediction(2), 2), /collector tab/);
    assert.equal((await second.getPrediction("p")).status, "Pending Immediate Outcome");
    await first.stop();
    await waitFor(() => second.status.role === "collector");
    await second.ingest(tick(3));
    assert.equal((await second.getSource(source)).lastSeq, 3);
    assert.equal((await second.getPrediction("p")).status, "Unscorable");
    const gaps = await second.listIntervals(source);
    assert.equal(gaps[0].reason, "Collector closed");
    assert.equal(gaps[0].resumedSequence, 3);
  } finally { await first.stop(); await second.stop(); fake.teardown(); }
});

test("unsupported coordination fails closed rather than collecting twice", async () => {
  const service = { status: {}, listSources: async () => [] };
  const guarded = coordinateResearch(service, { locks: null, Channel: null, report: () => {} });
  assert.equal(guarded.status.state, "failed");
  await assert.rejects(guarded.ingest(tick(1)), /required/);
});
