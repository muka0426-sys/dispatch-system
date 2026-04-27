import { createClient } from "@supabase/supabase-js";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export function createSupabase() {
  const url = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
    global: { headers: { "X-Client-Info": "line-dispatch-system" } }
  });

  async function ping() {
    const { error } = await supabase.from("jobs").select("id").limit(1);
    if (error) throw error;
    return true;
  }

  async function insertJob(job) {
    const { data, error } = await supabase.from("jobs").insert(job).select("*").single();
    if (error) throw error;
    return data;
  }

  async function claimOneJob() {
    // Requires DB function `claim_job()` (atomic claim with row lock).
    const { data, error } = await supabase.rpc("claim_job");
    if (error) throw error;
    return data ?? null;
  }

  async function updateJobById(id, patch) {
    const { error } = await supabase.from("jobs").update(patch).eq("id", id);
    if (error) throw error;
  }

  async function insertOrder(order) {
    const { data, error } = await supabase.from("orders").insert(order).select("*").single();
    if (error) throw error;
    return data;
  }

  async function updateOrderById(id, patch) {
    const { error } = await supabase.from("orders").update(patch).eq("id", id);
    if (error) throw error;
  }

  async function pickAvailableDriver() {
    const { data, error } = await supabase
      .from("drivers")
      .select("*")
      .eq("active", true)
      .eq("status", "available")
      .order("last_assigned_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  async function lockDriverBusy(driverId) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("drivers")
      .update({ status: "busy", last_assigned_at: now, updated_at: now })
      .eq("id", driverId)
      .eq("active", true)
      .eq("status", "available")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  return {
    ping,
    insertJob,
    claimOneJob,
    updateJobById,
    insertOrder,
    updateOrderById,
    pickAvailableDriver,
    lockDriverBusy
  };
}

