import axios from "axios";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

function buildClient() {
  const baseURL = requiredEnv("MONGODB_DATA_API_URL").replace(/\/+$/, "");
  const apiKey = requiredEnv("MONGODB_DATA_API_KEY");

  return axios.create({
    baseURL,
    timeout: 15_000,
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    }
  });
}

export function createDataApi() {
  const client = buildClient();

  const dataSource = requiredEnv("MONGODB_DATA_SOURCE");
  const database = requiredEnv("MONGODB_DATABASE");

  const collections = {
    jobs: process.env.MONGODB_COLLECTION_JOBS || "jobs",
    orders: process.env.MONGODB_COLLECTION_ORDERS || "orders",
    drivers: process.env.MONGODB_COLLECTION_DRIVERS || "drivers"
  };

  async function action(name, payload) {
    try {
      const res = await client.post(`/action/${name}`, payload);
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const msg = data ? JSON.stringify(data) : err instanceof Error ? err.message : String(err);
      const e = new Error(`Data API ${name} failed${status ? ` (${status})` : ""}: ${msg}`);
      e.cause = err;
      throw e;
    }
  }

  function base(collection) {
    return { dataSource, database, collection };
  }

  return {
    collections,

    async ping() {
      // Minimal sanity check: call findOne on jobs
      await action("findOne", { ...base(collections.jobs), filter: {}, projection: { _id: 1 } });
      return true;
    },

    async insertOne(collection, document) {
      return await action("insertOne", { ...base(collection), document });
    },

    async findOne(collection, { filter = {}, sort, projection } = {}) {
      const data = await action("findOne", { ...base(collection), filter, sort, projection });
      return data?.document ?? null;
    },

    async findOneAndUpdate(collection, { filter, update, sort, upsert = false, returnNew = true } = {}) {
      const data = await action("findOneAndUpdate", {
        ...base(collection),
        filter,
        update,
        sort,
        upsert,
        returnNewDocument: returnNew
      });
      return data?.document ?? null;
    },

    async updateOne(collection, { filter, update, upsert = false } = {}) {
      return await action("updateOne", { ...base(collection), filter, update, upsert });
    }
  };
}

