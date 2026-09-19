const fs = require("fs");
const path = require("path");

let Canvas;
try {
  Canvas = require("@napi-rs/canvas");
} catch (err) {
  Canvas = null;
}

const DATA_FILE = path.join(__dirname, "progression-data.json");
const TIME_ZONE = process.env.PROGRESSION_TIMEZONE || "Asia/Kolkata";

let data = {};

function initProgression() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (parsed && typeof parsed === "object") data = parsed;
    }
  } catch (err) {
    console.error("Progression data load error:", err);
    data = {};
  }
}

function saveProgression() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Progression data save error:", err);
  }
}

function ensureGuild(guildId) {
  if (!data[guildId]) data[guildId] = { days: {}, activeVC: {} };
  if (!data[guildId].days) data[guildId].days = {};
  if (!data[guildId].activeVC) data[guildId].activeVC = {};
  return data[guildId];
}

function dateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

function addDay(guildId, key, field, amount) {
  const guild = ensureGuild(guildId);
  if (!guild.days[key]) guild.days[key] = { messages: 0, vcSeconds: 0 };
  guild.days[key][field] = Number(guild.days[key][field] || 0) + amount;
}

function splitSecondsByDay(startMs, endMs, onDay) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

  let cursor = startMs;
  while (cursor < endMs) {
    const key = dateKey(cursor);
    const next = (() => {
      // Find the next local midnight in TIME_ZONE using a small search window.
      // We use 26h to handle DST transitions safely.
      let lo = cursor + 1;
      let hi = cursor + 26 * 60 * 60 * 1000;
      const target = new Date(cursor);
      const currentKey = key;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (dateKey(mid) === currentKey) lo = mid;
        else hi = mid;
      }
      return hi;
    })();

    const segmentEnd = Math.min(endMs, next);
    const seconds = Math.max(0, (segmentEnd - cursor) / 1000);
    if (seconds > 0) onDay(key, seconds);
    cursor = segmentEnd;
  }
}

function recordMessageActivity(guildId) {
  addDay(guildId, dateKey(), "messages", 1);
  saveProgression();
}

function startVcSession(guildId, userId, startedAt = Date.now()) {
  const guild = ensureGuild(guildId);
  if (!guild.activeVC[userId]) {
    guild.activeVC[userId] = startedAt;
    saveProgression();
  }
}

function endVcSession(guildId, userId, endedAt = Date.now()) {
  const guild = ensureGuild(guildId);
  const startedAt = Number(guild.activeVC[userId]);
  if (!startedAt) return;

  splitSecondsByDay(startedAt, endedAt, (key, seconds) => {
    addDay(guildId, key, "vcSeconds", seconds);
  });

  delete guild.activeVC[userId];
  saveProgression();
}

function restoreVoiceSessions(client) {
  for (const guild of client.guilds.cache.values()) {
    const g = ensureGuild(guild.id);
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId) continue;
      if (state.member?.user?.bot) continue;
      if (!g.activeVC[state.id]) {
        g.activeVC[state.id] = Date.now();
      }
    }
  }
  saveProgression();
}

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

function formatDuration(seconds) {
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function lastDays(count) {
  const result = [];
  const now = new Date();
  // Generate local calendar dates by walking backwards in UTC noon-ish windows.
  for (let i = count - 1; i >= 0; i--) {
    const ms = Date.now() - i * 86400000;
    result.push(dateKey(ms));
  }
  // De-duplicate in the unlikely case of a DST boundary causing a repeated key.
  return [...new Set(result)];
}

function dayLabel(key) {
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric"
  }).format(d);
}

