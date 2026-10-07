/** 提供可替换的业务时钟。 */
export class Clock {
  now() {
    return new Date().toISOString();
  }
}

/**
 * 可由值班人员推进的模拟时钟。
 * 当前时间持久化在存储中，服务重启后用同一存储重建时钟即可恢复原计时依据。
 */
export class SimulatedClock {
  constructor(store, startAt) {
    this.store = store;
    if (this.store.getMeta("simulatedNow") === null) {
      this.store.setMeta("simulatedNow", startAt ?? new Date().toISOString());
    }
  }

  now() {
    return this.store.getMeta("simulatedNow");
  }

  advance(seconds) {
    const next = new Date(Date.parse(this.now()) + seconds * 1000).toISOString();
    this.store.setMeta("simulatedNow", next);
    return next;
  }
}
