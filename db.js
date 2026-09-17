const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

if (!config.supabaseUrl) {
  console.error("Missing SUPABASE_URL environment variable.");
  process.exit(1);
}
if (!config.supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const TABLE = "users";
const data = { users: {} };
let saveQueue = Promise.resolve();

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

function normalizeUser(row) {
  return {
    user_id: String(row.user_id),
    guild_id: String(row.guild_id),
    messages: Number(row.messages || 0),
    vc_seconds: Number(row.vc_seconds || 0),
    vehicle_index: Number(row.vehicle_index || 0),
    last_vc_join: row.last_vc_join === null || row.last_vc_join === undefined
      ? null
      : Number(row.last_vc_join),
    updated_at: Number(row.updated_at || 0)
  };
}

function queueSave(user) {
  const snapshot = { ...user };
  saveQueue = saveQueue
    .then(async () => {
      const { error } = await supabase
        .from(TABLE)
        .upsert(snapshot, { onConflict: "guild_id,user_id" });

      if (error) throw error;
    })
    .catch(err => console.error("Could not save Supabase user:", err.message));

  return saveQueue;
}

async function loadAllUsers() {
  const pageSize = 1000;
  let from = 0;
  let rows = [];

  while (true) {
    const { data: page, error } = await supabase
      .from(TABLE)
      .select("user_id,guild_id,messages,vc_seconds,vehicle_index,last_vc_join,updated_at")
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows = rows.concat(page || []);

    if (!page || page.length < pageSize) break;
    from += pageSize;
  }

  for (const row of rows) {
    const user = normalizeUser(row);
    data.users[key(user.user_id, user.guild_id)] = user;
  }

  return rows.length;
}

async function init() {
  const count = await loadAllUsers();
  console.log(`Supabase connected. Users loaded: ${count}`);
}

function ensureUser(userId, guildId) {
  const k = key(userId, guildId);
  if (!data.users[k]) {
    data.users[k] = {
      user_id: userId,
      guild_id: guildId,
      messages: 0,
      vc_seconds: 0,
      vehicle_index: 0,
      last_vc_join: null,
      updated_at: Math.floor(Date.now() / 1000)
    };
    queueSave(data.users[k]);
  }
  return data.users[k];
}

function getUser(userId, guildId) {
  return { ...ensureUser(userId, guildId) };
}

function update(userId, guildId, changes) {
  const user = ensureUser(userId, guildId);
  Object.assign(user, changes, { updated_at: Math.floor(Date.now() / 1000) });
  queueSave(user);
  return { ...user };
}

function addMessage(userId, guildId, count = 1) {
  const user = ensureUser(userId, guildId);
  user.messages += Math.max(0, Math.floor(count));
  user.updated_at = Math.floor(Date.now() / 1000);
  queueSave(user);
}

function addVcSeconds(userId, guildId, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const user = ensureUser(userId, guildId);
  user.vc_seconds += Math.floor(seconds);
  user.updated_at = Math.floor(Date.now() / 1000);
  queueSave(user);
}

function setVcJoin(userId, guildId, timestamp) {
  update(userId, guildId, { last_vc_join: timestamp });
}

function clearVcJoin(userId, guildId) {
  update(userId, guildId, { last_vc_join: null });
}

function setVehicleIndex(userId, guildId, index) {
  update(userId, guildId, { vehicle_index: Math.max(0, Math.floor(index)) });
}

function topUsers(guildId, limit = 10) {
  return Object.values(data.users)
    .filter(user => user.guild_id === guildId)
    .sort((a, b) =>
      b.vehicle_index - a.vehicle_index ||
      b.vc_seconds - a.vc_seconds ||
      b.messages - a.messages
    )
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(user => ({ ...user }));
}

async function close() {
  const now = Date.now();

  // Save any currently active VC session before shutting down so a Render
  // restart does not silently discard time already spent in voice chat.
  for (const user of Object.values(data.users)) {
    if (user.last_vc_join !== null) {
      const seconds = Math.floor((now - user.last_vc_join) / 1000);
      if (seconds > 0) user.vc_seconds += seconds;
      user.last_vc_join = null;
      user.updated_at = Math.floor(now / 1000);
      queueSave(user);
    }
  }

  await saveQueue;
}

module.exports = {
  init,
  ensureUser,
  getUser,
  addMessage,
  addVcSeconds,
  setVcJoin,
  clearVcJoin,
  setVehicleIndex,
  topUsers,
  close
};
