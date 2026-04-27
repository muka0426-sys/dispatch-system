import crypto from "crypto";

function nowDate() {
  return new Date();
}

function matchesQuery(doc, query) {
  if (!query) return true;
  for (const [k, v] of Object.entries(query)) {
    if (k === "$or") {
      if (!Array.isArray(v)) return false;
      if (!v.some((q) => matchesQuery(doc, q))) return false;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$lte" in v) {
        if (!(doc[k] <= v.$lte)) return false;
        continue;
      }
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  const out = { ...doc };
  if (update?.$set) {
    for (const [k, v] of Object.entries(update.$set)) out[k] = v;
  }
  if (update?.$unset) {
    for (const k of Object.keys(update.$unset)) delete out[k];
  }
  return out;
}

function sortByCreatedAtAsc(a, b) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function createMockStorage({ seedDrivers = [] } = {}) {
  const jobs = [];
  const orders = [];
  const drivers = [];

  for (const d of seedDrivers) {
    drivers.push({
      _id: crypto.randomUUID(),
      name: d.name,
      lineUserId: d.lineUserId,
      active: d.active ?? true,
      status: d.status ?? "available",
      lastAssignedAt: d.lastAssignedAt ?? null,
      createdAt: nowDate(),
      updatedAt: nowDate()
    });
  }

  // Single-threaded Node still benefits from explicit mutual exclusion when
  // multiple awaits interleave. This ensures findOneAndUpdate is atomic in mock mode.
  let lock = Promise.resolve();
  function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  const Job = {
    async create(doc) {
      const createdAt = nowDate();
      const _id = crypto.randomUUID();
      const item = { _id, ...doc, createdAt, updatedAt: createdAt };
      jobs.push(item);
      return { ...item };
    },

    async findOneAndUpdate(query, update, options = {}) {
      return await withLock(async () => {
        const candidates = jobs.filter((j) => matchesQuery(j, query));
        candidates.sort(sortByCreatedAtAsc);
        const picked = candidates[0];
        if (!picked) return null;

        const idx = jobs.findIndex((j) => j._id === picked._id);
        const updated = applyUpdate(picked, update);
        updated.updatedAt = nowDate();
        jobs[idx] = updated;
        return options.new ? { ...updated } : { ...picked };
      });
    },

    async findByIdAndUpdate(id, update) {
      return await withLock(async () => {
        const idx = jobs.findIndex((j) => j._id === id);
        if (idx === -1) return null;
        const prev = jobs[idx];
        const updated = applyUpdate(prev, update);
        updated.updatedAt = nowDate();
        jobs[idx] = updated;
        return { ...updated };
      });
    }
  };

  const Order = {
    async create(doc) {
      const createdAt = nowDate();
      const _id = crypto.randomUUID();
      const item = { _id, ...doc, createdAt, updatedAt: createdAt };
      orders.push(item);
      return { ...item };
    },

    async findByIdAndUpdate(id, update) {
      return await withLock(async () => {
        const idx = orders.findIndex((o) => o._id === id);
        if (idx === -1) return null;
        const prev = orders[idx];
        const updated = applyUpdate(prev, update);
        updated.updatedAt = nowDate();
        orders[idx] = updated;
        return { ...updated };
      });
    }
  };

  const Driver = {
    async findOne(query) {
      const found = drivers.filter((d) => matchesQuery(d, query));
      found.sort((a, b) => {
        const aa = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
        const bb = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
        if (aa !== bb) return aa - bb;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      return found[0] ? { ...found[0] } : null;
    },

    async findOneAndUpdate(query, update, options = {}) {
      return await withLock(async () => {
        const found = drivers.filter((d) => matchesQuery(d, query));
        found.sort((a, b) => {
          const aa = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
          const bb = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
          if (aa !== bb) return aa - bb;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        const picked = found[0];
        if (!picked) return null;
        const idx = drivers.findIndex((d) => d._id === picked._id);
        const updated = applyUpdate(picked, update);
        updated.updatedAt = nowDate();
        drivers[idx] = updated;
        return options.new ? { ...updated } : { ...picked };
      });
    }
  };

  return {
    isMock: true,
    Job,
    Order,
    Driver,
    _debug: {
      jobs,
      orders,
      drivers
    }
  };
}

