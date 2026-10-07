/** 保存基础登记记录与领域集合，支持快照以便重启后恢复。 */
export class Store {
  constructor() {
    this.records = new Map();
    this.collections = new Map();
    this.meta = new Map();
  }

  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.records.set(record.recordId, structuredClone(record));
  }

  get(recordId) {
    const value = this.records.get(recordId);
    return value ? structuredClone(value) : null;
  }

  _bucket(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  put(collection, id, value) {
    this._bucket(collection).set(id, structuredClone(value));
  }

  getFrom(collection, id) {
    const value = this._bucket(collection).get(id);
    return value ? structuredClone(value) : null;
  }

  all(collection) {
    return [...this._bucket(collection).values()].map((value) => structuredClone(value));
  }

  filter(collection, predicate) {
    return this.all(collection).filter(predicate);
  }

  setMeta(key, value) {
    this.meta.set(key, structuredClone(value));
  }

  getMeta(key) {
    const value = this.meta.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  /** 序列化全部状态（含模拟时钟），用于服务重启后恢复计时依据。 */
  snapshot() {
    return JSON.stringify({
      records: [...this.records.entries()],
      collections: [...this.collections.entries()].map(([name, bucket]) => [name, [...bucket.entries()]]),
      meta: [...this.meta.entries()],
    });
  }

  static restore(json) {
    const data = JSON.parse(json);
    const store = new Store();
    store.records = new Map(data.records);
    store.collections = new Map(data.collections.map(([name, entries]) => [name, new Map(entries)]));
    store.meta = new Map(data.meta);
    return store;
  }
}
