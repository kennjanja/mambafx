// The browser owns the lock until the collector has drained its writes.
export function coordinateResearch(service, {
  locks = globalThis.navigator?.locks,
  Channel = globalThis.BroadcastChannel,
  lockName = "super-mathes-collector-v1",
  heartbeatMs = 2000,
  now = Date.now,
  report = error => console.error("[super-mathes coordination]", error),
} = {}) {
  const status = { state: "starting", role: "waiting", activeSource: null, lastError: null,
    lastObservationAt: null, pendingUpdates: 0, segment: null, lastSequence: null, lastEpoch: null };
  let owned = false, stopped = false, release, heartbeatAt = 0;
  let interruptions = 0;
  const observationListeners = new Set();
  if (!locks || !Channel) {
    status.state = "failed";
    status.lastError = "Web Locks and BroadcastChannel are required for safe collection";
    report(new Error(status.lastError));
    return { ...service, status,
      ingest: async () => { throw new Error(status.lastError); },
      interrupt: async () => { throw new Error(status.lastError); },
      createPrediction: async () => { throw new Error(status.lastError); },
      createModelPrediction: async () => { throw new Error(status.lastError); },
      benchmark: async () => { throw new Error(status.lastError); },
      recover: async () => { throw new Error(status.lastError); },
      checkStale: async () => { throw new Error(status.lastError); },
      stop: async () => {},
    };
  }
  const channel = new Channel(lockName);
  const broadcast = () => {
    if (!owned) return;
    status.state = service.status.state;
    status.activeSource = interruptions ? null : service.status.activeSource;
    status.lastError = service.status.lastError;
    channel.postMessage({ type: "status", state: status.state, activeSource: status.activeSource, lastError: status.lastError,
      lastObservationAt: status.lastObservationAt, segment: status.segment,
      lastSequence: status.lastSequence, lastEpoch: status.lastEpoch });
  };
  channel.onmessage = event => {
    if (event.data?.type === "hello") { broadcast(); return; }
    if (!owned && event.data?.type === "status") {
      heartbeatAt = now();
      status.state = event.data.state;
      status.role = "follower";
      status.activeSource = event.data.activeSource;
      status.lastError = event.data.lastError;
      status.lastObservationAt = event.data.lastObservationAt ?? null;
      status.segment = event.data.segment ?? null;
      status.lastSequence = event.data.lastSequence ?? null;
      status.lastEpoch = event.data.lastEpoch ?? null;
    }
  };
  channel.postMessage({ type: "hello" });
  const timer = setInterval(() => {
    if (owned) {
      service.checkStale().then(broadcast).catch(error => {
        status.state = "failed"; status.lastError = String(error); report(error);
        stop().catch(report);
      });
    } else if (heartbeatAt && now() - heartbeatAt > heartbeatMs * 3) {
      status.state = "waiting";
      status.activeSource = null;
      status.lastError = "Collector heartbeat unavailable";
    }
  }, heartbeatMs);
  const lockRequest = locks.request(lockName, async () => {
    if (stopped) return;
    try {
      await service.recover();
      if (stopped) return;
      owned = true;
      status.role = "collector";
      broadcast();
      await new Promise(resolve => { release = resolve; });
    } catch (error) {
      status.state = "failed";
      status.lastError = String(error);
      report(error);
    } finally { owned = false; }
  }).catch(error => { status.state = "failed"; status.lastError = String(error); report(error); });
  const leaderOnly = method => (...args) => {
    if (!owned) return Promise.reject(new Error("Use the active collector tab for this action"));
    return Promise.resolve(service[method](...args)).finally(broadcast);
  };
  async function stop() {
    stopped = true;
    clearInterval(timer);
    if (owned) {
      owned = false;
      status.role = "stopped";
      status.activeSource = null;
      status.lastObservationAt = null;
      status.segment = null;
      status.lastSequence = null;
      status.lastEpoch = null;
      try { await service.interrupt("Collector closed"); }
      finally { if (release) release(); }
    }
    channel.close();
    if (release) await lockRequest;
  }
  return {
    ...service, status,
    ingest: (...args) => {
      if (!owned) return Promise.resolve({ ignored: true });
      status.pendingUpdates++;
      return Promise.resolve(service.ingest(...args)).then(result => {
        if (result.duplicate) {
          status.activeSource = null;
          status.lastObservationAt = null;
          status.segment = null;
          status.lastSequence = null;
          status.lastEpoch = null;
        } else {
          status.segment = result.observation.segment;
          status.lastSequence = result.observation.sequence;
          status.lastEpoch = result.observation.epoch;
          status.lastObservationAt = result.observation.receivedAt ?? now();
        }
        return result;
      }).finally(() => { status.pendingUpdates--; broadcast(); }).then(result => {
        if (!result.duplicate) for (const listener of observationListeners) {
          try { Promise.resolve(listener(result.observation)).catch(report); }
          catch (error) { report(error); }
        }
        return result;
      });
    },
    interrupt: (...args) => {
      if (!owned) return Promise.resolve();
      interruptions++;
      status.activeSource = null;
      status.lastObservationAt = null;
      status.segment = null;
      status.lastSequence = null;
      status.lastEpoch = null;
      return Promise.resolve(service.interrupt(...args)).finally(() => { interruptions--; broadcast(); });
    },
    subscribeObservations(listener) {
      if (typeof listener !== "function") throw new Error("Observation listener must be a function");
      observationListeners.add(listener);
      return () => observationListeners.delete(listener);
    },
    createPrediction: leaderOnly("createPrediction"),
    createModelPrediction: leaderOnly("createModelPrediction"),
    benchmark: leaderOnly("benchmark"),
    recover: leaderOnly("recover"),
    checkStale: leaderOnly("checkStale"),
    stop,
  };
}
