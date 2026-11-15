// The browser owns the lock until the collector has drained its writes.
export function coordinateResearch(service, {
  locks = globalThis.navigator?.locks,
  Channel = globalThis.BroadcastChannel,
  lockName = "super-mathes-collector-v1",
  heartbeatMs = 2000,
  now = Date.now,
  report = error => console.error("[super-mathes coordination]", error),
} = {}) {
  const status = { state: "starting", role: "waiting", activeSource: null, lastError: null };
  let owned = false, stopped = false, release, heartbeatAt = 0;
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
    status.activeSource = service.status.activeSource;
    status.lastError = service.status.lastError;
    channel.postMessage({ type: "status", state: status.state, activeSource: status.activeSource, lastError: status.lastError });
  };
  channel.onmessage = event => {
    if (event.data?.type === "hello") { broadcast(); return; }
    if (!owned && event.data?.type === "status") {
      heartbeatAt = now();
      status.state = event.data.state;
      status.role = "follower";
      status.activeSource = event.data.activeSource;
      status.lastError = event.data.lastError;
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
      try { await service.interrupt("Collector closed"); }
      finally { if (release) release(); }
    }
    channel.close();
    if (release) await lockRequest;
  }
  return {
    ...service, status,
    ingest: (...args) => owned ? Promise.resolve(service.ingest(...args)).finally(broadcast) : Promise.resolve({ ignored: true }),
    interrupt: (...args) => owned ? Promise.resolve(service.interrupt(...args)).finally(broadcast) : Promise.resolve(),
    createPrediction: leaderOnly("createPrediction"),
    createModelPrediction: leaderOnly("createModelPrediction"),
    benchmark: leaderOnly("benchmark"),
    recover: leaderOnly("recover"),
    checkStale: leaderOnly("checkStale"),
    stop,
  };
}