function renderGraph(title, subtitle, labels, values, formatter, accent) {
  if (!Canvas) {
    throw new Error("Missing @napi-rs/canvas dependency. Run: npm install @napi-rs/canvas");
  }

  const width = 1400;
  const height = 820;
  const canvas = Canvas.createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#071426");
  bg.addColorStop(1, "#02060d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Outer panel.
  ctx.strokeStyle = "#17395f";
  ctx.lineWidth = 2;
  roundRect(ctx, 24, 24, width - 48, height - 48, 28);
  ctx.stroke();

  ctx.fillStyle = "#f4f7ff";
  ctx.font = "700 46px sans-serif";
  ctx.fillText(title, 70, 92);
  ctx.fillStyle = "#8ea6c4";
  ctx.font = "500 23px sans-serif";
  ctx.fillText(subtitle, 72, 132);

  const chart = { x: 100, y: 205, w: 1190, h: 475 };
  const max = Math.max(...values, 1);
  const gridCount = 5;

  // Grid and y labels.
  for (let i = 0; i <= gridCount; i++) {
    const y = chart.y + chart.h - (chart.h * i / gridCount);
    ctx.strokeStyle = "rgba(111,145,181,0.20)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chart.x, y);
    ctx.lineTo(chart.x + chart.w, y);
    ctx.stroke();

    const v = max * i / gridCount;
    ctx.fillStyle = "#6e86a4";
    ctx.font = "500 18px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(formatter(v), chart.x - 18, y + 6);
  }
  ctx.textAlign = "left";

  const gap = 28;
  const barW = Math.max(36, (chart.w - gap * (values.length + 1)) / values.length);

  values.forEach((value, i) => {
    const x = chart.x + gap + i * (barW + gap);
    const h = Math.max(value > 0 ? 8 : 0, (value / max) * chart.h);
    const y = chart.y + chart.h - h;

    const grad = ctx.createLinearGradient(0, y, 0, chart.y + chart.h);
    grad.addColorStop(0, accent[0]);
    grad.addColorStop(1, accent[1]);
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, h, 12);
    ctx.fill();

    ctx.fillStyle = "#eaf2ff";
    ctx.font = "700 18px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(formatter(value), x + barW / 2, Math.max(y - 12, chart.y - 5));

    ctx.fillStyle = "#9ab0ca";
    ctx.font = "600 17px sans-serif";
    ctx.fillText(labels[i], x + barW / 2, chart.y + chart.h + 38);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#617895";
  ctx.font = "500 16px sans-serif";
  ctx.fillText(`Server-wide • ${TIME_ZONE}`, 70, height - 48);

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function getProgressionImages(guildId, count = 7) {
  const guild = ensureGuild(guildId);
  const keys = lastDays(count);
  const labels = keys.map(dayLabel);
  const vc = keys.map(k => Number(guild.days[k]?.vcSeconds || 0));
  const messages = keys.map(k => Number(guild.days[k]?.messages || 0));

  // Add currently active VC time through now without closing the session.
  const now = Date.now();
  const liveVc = {};
  for (const [userId, startedAt] of Object.entries(guild.activeVC)) {
    splitSecondsByDay(Number(startedAt), now, (key, seconds) => {
      liveVc[key] = (liveVc[key] || 0) + seconds;
    });
  }
  const finalVc = keys.map((k, i) => vc[i] + (liveVc[k] || 0));

  const vcBuffer = renderGraph(
    "SERVER VC TIME",
    "Total voice-chat time • all members combined",
    labels,
    finalVc,
    value => formatDuration(value),
    ["#2fd7ff", "#3157ff"]
  );

  const msgBuffer = renderGraph(
    "SERVER MESSAGES",
    "Total messages sent • all members combined",
    labels,
    messages,
    value => formatNumber(value),
    ["#ff72f2", "#7b36ff"]
  );

  return [
    { attachment: vcBuffer, name: "server-vc-time.png" },
    { attachment: msgBuffer, name: "server-messages.png" }
  ];
}

module.exports = {
  initProgression,
  recordMessageActivity,
  startVcSession,
  endVcSession,
  restoreVoiceSessions,
  getProgressionImages
};
