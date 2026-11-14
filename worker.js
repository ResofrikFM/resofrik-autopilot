/*
 * Resofrik FM Autopilot 2 — "a 360-degree team in an app"
 * For The Rare Breed.
 *
 * This Worker is the brain and the hands:
 *   - Writer: writes the week's posts every Saturday (AI, or built-in templates without a key).
 *   - Publisher: posts text, images, carousels and videos to Facebook, Instagram, Threads,
 *     Bluesky, Mastodon and Telegram, waiting for each platform to finish processing videos.
 *   - Community desk: turns Cleveland-area news and events (found by the Studio's scout) into
 *     posts and feeds them to the website's Community board.
 *   - Community manager: reads comments and replies, answers the simple ones, flags the rest.
 *   - Growth desk: link-in-bio page, email sign-ups, event submissions, click tracking, weekly report.
 *   - Producer: hands video/carousel jobs to the Studio (GitHub Actions) and stores what it makes.
 *
 * Bindings: D1 database as DB, R2 bucket as MEDIA.
 * Cron triggers: "*\/15 * * * *" and "0 22 * * 6" (remove the backslash).
 * Single file, no dependencies, runs on Cloudflare's free plan.
 */

const VERSION = "2.0.0";
const WEEKLY_CRON = "0 22 * * 6";
const LIVE_CRON = "* * * * *"; // every minute: is the studio streaming right now?

// Free plan allows 50 outside requests per run. We count ours and stop early, finishing next run.
let SUBREQ = 0;
let MEDIA_ENV = null; // lets fetchBytes read our own /m/ files straight from R2 (a Worker cannot fetch its own workers.dev URL)
const BUDGET = 40;
function resetBudget() {
  SUBREQ = 0;
}
function budgetLeft() {
  return BUDGET - SUBREQ;
}
async function xfetch(url, init) {
  SUBREQ++;
  return fetch(url, init);
}

// ---------------------------------------------------------------------------
// Settings (editable in the control panel)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  paused: false,
  station: {
    name: "Resofrik FM",
    slogan: "For The Rare Breed",
    website: "https://resofrikfm.com",
    listenUrl: "https://resofrikfm.com",
    donateUrl: "https://resofrikfm.com",
    signupUrl: "",
    linkLabel: "resofrikfm.com",
    logoUrl: "",
    callIn: "216.490.0011",
    city: "Cleveland",
    timezone: "America/New_York",
    brandColor: "#c9a227",
    darkColor: "#111111",
    about:
      "Resofrik FM is a nonprofit online community radio station serving Cleveland and listeners worldwide. " +
      "The schedule mixes music with programs and podcasts: music for a while, then a program or two. " +
      "We only play songs artists send us with permission. Supported by a NeighborUp grant from Neighborhood Connections.",
    voice:
      "Warm, proud, a little rebellious. Rooted in Cleveland, open to the world. Give something before asking for anything. " +
      "Plain words, no corporate speak, no exaggeration.",
    hashtagsLocal: ["#Cleveland", "#CLE", "#CommunityRadio"],
    hashtagsGlobal: ["#IndieMusic", "#RareBreed", "#OnlineRadio"],
  },
  pillars: [
    { key: "music", name: "Rare Breed Sounds", share: 35, ideas: "Artist spotlights, new songs on rotation, weekend playlist picks" },
    { key: "program", name: "Real Talk", share: 25, ideas: "Programs and podcasts on the schedule, why to tune in" },
    { key: "community", name: "Our Cleveland", share: 20, ideas: "Neighborhood life, local events, partners, Cleveland Poetry in Black and White" },
    { key: "behind", name: "Behind the mic", share: 10, ideas: "How the station runs, volunteers, hosts, the call-in line" },
    { key: "cta", name: "Join the breed", share: 10, ideas: "Listen live, join the email list, request a song, donate, sponsor" },
  ],
  schedule: [
    { show: "All These Things", active: false, day: "Wed", start: "19:00", durationMin: 60, description: "Conversation and culture on Resofrik FM", note: "Set the real day and time, then change active to true" },
  ],
  artists: [
    // { name, genre, song, city, instagram, image: "https://…jpg", audio: "https://…mp3 (sent with permission)", audioStart: 30, note }
  ],
  partners: ["Neighborhood Connections"],
  images: { default: [], music: [], program: [], community: [], behind: [], cta: [], reminder: [] },
  weekly: { enabled: true, times: ["09:30", "13:00", "18:30"], globalTime: "13:00", autoApprove: true, platforms: ["bluesky", "facebook", "instagram", "threads", "mastodon", "telegram"] },
  reminders: { enabled: true, minutesBefore: 60, onAir: true, platforms: ["bluesky", "facebook", "instagram", "threads", "mastodon", "telegram"] },
  nowPlaying: {
    enabled: false,
    url: "",
    maxPerDay: 4,
    minGapMinutes: 150,
    quietHours: ["00:00", "07:00"],
    ignoreWords: ["Resofrik", "station id", "jingle", "promo", "sweeper", "advert", "commercial", "unknown"],
    platforms: ["bluesky", "threads", "mastodon", "telegram"],
    requireCard: true, // only post songs the Studio has already made a picture card for
  },
  live: {
    enabled: false, // turn on once the Cloudflare Stream live input exists
    customerCode: "", // from the Stream dashboard: customer-XXXX.cloudflarestream.com, the XXXX part
    inputId: "", // the live input's ID
    title: "All These Things with Papa Tee",
    pageUrl: "https://resofrikfm.com/live/",
    teaser: true, // post "we're live" on social when the stream starts
    minGapMinutes: 180, // never post two teasers closer than this (covers dropped connections)
    image: "", // picture for the teaser; empty = a show photo from the library
    platforms: ["facebook", "instagram", "threads", "bluesky", "mastodon", "telegram"],
  },
  community: {
    enabled: true,
    musicVideo: true, // news posts go out as short videos with music from the music library
    // the studio's neighbourhood: news that mentions these towns is scored higher than Cleveland-wide news
    localPlaces: ["Oakwood Village", "Oakwood", "Bedford", "Bedford Heights", "Walton Hills", "Maple Heights", "Garfield Heights", "Richmond Heights", "Warrensville Heights", "Solon", "Valley View", "Independence", "Highland Hills", "North Randall"],
    localBoost: 2,
    times: ["11:15", "16:15"],
    minScore: 6,
    autoApprove: true,
    maxAgeDays: 10,
    platforms: ["bluesky", "facebook", "instagram", "threads", "mastodon", "telegram"],
    blockWords: ["shooting", "shot", "killed", "homicide", "murder", "stabbing", "arrest", "indicted", "crash", "fatal", "dies", "dead", "overdose", "lawsuit", "sentenced", "police chase", "assault", "robbery", "gunfire"],
    boostWords: ["festival", "free", "concert", "music", "art", "poetry", "community", "volunteer", "youth", "grant", "workshop", "library", "market", "celebration", "open mic", "neighborhood", "job fair", "resource", "family", "culture", "african", "caribbean", "juneteenth", "heritage"],
  },
  sources: [
    // the towns around the studio first: city halls' own news, then every outlet's coverage via Google News
    { name: "City of Bedford", url: "https://bedfordoh.gov/feed/", type: "rss", region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "Oakwood Village", url: "https://www.oakwoodvillageoh.com/category/news/feed/", type: "rss", region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "City of Maple Heights", url: "https://mapleheightsohio.gov/category/news/feed/", type: "rss", region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "City of Garfield Heights", url: "https://www.garfieldhts.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml", type: "rss", region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "City of Richmond Heights", url: "https://www.richmondheightsohio.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml", type: "rss", region: "East suburbs", autoPost: true, enabled: true },
    { name: "The Neighborhood News", url: "https://theneighborhoodnews.com/feed/", type: "rss", region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Bedford", url: '"Bedford, Ohio" OR "Bedford, OH" OR "Bedford City Schools"', type: "gnews", mustMention: ["Bedford"], mustNotMention: ["England", "UK", "Bedfordshire", "Massachusetts", "Texas", "Virginia", "Indiana", "Iowa", "Pennsylvania", "New Hampshire", "New York", "Kentucky", "Nova Scotia"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Oakwood Village", url: '"Oakwood Village" Ohio', type: "gnews", mustMention: ["Oakwood"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Maple Heights", url: '"Maple Heights"', type: "gnews", mustMention: ["Maple Heights"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Garfield Heights", url: '"Garfield Heights"', type: "gnews", mustMention: ["Garfield Heights"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Bedford Heights", url: '"Bedford Heights"', type: "gnews", mustMention: ["Bedford Heights"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Walton Hills", url: '"Walton Hills"', type: "gnews", mustMention: ["Walton Hills"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Richmond Heights", url: '"Richmond Heights" Ohio', type: "gnews", mustMention: ["Richmond Heights"], mustNotMention: ["Missouri", "Florida", "St. Louis", "Miami"], region: "East suburbs", autoPost: true, enabled: true },
    { name: "News: Warrensville Heights", url: '"Warrensville Heights"', type: "gnews", mustMention: ["Warrensville"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "News: Solon", url: '"Solon, Ohio" OR "Solon City Schools"', type: "gnews", mustMention: ["Solon"], mustNotMention: ["Iowa", "Maine"], region: "Southeast suburbs", autoPost: true, enabled: true },
    { name: "Signal Cleveland", url: "https://signalcleveland.org/feed/", type: "rss", region: "Northeast Ohio", autoPost: true, enabled: true },
    { name: "Cuyahoga Land Bank (City of Cleveland news)", url: "https://cuyahogalandbank.org/blog/tag/city-of-cleveland/feed/", type: "rss", region: "Northeast Ohio", autoPost: true, enabled: true },
    { name: "Cleveland Scene", url: "https://www.clevescene.com/feed/", type: "rss", region: "Northeast Ohio", autoPost: false, enabled: true },
    { name: "News 5 Cleveland (local)", url: "https://www.news5cleveland.com/news/local.rss", type: "rss", region: "Northeast Ohio", autoPost: false, enabled: false },
    // Add more: city/library/arts-council RSS feeds, event calendars (type "ics"),
    // Bluesky accounts (type "bluesky", url = handle), Mastodon accounts (type "mastodon", url = https://server/@name).
  ],
  studio: {
    clipTimes: ["12:00", "20:00"],
    clipsPerVideo: 4,
    clipSeconds: [20, 55],
    carouselTime: "12:00",
    carousels: { clevelandThisWeek: true, rotation: true, lineup: true },
    slideshowVideos: true,
    musicBedUrl: "",
    videoFeeds: [
      // { name: "All These Things podcast", url: "https://…/podcast.rss", type: "podcast" },
      // { name: "Resofrik FM on YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=…", type: "youtube" }
    ],
    videoPlatforms: ["instagram", "facebook", "threads", "bluesky", "mastodon", "telegram"],
    stories: { enabled: true, days: ["Tue", "Fri"], time: "19:30" },
  },
  engage: { enabled: true, autoReply: "simple", maxAutoPerHour: 10 },
  report: { enabled: true, day: "Mon", time: "09:00" },
  ai: { model: "claude-sonnet-5-5" },
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    MEDIA_ENV = env;
    resetBudget();
    try {
      await ensureSchema(env);
      env = await withPageToken(env);
      MEDIA_ENV = env;
      return await handleHttp(request, env, ctx);
    } catch (e) {
      return new Response("Something went wrong: " + esc(String((e && e.message) || e)), { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
};

async function runScheduled(cron, env) {
  MEDIA_ENV = env;
  resetBudget();
  await ensureSchema(env);
  env = await withPageToken(env);
  MEDIA_ENV = env;
  if (cron === WEEKLY_CRON) await weeklyJob(env, { force: false });
  else if (cron === LIVE_CRON) await liveCheck(env, await loadSettings(env), Date.now()).catch((e) => log(env, "error", `Live check: ${e.message}`));
  else await tick(env);
}

// ---------------------------------------------------------------------------
// Storage (D1)
// ---------------------------------------------------------------------------
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)",
  "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, when_ms INTEGER, status TEXT, kind TEXT, data TEXT)",
  "CREATE INDEX IF NOT EXISTS posts_when ON posts(when_ms)",
  "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, created INTEGER, status TEXT, score REAL, data TEXT)",
  "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, level TEXT, msg TEXT)",
  "CREATE TABLE IF NOT EXISTS clicks (day TEXT, post_id TEXT, platform TEXT, n INTEGER, PRIMARY KEY (day, post_id, platform))",
  "CREATE TABLE IF NOT EXISTS subs (email TEXT PRIMARY KEY, created INTEGER, source TEXT, name TEXT)",
  "CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, created INTEGER, platform TEXT, status TEXT, data TEXT)",
  "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created INTEGER, status TEXT, type TEXT, data TEXT)",
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v, exp FROM kv WHERE k = ?").bind(k).first();
  if (!r) return null;
  if (r.exp && r.exp < Date.now()) return null;
  return r.v;
}
async function kvPut(env, k, v, ttlSec) {
  const exp = ttlSec ? Date.now() + ttlSec * 1000 : null;
  await env.DB.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp").bind(k, String(v), exp).run();
}
// FB_PAGE_TOKEN may be a (long-lived) user token: swap it once for the Page's own token, which never expires, and keep it.
async function withPageToken(env) {
  const src = String(env.FB_PAGE_TOKEN || "").replace(/\s+/g, "");
  if (!src || !env.FB_PAGE_ID || !env.DB) return env;
  const key = "pagetok2:" + src.slice(-24);
  let tok = await kvGet(env, key);
  if (!tok) {
    tok = src;
    try {
      const r = await xfetch(`${graph(env)}/${env.FB_PAGE_ID}?fields=access_token&access_token=${encodeURIComponent(src)}`);
      const d = await r.json();
      if (d && d.access_token) {
        tok = d.access_token;
        await kvPut(env, key, tok);
      }
    } catch {}
  }
  return { ...env, FB_PAGE_TOKEN: tok };
}
async function kvDel(env, k) {
  await env.DB.prepare("DELETE FROM kv WHERE k = ?").bind(k).run();
}
async function kvJson(env, k, dflt) {
  const v = await kvGet(env, k);
  if (!v) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
}

async function loadSettings(env) {
  const raw = await kvGet(env, "settings");
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeDefaults(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
async function saveSettings(env, s) {
  await kvPut(env, "settings", JSON.stringify(s));
}
function mergeDefaults(def, val) {
  if (Array.isArray(def) || Array.isArray(val)) return val === undefined ? def : val;
  if (def && typeof def === "object" && val && typeof val === "object") {
    const out = { ...def };
    for (const k of Object.keys(val)) out[k] = k in def ? mergeDefaults(def[k], val[k]) : val[k];
    return out;
  }
  return val === undefined ? def : val;
}

function normalizePost(p) {
  if (!p.media) p.media = p.image ? { type: "image", urls: [p.image] } : { type: "none", urls: [] };
  delete p.image;
  if (!p.results) p.results = {};
  return p;
}
async function savePost(env, post) {
  normalizePost(post);
  await env.DB.prepare("INSERT INTO posts (id, when_ms, status, kind, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET when_ms = excluded.when_ms, status = excluded.status, kind = excluded.kind, data = excluded.data")
    .bind(post.id, post.when, post.status, post.kind, JSON.stringify(post))
    .run();
}
async function getPost(env, id) {
  const r = await env.DB.prepare("SELECT data FROM posts WHERE id = ?").bind(id).first();
  return r ? normalizePost(JSON.parse(r.data)) : null;
}
async function queryPosts(env, sql, ...args) {
  const r = await env.DB.prepare("SELECT data FROM posts " + sql).bind(...args).all();
  return (r.results || []).map((x) => normalizePost(JSON.parse(x.data)));
}
async function deletePost(env, id) {
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
}

async function log(env, level, msg) {
  await env.DB.prepare("INSERT INTO logs (t, level, msg) VALUES (?, ?, ?)").bind(Date.now(), level, String(msg).slice(0, 600)).run();
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}
async function hashId(s) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Time helpers (station time zone)
// ---------------------------------------------------------------------------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PLURAL = { Sun: "Sundays", Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function zoneParts(utcMs, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}`, dow: DOW.indexOf(g("weekday")), y: +g("year"), mo: +g("month"), d: +g("day"), h: +g("hour"), mi: +g("minute"), s: +g("second") };
}
function tzOffset(tz, utcMs) {
  const p = zoneParts(utcMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000;
}
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffset(tz, guess);
  let utc = guess - off1;
  const off2 = tzOffset(tz, utc);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}
function nextMonday(nowMs, tz) {
  const p = zoneParts(nowMs, tz);
  return addDays(p.date, (8 - p.dow) % 7 || 7);
}
function thisMonday(nowMs, tz) {
  const p = zoneParts(nowMs, tz);
  return addDays(p.date, -((p.dow + 6) % 7));
}
function fmtLocal(utcMs, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(utcMs));
}
function fmtTime12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}` : `${h12} ${h >= 12 ? "PM" : "AM"}`;
}
function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow}, ${MONTHS[m - 1]} ${d}`;
}
function isValidTime(t) {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}
function isValidDate(d) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function inQuietHours(nowMs, settings) {
  const q = settings.nowPlaying.quietHours;
  if (!Array.isArray(q) || q.length !== 2) return false;
  const t = zoneParts(nowMs, settings.station.timezone).time;
  return q[0] <= q[1] ? t >= q[0] && t < q[1] : t >= q[0] || t < q[1];
}

// ---------------------------------------------------------------------------
// The 15-minute tick
// ---------------------------------------------------------------------------
async function tick(env) {
  const now = Date.now();
  const settings = await loadSettings(env);
  await kvPut(env, "status:lastTick", String(now));
  if (settings.paused) return { paused: true };
  const report = { published: 0, reminders: 0, nowPlaying: 0, inbox: 0, community: 0 };
  const steps = [
    ["Publisher", async () => (report.published = await publishDue(env, settings, now))],
    ["Show reminders", async () => (report.reminders = await showReminders(env, settings, now))],
    ["Community desk", async () => (report.community = await communityDaily(env, settings, now))],
    ["Now Playing", async () => (report.nowPlaying = await nowPlaying(env, settings, now))],
    ["Inbox", async () => (report.inbox = await inboxHourly(env, settings, now))],
    ["Weekly report", async () => weeklyReport(env, settings, now)],
    ["Housekeeping", async () => housekeeping(env, now)],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      await log(env, "error", `${name}: ${e.message}`);
    }
  }
  return report;
}

async function housekeeping(env, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (await kvGet(env, "hk:" + day)) return;
  await kvPut(env, "hk:" + day, "1", 2 * 86400);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?").bind(now),
    env.DB.prepare("DELETE FROM logs WHERE t < ?").bind(now - 30 * 86400000),
    env.DB.prepare("DELETE FROM posts WHERE when_ms < ? AND status IN ('published','skipped','failed','partial','nowhere')").bind(now - 120 * 86400000),
    env.DB.prepare("DELETE FROM items WHERE created < ? AND status IN ('new','skipped','review')").bind(now - 45 * 86400000),
  ]);
}

const DUE_STATUSES = ["scheduled", "approved", "processing", "publishing"];
async function publishDue(env, settings, now) {
  const posts = await queryPosts(env, "WHERE when_ms <= ? AND when_ms >= ? AND status IN ('scheduled','approved','processing','publishing','failed','partial') ORDER BY when_ms LIMIT 12", now, now - 12 * 3600 * 1000);
  let done = 0;
  for (const post of posts) {
    if (budgetLeft() < 8) break;
    const retry = post.status === "failed" || post.status === "partial";
    if (retry && ((post.attempts || 0) >= 3 || now - post.when > 6 * 3600 * 1000)) continue;
    if (!DUE_STATUSES.includes(post.status) && !retry) continue;
    if (retry && Object.values(post.results).every((r) => r.ok || r.skipped || r.error === "not connected")) continue;
    await publishPost(env, settings, post);
    await savePost(env, post);
    await reportPost(env, settings, post);
    done++;
  }
  return done;
}

async function reportPost(env, settings, post) {
  if (post.status === "processing" || post.status === "publishing") return;
  const res = Object.entries(post.results || {});
  const failed = res.filter(([, r]) => !r.ok && !r.skipped && r.error !== "not connected" && !r.pending);
  const ok = res.filter(([, r]) => r.ok).map(([p]) => p);
  if (failed.length) {
    const msg = `${post.kind} post (${fmtLocal(post.when, settings.station.timezone)}) had problems: ` + failed.map(([p, r]) => `${p}: ${r.error}`).join("; ");
    await log(env, "error", msg);
    if ((post.attempts || 0) >= 3) await notify(env, "⚠️ Resofrik Autopilot: " + msg);
  }
  if (ok.length && !post.reported) {
    post.reported = true;
    await savePost(env, post);
    await log(env, "ok", `Posted ${post.media.type !== "none" ? post.media.type + " " : ""}to ${ok.join(", ")}: "${(post.short || post.long || "").slice(0, 70)}…"`);
  }
}

// ---------------------------------------------------------------------------
// Show reminders
// ---------------------------------------------------------------------------
async function showReminders(env, settings, now) {
  const r = settings.reminders;
  if (!r.enabled) return 0;
  const tz = settings.station.timezone;
  const today = zoneParts(now, tz);
  let sent = 0;
  for (const show of activeShows(settings)) {
    if (DOW.indexOf(show.day) !== today.dow) continue;
    const startUtc = zonedToUtc(today.date, show.start, tz);
    const moments = [{ tag: "pre", at: startUtc - (r.minutesBefore || 60) * 60000 }];
    if (r.onAir) moments.push({ tag: "on", at: startUtc });
    for (const m of moments) {
      if (now < m.at || now >= m.at + 15 * 60000) continue;
      const dedupe = `rem:${slug(show.show)}:${today.date}:${m.tag}`;
      if (await kvGet(env, dedupe)) continue;
      await kvPut(env, dedupe, "1", 3 * 86400);
      const card = (await kvJson(env, "showcards", {}))[slug(show.show)];
      const post = buildReminderPost(settings, show, m.tag, now, card);
      await publishPost(env, settings, post);
      await savePost(env, post);
      await reportPost(env, settings, post);
      sent++;
    }
  }
  return sent;
}

function buildReminderPost(settings, show, tag, now, card) {
  const st = settings.station;
  const v = Math.floor(now / 86400000) % 3;
  const time = fmtTime12(show.start);
  const desc = show.description ? ` ${show.description}.` : "";
  const pre = [
    `${show.show} is on in one hour, ${time} Eastern on ${st.name}.${desc} Pull up a chair.`,
    `Tonight on ${st.name}: ${show.show} at ${time} ET.${desc} See you there.`,
    `Set a reminder: ${show.show} starts at ${time} Eastern.${desc} ${st.slogan}.`,
  ];
  const on = [`On air now: ${show.show} on ${st.name}.${desc} Tune in live.`, `We're live with ${show.show}. Come through.`, `${show.show} has started on ${st.name}. Call in at ${st.callIn}.`];
  const text = (tag === "pre" ? pre : on)[v];
  const img = card || pickImage(settings, "reminder", now) || pickImage(settings, "program", now);
  return normalizePost({
    id: newId(),
    kind: tag === "pre" ? "reminder" : "on-air",
    when: now,
    status: "scheduled",
    pillar: "program",
    short: text,
    long: text + "\n\n" + st.hashtagsLocal.join(" "),
    link: st.listenUrl,
    media: img ? { type: "image", urls: [img] } : { type: "none", urls: [] },
    platforms: settings.reminders.platforms,
    results: {},
    createdAt: now,
  });
}

// ---------------------------------------------------------------------------
// Now Playing
// ---------------------------------------------------------------------------
async function nowPlaying(env, settings, now) {
  const np = settings.nowPlaying;
  if (!np.enabled || !np.url || budgetLeft() < 10) return 0;
  const tz = settings.station.timezone;
  const res = await xfetch(np.url, { headers: { "user-agent": "ResofrikAutopilot/2" } });
  if (!res.ok) throw new Error(`stream status ${res.status}`);
  const body = await res.text();
  const track = parseNowPlaying(body);
  if (!track) return 0;
  const songs = parseSongs(body);
  if (songs.length) await rememberSongs(env, np, songs); // the Studio makes a picture card for each new song
  if (inQuietHours(now, settings)) return 0;
  const state = await kvJson(env, "np:state", {});
  const today = zoneParts(now, tz).date;
  const countToday = state.date === today ? state.count || 0 : 0;
  if (countToday >= (np.maxPerDay || 4)) return 0;
  if (state.lastAt && now - state.lastAt < (np.minGapMinutes || 150) * 60000) return 0;
  const lower = track.toLowerCase();
  if ((np.ignoreWords || []).some((w) => w && lower.includes(w.toLowerCase()))) return 0;
  if (track === state.lastTrack) return 0;
  const cards = await kvJson(env, "np:cards", {});
  const card = cards[track] || "";
  if (np.requireCard !== false && (!card || !songs.length || !songs[0].artist)) return 0; // wait for a song with artist, title and its card
  const st = settings.station;
  const artist = matchArtist(settings, track);
  let text = [`Now playing on ${st.name}: ${track} 🎶`, `On the air right now: ${track}. ${st.slogan}.`, `${track}, playing now on ${st.name}. Tune in 📻`][countToday % 3];
  if (artist && artist.city) text += ` (from ${artist.city})`;
  const post = normalizePost({ id: newId(), kind: "now-playing", when: now, status: "scheduled", pillar: "music", short: text, long: text, link: st.listenUrl, media: card ? { type: "image", urls: [card] } : { type: "none", urls: [] }, platforms: np.platforms, results: {}, createdAt: now });
  await publishPost(env, settings, post);
  await savePost(env, post);
  await reportPost(env, settings, post);
  await kvPut(env, "np:state", JSON.stringify({ date: today, count: countToday + 1, lastAt: now, lastTrack: track }));
  return 1;
}
// ---------------------------------------------------------------------------
// Live video: Cloudflare Stream. The site's Live page and banner read
// /api/public/live; the every-minute check posts the "we're live" teaser.
// ---------------------------------------------------------------------------
function liveBase(lv) {
  const code = String(lv.customerCode || "").replace(/^https?:\/\//, "").replace(/^customer-/, "").replace(/\.cloudflarestream\.com.*$/, "").trim();
  const id = String(lv.inputId || "").trim();
  return code && /^[a-z0-9]+$/i.test(code) && /^[a-f0-9]{32}$/i.test(id) ? `https://customer-${code}.cloudflarestream.com` : "";
}
async function liveStatus(settings) {
  const lv = settings.live || {};
  const base = liveBase(lv);
  if (!lv.enabled || !base) return { configured: false, live: false };
  const res = await xfetch(`${base}/${lv.inputId.trim()}/lifecycle`, { cf: { cacheTtl: 10 } });
  if (!res.ok) throw new Error(`Stream lifecycle ${res.status}`);
  const j = await res.json();
  return { configured: true, live: !!j.live, videoUID: j.videoUID || null };
}
function liveTeaserText(settings, n) {
  const lv = settings.live, st = settings.station;
  const t = lv.title || st.name;
  return [
    `🔴 LIVE NOW: ${t}. Watch the full show and join the chat at ${st.linkLabel || "resofrikfm.com"}/live`,
    `We're live on ${st.name} 🔴 ${t} is on right now. Pull up a chair: ${st.linkLabel || "resofrikfm.com"}/live`,
    `On the air and on camera 🔴 ${t}, live from the studio. ${st.slogan}. Watch at ${st.linkLabel || "resofrikfm.com"}/live`,
  ][n % 3];
}
async function liveCheck(env, settings, now) {
  if (settings.paused) return 0;
  const s = await liveStatus(settings);
  if (!s.configured) return 0;
  const state = await kvJson(env, "live:state", {});
  if (s.live) {
    if (!state.live) {
      state.live = true;
      state.since = now;
      state.offCount = 0;
      if (s.videoUID) state.videoUID = s.videoUID;
      await log(env, "info", "Live: the studio stream started");
      const lv = settings.live;
      if (lv.teaser !== false && !(state.lastTeaserAt && now - state.lastTeaserAt < (lv.minGapMinutes || 180) * 60000)) {
        let img = lv.image || "";
        if (!img) {
          const photos = (await listPhotos(env)).filter((x) => x.tag === "shows" || x.tag === "station");
          const show = photos.filter((x) => /all these things/i.test(x.about));
          const pool = show.length ? show : photos;
          if (pool.length) img = pool[Math.floor(now / 60000) % pool.length].url;
        }
        const n = state.teasers || 0;
        const text = liveTeaserText(settings, n);
        const post = normalizePost({ id: newId(), kind: "live", when: now, status: "scheduled", pillar: "program", short: text, long: text, link: lv.pageUrl || settings.station.website, media: img ? { type: "image", urls: [img] } : { type: "none", urls: [] }, platforms: lv.platforms, results: {}, createdAt: now });
        await publishPost(env, settings, post);
        await savePost(env, post);
        state.lastTeaserAt = now;
        state.teasers = n + 1;
      }
    } else if (s.videoUID) state.videoUID = s.videoUID;
  } else if (state.live) {
    // two quiet checks in a row before calling it over: OBS reconnects after a blip
    state.offCount = (state.offCount || 0) + 1;
    if (state.offCount >= 2) {
      state.live = false;
      state.endedAt = now;
      if (state.videoUID) state.lastVideo = state.videoUID;
      state.videoUID = null;
      await log(env, "info", "Live: the studio stream ended");
    }
  } else return 0;
  await kvPut(env, "live:state", JSON.stringify(state));
  return 1;
}
async function publicLive(env, settings) {
  const lv = settings.live || {};
  const base = liveBase(lv);
  const state = await kvJson(env, "live:state", {});
  let s = { configured: false, live: false };
  try {
    s = await liveStatus(settings);
  } catch {
    s = { configured: !!base && !!lv.enabled, live: !!state.live };
  }
  const id = String(lv.inputId || "").trim();
  return {
    configured: s.configured,
    live: s.live,
    since: s.live ? state.since || null : null,
    title: lv.title || settings.station.name,
    player: s.configured ? `${base}/${id}/iframe` : "",
    replay: s.configured && state.lastVideo ? `${base}/${state.lastVideo}/iframe` : "",
    replayPoster: s.configured && state.lastVideo ? `${base}/${state.lastVideo}/thumbnails/thumbnail.jpg?time=60s&height=480` : "",
    endedAt: state.endedAt || null,
  };
}
function parseSongs(body) {
  // AzuraCast: the song on air now, the next one and the last few, with their artwork
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const az = Array.isArray(j) ? j[0] : j;
  if (!az || !az.now_playing) return [];
  const clean = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const list = [az.now_playing, az.playing_next, ...(az.song_history || [])].filter((x) => x && x.song);
  return list
    .map((x) => ({ artist: clean(x.song.artist), title: clean(x.song.title || x.song.text), art: /^https:\/\/.+\.(jpe?g|png|webp)$/i.test(x.song.art || "") ? x.song.art : "" }))
    .filter((x) => x.title)
    .map((x) => ({ ...x, track: x.artist ? `${x.artist} – ${x.title}` : x.title }));
}
async function rememberSongs(env, np, songs) {
  const seen = await kvJson(env, "np:seen", []);
  const ign = (np.ignoreWords || []).map((w) => w.toLowerCase()).filter(Boolean);
  let changed = false;
  for (const s of songs) {
    if (!s.artist || seen.some((x) => x.track === s.track) || ign.some((w) => s.track.toLowerCase().includes(w))) continue;
    seen.push(s);
    changed = true;
  }
  if (changed) await kvPut(env, "np:seen", JSON.stringify(seen.slice(-300)));
}

function parseNowPlaying(body) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {}
  if (j) {
    const az = Array.isArray(j) ? j[0] : j;
    if (az && az.now_playing && az.now_playing.song) {
      const s = az.now_playing.song;
      if (s.artist && s.title) return clean(`${s.artist} – ${s.title}`);
      return clean(s.text || s.title);
    }
    if (j.icestats) {
      let src = j.icestats.source;
      if (Array.isArray(src)) src = src.find((x) => x && (x.title || x.artist)) || src[0];
      if (src) return src.artist && src.title ? clean(`${src.artist} – ${src.title}`) : clean(src.title || src.yp_currently_playing);
    }
    if (j.songtitle) return clean(j.songtitle);
    if (j.artist && j.title) return clean(`${j.artist} – ${j.title}`);
    if (j.title) return clean(j.title);
    return null;
  }
  const text = clean(body.replace(/<[^>]+>/g, " "));
  return text && text.length <= 200 ? text : null;
}
function matchArtist(settings, track) {
  const t = track.toLowerCase();
  return (settings.artists || []).find((a) => a.name && t.includes(a.name.toLowerCase())) || null;
}

// ---------------------------------------------------------------------------
// Weekly writer
// ---------------------------------------------------------------------------
async function weeklyJob(env, { force }) {
  const settings = await loadSettings(env);
  await refreshThreadsToken(env).catch((e) => log(env, "error", "Threads token refresh: " + e.message));
  if (settings.paused && !force) return { skipped: "paused" };
  if (!settings.weekly.enabled && !force) return { skipped: "weekly off" };
  const tz = settings.station.timezone;
  const monday = nextMonday(Date.now(), tz);
  if (!force && (await kvGet(env, "week:" + monday))) return { skipped: "already done" };
  const slots = buildSlots(settings, monday);
  let posts = null;
  let source = "templates";
  if (env.ANTHROPIC_API_KEY) {
    try {
      posts = await aiWriteWeek(env, settings, slots, monday);
      source = "AI";
    } catch (e) {
      await log(env, "error", "AI writer failed, used templates instead: " + e.message);
    }
  }
  if (!posts) posts = await templateWeek(env, settings, slots);
  if (force) {
    const start = zonedToUtc(monday, "00:00", tz);
    const end = zonedToUtc(addDays(monday, 7), "00:00", tz);
    await env.DB.prepare("DELETE FROM posts WHERE kind = 'weekly' AND status IN ('scheduled','needs_review') AND when_ms >= ? AND when_ms < ?").bind(start, end).run();
  }
  for (const p of posts) await savePost(env, p);
  await kvPut(env, "week:" + monday, JSON.stringify({ at: Date.now(), count: posts.length, source }), 30 * 86400);
  // ask the Studio for this week's carousels and slideshow videos
  await kvPut(env, "studio:weekly", JSON.stringify({ monday, at: Date.now() }));
  await scheduleCommunity(env, settings, Date.now());
  const msg = `Wrote ${posts.length} posts for the week of ${monday} (${source}).` + (settings.weekly.autoApprove ? " They go out on schedule unless you skip them." : " They are waiting for your approval.");
  await log(env, "ok", msg);
  await notify(env, "📻 Resofrik Autopilot: " + msg + (env.PUBLIC_URL ? " Panel: " + env.PUBLIC_URL : ""));
  return { count: posts.length, source, monday };
}

function buildSlots(settings, monday) {
  const tz = settings.station.timezone;
  const times = (settings.weekly.times || []).filter(isValidTime).sort();
  const slots = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    for (const time of times) slots.push({ date, time, day: DOW[(i + 1) % 7], global: time === settings.weekly.globalTime, when: zonedToUtc(date, time, tz) });
  }
  const pillars = settings.pillars.filter((p) => p.share > 0);
  const total = pillars.reduce((a, p) => a + p.share, 0) || 1;
  const counts = Object.fromEntries(pillars.map((p) => [p.key, 0]));
  slots.forEach((s, i) => {
    let best = pillars[0];
    let bestScore = -Infinity;
    for (const p of pillars) {
      const score = (p.share / total) * (i + 1) - counts[p.key];
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    counts[best.key]++;
    s.pillar = best.key;
    s.pillarName = best.name;
    s.n = i + 1;
  });
  return slots;
}

function activeShows(settings) {
  return (settings.schedule || []).filter((s) => s.active && isValidTime(s.start) && DOW.indexOf(s.day) >= 0);
}

async function claude(env, settings, system, user, maxTokens = 4000) {
  const res = await xfetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: settings.ai.model || "claude-sonnet-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return (data.content || []).map((c) => c.text || "").join("");
}

function extractJson(text, open = "[", close = "]") {
  const s = text.indexOf(open);
  const e = text.lastIndexOf(close);
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

const AI_RULES =
  "Rules: 1) Use ONLY facts given in the brief. Never invent show times, guests, events, statistics, quotes, awards or song details. " +
  "2) Only name artists and songs listed in the brief. 3) Only mention shows listed, with exactly the day and time given. " +
  "4) No song lyrics. No promises of prizes. No political endorsements. 5) Give the reader something before asking for anything. " +
  "6) Do not put URLs in the text; the system adds the link. 7) Vary openings. Reply with JSON only.";

async function aiWriteWeek(env, settings, slots, monday) {
  const st = settings.station;
  const recent = (await queryPosts(env, "WHERE kind = 'weekly' ORDER BY when_ms DESC LIMIT 25")).map((p) => p.short);
  const brief = {
    station: { name: st.name, slogan: st.slogan, city: st.city, about: st.about, callIn: st.callIn, website: st.linkLabel },
    voice: st.voice,
    pillars: settings.pillars,
    shows_on_the_schedule: activeShows(settings).map((s) => ({ show: s.show, day: s.day, time: fmtTime12(s.start) + " ET", about: s.description })),
    artists_in_rotation: (settings.artists || []).map(({ audio, image, ...a }) => a),
    partners: settings.partners,
    hashtags_local: st.hashtagsLocal,
    hashtags_global: st.hashtagsGlobal,
    recent_posts_do_not_repeat: recent,
  };
  const slotList = slots.map((s) => ({ slot: s.n, day: s.day, date: s.date, time: fmtTime12(s.time) + " ET", pillar: s.pillarName, audience: s.global ? "global and diaspora listeners (Africa, Europe, Caribbean, US)" : "Cleveland and US listeners" }));
  const system = `You are the social media producer for ${st.name}, a nonprofit online community radio station. You write posts that make people press play. ${AI_RULES}`;
  const user =
    `BRIEF:\n${JSON.stringify(brief, null, 1)}\n\nWrite one post for each slot (week starting ${monday}).\nSLOTS:\n${JSON.stringify(slotList)}\n\n` +
    `Return a JSON array with exactly ${slots.length} objects in slot order: {"slot": number, "short": "max 230 characters, for Bluesky/Threads/Mastodon, at most 1 hashtag", ` +
    `"long": "60-120 words for Facebook/Instagram, end with 3-5 hashtags", "headline": "max 8 words for an image card", "link": "listen" | "donate" | "signup"}. ` +
    `Use "donate" or "signup" only for the Join the breed pillar. Some posts should ask a question to invite comments.`;
  const arr = extractJson(await claude(env, settings, system, user, 12000));
  if (!arr || !arr.length) throw new Error("AI reply was not a list of posts");
  const bySlot = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [Number(x.slot), x]));
  const status = settings.weekly.autoApprove ? "scheduled" : "needs_review";
  const posts = [];
  for (const s of slots) {
    const a = bySlot.get(s.n);
    if (!a || !a.short || !a.long) continue;
    posts.push(makeWeeklyPost(settings, s, String(a.short).trim(), String(a.long).trim(), linkFor(settings, a.link, s), status, a.headline));
  }
  if (posts.length < slots.length * 0.6) throw new Error(`AI only returned ${posts.length} of ${slots.length} posts`);
  return posts;
}

function linkFor(settings, kind, slot) {
  const st = settings.station;
  if (slot.pillar === "cta" && kind === "donate") return st.donateUrl;
  if (slot.pillar === "cta" && kind === "signup") return st.signupUrl || "";
  return st.listenUrl;
}

function makeWeeklyPost(settings, slot, short, long, link, status, headline) {
  const img = pickImage(settings, slot.pillar, slot.n);
  return normalizePost({
    id: newId(),
    kind: "weekly",
    when: slot.when,
    status,
    pillar: slot.pillar,
    global: !!slot.global,
    headline: headline || "",
    short,
    long,
    link: link || "",
    media: img ? { type: "image", urls: [img] } : { type: "none", urls: [] },
    needsImage: !img,
    platforms: settings.weekly.platforms,
    results: {},
    createdAt: Date.now(),
  });
}

function pickImage(settings, type, n) {
  const imgs = settings.images || {};
  const list = (Array.isArray(imgs[type]) && imgs[type].length ? imgs[type] : imgs.default) || [];
  const clean = list.filter((u) => typeof u === "string" && /^https:\/\//.test(u));
  return clean.length ? clean[Math.abs(Math.floor(n)) % clean.length] : "";
}

async function templateWeek(env, settings, slots) {
  const st = settings.station;
  const artists = settings.artists || [];
  const shows = activeShows(settings);
  const partner = (settings.partners || [])[0] || "our neighbors";
  const c = await kvJson(env, "tpl:counters", {});
  const next = (k) => (c[k] = (c[k] || 0) + 1);
  const status = settings.weekly.autoApprove ? "scheduled" : "needs_review";
  const posts = [];
  for (const s of slots) {
    const tags = (s.global ? st.hashtagsGlobal : st.hashtagsLocal).join(" ");
    let short, long, headline, link = st.listenUrl;
    if (s.pillar === "music") {
      if (artists.length && next("music-mode") % 3 !== 0) {
        const a = artists[next("artist") % artists.length];
        const song = a.song ? `"${a.song}"` : "their music";
        const from = a.city ? ` from ${a.city}` : "";
        short = pick(next("music-a"), [
          `Rare Breed spotlight: ${a.name}${from}. Catch ${song} on ${st.name}.`,
          `${a.name} is in rotation on ${st.name}.${a.genre ? ` ${a.genre} the way it should sound.` : ""}`,
          `If you haven't heard ${a.name} yet, today's the day. ${song} is on ${st.name}.`,
          `On our playlist this week: ${a.name}${a.city ? ` (${a.city})` : ""}. Listen for ${song}.`,
          `Artists like ${a.name} are why ${st.name} exists. Hear ${song} on air.`,
        ]);
        headline = `Spotlight: ${a.name}`;
        long = `${short}${a.note ? " " + a.note : ""}\n\nEvery song we play was sent to us by the artist, with permission. That's how we find the rare ones.\n\n${tags}${a.genre ? " #" + a.genre.replace(/[^A-Za-z0-9]/g, "") : ""}`;
      } else {
        short = pick(next("music-g"), [
          `Music you won't hear everywhere else. That's the point. ${st.name}, ${st.slogan}.`,
          `Independent artists, sent straight to us, played with permission. Tune in to ${st.name}.`,
          `Music for a while, then a program or two. That's a day on ${st.name}.`,
          `Looking for something new to love? ${st.name} plays the rare ones.`,
          `Artists: want your music on ${st.name}? Send it our way with permission to play.`,
          `What song should everyone hear this week? Tell us in the comments.`,
        ]);
        headline = "Music for the rare breed";
        long = `${short}\n\nArtists can send their music directly to us. We play songs with the artist's permission, nothing else.\n\n${tags}`;
      }
    } else if (s.pillar === "program") {
      if (shows.length) {
        const sh = shows[next("show") % shows.length];
        const when = `${DAY_PLURAL[sh.day]} at ${fmtTime12(sh.start)} ET`;
        short = pick(next("program"), [`Don't miss ${sh.show}: ${when} on ${st.name}.`, `${sh.show}${sh.description ? ` — ${sh.description}` : ""}. ${when}.`, `Mark your calendar: ${sh.show}, ${when}.`, `Between the music, there's ${sh.show}. Catch it ${when}.`]);
        headline = sh.show;
        long = `${short}\n\n${sh.description ? sh.description + ". " : ""}Call in at ${st.callIn} when we're live.\n\n${tags}`;
      } else {
        short = pick(next("program"), [`${st.name} isn't just music. Between the songs: conversation, culture and community.`, `Programs, podcasts and real talk, right between the music. Tune in to ${st.name}.`, `Got something to say? Our call-in line is ${st.callIn}.`]);
        headline = "Real talk between the music";
        long = `${short}\n\nMusic for a while, then a program or two. That's the ${st.name} way.\n\n${tags}`;
      }
    } else if (s.pillar === "community") {
      short = pick(next("community"), [
        `${st.city}, this is your station. What's happening in your neighborhood? Tell us.`,
        `Community radio means you're part of it. Call ${st.callIn} with your shout-outs and news.`,
        `Thank you to ${partner} for backing community radio in ${st.city}.`,
        `Know a ${st.city} artist, poet or organizer we should hear from? Tell us who.`,
        `Radio made in ${st.city}, heard around the world. That's ${st.name}.`,
      ]);
      headline = `Our ${st.city}`;
      long = `${short}\n\n${st.about}\n\n${tags}`;
    } else if (s.pillar === "behind") {
      short = pick(next("behind"), [`Behind every hour on ${st.name}: volunteers, hosts and a lot of love for the music.`, `Ever wonder how a community station runs? People who care. That's the whole secret.`, `Want to help run a radio station? ${st.name} is always glad to meet volunteers.`]);
      headline = "Behind the mic";
      long = `${short}\n\nReach out through ${st.linkLabel}.\n\n${tags}`;
    } else {
      const donate = next("cta") % 2 === 0 || !st.signupUrl;
      link = donate ? st.donateUrl : st.signupUrl;
      short = donate
        ? pick(next("donate"), [`${st.name} is a nonprofit. Every gift keeps independent voices on the air.`, `If ${st.name} brightens your day, a gift of any size keeps the music playing.`])
        : pick(next("signup"), [`Get the week's shows and new music in your inbox. Join the ${st.name} list.`, `Never miss a show. Join the ${st.name} email list.`]);
      headline = donate ? "Keep the music playing" : "Join the list";
      long = donate ? `${short}\n\nThank you, rare breed.\n\n${tags}` : `${short}\n\nNo spam, just the good stuff.\n\n${tags}`;
    }
    posts.push(makeWeeklyPost(settings, s, short, long, link, status, headline));
  }
  await kvPut(env, "tpl:counters", JSON.stringify(c));
  return posts;
}
function pick(n, arr) {
  return arr[Math.abs(n) % arr.length];
}

// ---------------------------------------------------------------------------
// Community desk: items from the Studio's scout -> scheduled community posts
// ---------------------------------------------------------------------------
async function ingestItems(env, settings, items) {
  let added = 0;
  const srcByName = Object.fromEntries((settings.sources || []).map((s) => [s.name, s]));
  const places = (settings.community.localPlaces || []).filter(Boolean);
  for (const it of items || []) {
    if (!it || !it.url || !it.title) continue;
    const id = await hashId(it.url);
    if (await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(id).first()) continue;
    const text = `${it.title} ${it.summary || ""}`.toLowerCase();
    const blocked = (settings.community.blockWords || []).some((w) => w && new RegExp(`\\b${escapeRe(w.toLowerCase())}\\b`).test(text));
    let score = Number(it.score);
    if (!isFinite(score)) score = 5 + (settings.community.boostWords || []).filter((w) => text.includes(w.toLowerCase())).length;
    if (places.some((pl) => new RegExp(`\\b${escapeRe(pl.toLowerCase())}\\b`).test(text))) score += Number(settings.community.localBoost ?? 2);
    const src = srcByName[it.feed] || srcByName[it.source] || {};
    const status = blocked ? "skipped" : it.submitted ? "review" : "new";
    const data = {
      id,
      url: it.url,
      title: String(it.title).slice(0, 200),
      summary: String(it.summary || "").slice(0, 600),
      source: it.source || "",
      region: it.region || src.region || "Northeast Ohio",
      kind: it.kind === "event" ? "event" : "news",
      eventDate: isValidDate(it.eventDate) ? it.eventDate : "",
      place: String(it.place || "").slice(0, 120),
      short: String(it.short || "").slice(0, 260),
      long: String(it.long || "").slice(0, 1200),
      image: /^https:\/\//.test(it.image || "") ? it.image : "",
      autoPost: it.submitted ? false : src.autoPost !== false,
      submitted: !!it.submitted,
      contact: it.contact || "",
      blocked,
      published: it.published || Date.now(),
    };
    await env.DB.prepare("INSERT INTO items (id, created, status, score, data) VALUES (?, ?, ?, ?, ?)").bind(id, Date.now(), status, Math.min(10, score), JSON.stringify(data)).run();
    added++;
  }
  if (added) await scheduleCommunity(env, settings, Date.now());
  return added;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function getItems(env, sql, ...args) {
  const r = await env.DB.prepare("SELECT status, score, data FROM items " + sql).bind(...args).all();
  return (r.results || []).map((x) => ({ ...JSON.parse(x.data), status: x.status, score: x.score }));
}
async function setItemStatus(env, id, status, extra) {
  const row = await env.DB.prepare("SELECT data FROM items WHERE id = ?").bind(id).first();
  if (!row) return;
  const d = { ...JSON.parse(row.data), ...(extra || {}) };
  await env.DB.prepare("UPDATE items SET status = ?, data = ? WHERE id = ?").bind(status, JSON.stringify(d), id).run();
}

async function communityDaily(env, settings, now) {
  const day = zoneParts(now, settings.station.timezone).date;
  if (await kvGet(env, "comm:" + day)) return 0;
  await kvPut(env, "comm:" + day, "1", 2 * 86400);
  return scheduleCommunity(env, settings, now);
}

async function scheduleCommunity(env, settings, now) {
  const c = settings.community;
  if (!c.enabled) return 0;
  const tz = settings.station.timezone;
  const today = zoneParts(now, tz).date;
  const candidates = (await getItems(env, "WHERE status = 'new' AND created >= ? ORDER BY score DESC, created DESC LIMIT 40", now - (c.maxAgeDays || 10) * 86400000)).filter(
    (it) => it.score >= (c.minScore || 6) && (!it.eventDate || it.eventDate >= today)
  );
  let made = 0;
  for (let d = 0; d < 3 && candidates.length; d++) {
    const date = addDays(today, d);
    for (const time of (c.times || []).filter(isValidTime)) {
      const when = zonedToUtc(date, time, tz);
      if (when < now + 10 * 60000) continue;
      if (await env.DB.prepare("SELECT id FROM posts WHERE kind = 'community' AND when_ms = ?").bind(when).first()) continue;
      const idx = candidates.findIndex((it) => !it.eventDate || it.eventDate >= date);
      if (idx < 0) break;
      const it = candidates.splice(idx, 1)[0];
      const post = communityPost(settings, it, when, it.autoPost && c.autoApprove ? "scheduled" : "needs_review");
      await savePost(env, post);
      await setItemStatus(env, it.id, "scheduled", { postId: post.id });
      made++;
    }
  }
  return made;
}

function communityPost(settings, it, when, status) {
  const st = settings.station;
  const when2 = it.eventDate ? ` ${prettyDate(it.eventDate)}${it.place ? `, ${it.place}` : ""}.` : "";
  const credit = it.source ? ` (via ${it.source})` : "";
  const short = it.short || `${it.title}${when2 ? " —" + when2 : ""}${credit}`;
  const town = (settings.community.localPlaces || []).filter((p) => new RegExp(`\\b${escapeRe(p)}\\b`, "i").test(`${it.title} ${it.summary || ""} ${it.place || ""}`)).sort((a, b) => b.length - a.length)[0];
  const tags = [...(town ? ["#" + town.replace(/[^A-Za-z]/g, "")] : []), ...st.hashtagsLocal].filter((t, i, a) => a.indexOf(t) === i).slice(0, 4);
  const long = it.long || `${it.title}${when2 ? "\n\n📍" + when2 : ""}\n\n${it.summary || ""}\n\n${it.source ? `More details from ${it.source} at the link.` : "More details at the link."}\n\n${tags.join(" ")}`;
  return normalizePost({
    id: newId(),
    kind: "community",
    when,
    status,
    pillar: "community",
    itemId: it.id,
    headline: it.title.slice(0, 80),
    short: short.slice(0, 280),
    long,
    link: it.url,
    linkExternal: true,
    // never repost a source's own photo (their copyright): the Studio makes a branded card instead
    media: { type: "none", urls: [] },
    needsImage: true,
    platforms: settings.community.platforms,
    results: {},
    createdAt: Date.now(),
    source: it.source,
    eventDate: it.eventDate,
    place: it.place,
  });
}

// ---------------------------------------------------------------------------
// Inbox: comments and replies (the community manager)
// ---------------------------------------------------------------------------
const PRAISE = /(thank|thanks|love|lov(e|ing) (this|it)|fire|🔥|❤|❤️|💯|🙏|great|amazing|awesome|beautiful|dope|nice|vibe|vibes|blessed|appreciate)/i;
const RISKY = /(scam|lawsuit|politic|vote|election|racis|sue|refund|complain|terrible|worst|hate|f\*|fuck|shit)/i;

async function inboxHourly(env, settings, now) {
  if (!settings.engage.enabled || budgetLeft() < 15) return 0;
  const hour = Math.floor(now / 3600000);
  if ((await kvGet(env, "inbox:hour")) === String(hour)) return 0;
  await kvPut(env, "inbox:hour", String(hour));
  const found = [];
  for (const [name, fn] of [["facebook", fetchFbComments], ["instagram", fetchIgComments], ["bluesky", fetchBskyMentions]]) {
    if (!PLATFORMS[name].ready(env) || budgetLeft() < 8) continue;
    try {
      found.push(...(await fn(env)));
    } catch (e) {
      await log(env, "error", `Inbox ${name}: ${e.message}`);
    }
  }
  let added = 0;
  const fresh = [];
  for (const c of found) {
    const id = `${c.platform}:${c.id}`;
    if (await env.DB.prepare("SELECT id FROM inbox WHERE id = ?").bind(id).first()) continue;
    c.key = id;
    fresh.push(c);
  }
  if (!fresh.length) return 0;
  // classify and draft replies
  let drafts = {};
  if (env.ANTHROPIC_API_KEY && budgetLeft() > 3) {
    try {
      const st = settings.station;
      const sys = `You manage comments for ${st.name}, a nonprofit community radio station in ${st.city}. Voice: ${st.voice} Facts you may use: ${st.about} Listen at ${st.linkLabel}. Call-in line ${st.callIn}. Reply with JSON only.`;
      const user =
        `For each comment, return {"key", "type": "praise"|"question"|"request"|"complaint"|"spam"|"other", "safe": true only if a short friendly reply is clearly fine to post without a human (praise, thanks, simple questions about how to listen), "reply": "max 220 characters, warm, no hashtags, no links, never invent facts, empty for spam"}.\n` +
        JSON.stringify(fresh.map((c) => ({ key: c.key, platform: c.platform, author: c.author, comment: c.text, on_post: (c.postText || "").slice(0, 200) })));
      const arr = extractJson(await claude(env, settings, sys, user, 3000)) || [];
      for (const d of arr) if (d && d.key) drafts[d.key] = d;
    } catch (e) {
      await log(env, "error", "Inbox AI: " + e.message);
    }
  }
  let autoSent = 0;
  for (const c of fresh) {
    const d = drafts[c.key] || heuristicDraft(settings, c);
    const data = { ...c, type: d.type, reply: d.reply || "", safe: !!d.safe && !RISKY.test(c.text) };
    let status = d.type === "spam" ? "ignored" : "new";
    if (status === "new" && settings.engage.autoReply === "simple" && data.safe && data.reply && autoSent < (settings.engage.maxAutoPerHour || 10) && budgetLeft() > 4) {
      try {
        await sendReply(env, data, data.reply);
        status = "auto-replied";
        autoSent++;
      } catch (e) {
        data.error = e.message;
      }
    }
    await env.DB.prepare("INSERT INTO inbox (id, created, platform, status, data) VALUES (?, ?, ?, ?, ?)").bind(c.key, now, c.platform, status, JSON.stringify(data)).run();
    added++;
  }
  const needYou = fresh.length - autoSent;
  if (needYou > 0) await notify(env, `💬 Resofrik Autopilot: ${needYou} new comment(s) waiting in the Inbox${env.PUBLIC_URL ? " — " + env.PUBLIC_URL + "/#inbox" : ""}`);
  return added;
}

function heuristicDraft(settings, c) {
  const short = c.text.length < 120;
  if (PRAISE.test(c.text) && short && !RISKY.test(c.text) && !c.text.includes("?")) {
    return { type: "praise", safe: true, reply: pick(c.text.length, ["Thank you! 🙏 Glad you're rocking with us.", "Appreciate you! Keep it locked to " + settings.station.name + ".", "Thank you for listening, rare breed! 🙌"]) };
  }
  if (/how (do|can) i (listen|tune)|where (can|do) i (listen|hear)/i.test(c.text)) {
    return { type: "question", safe: true, reply: `You can listen live anytime at ${settings.station.linkLabel}. Thanks for asking!` };
  }
  return { type: c.text.includes("?") ? "question" : "other", safe: false, reply: "" };
}

async function fetchFbComments(env) {
  const url = `${graph(env)}/${env.FB_PAGE_ID}/feed?fields=id,message,comments.limit(25){id,message,from,created_time,comments.limit(10){from}}&limit=8&access_token=${encodeURIComponent(env.FB_PAGE_TOKEN)}`;
  const d = await getJson(url);
  const out = [];
  for (const p of d.data || []) {
    for (const c of (p.comments && p.comments.data) || []) {
      if (!c.from || c.from.id === env.FB_PAGE_ID) continue;
      const replied = ((c.comments && c.comments.data) || []).some((r) => r.from && r.from.id === env.FB_PAGE_ID);
      if (replied) continue;
      out.push({ platform: "facebook", id: c.id, author: c.from.name || "someone", text: c.message || "", postText: p.message || "", at: c.created_time });
    }
  }
  return out;
}
async function fetchIgComments(env) {
  const url = `${graph(env)}/${env.IG_USER_ID}/media?fields=id,caption,username,comments.limit(25){id,text,username,timestamp,replies{username}}&limit=8&access_token=${encodeURIComponent(env.FB_PAGE_TOKEN)}`;
  const d = await getJson(url);
  const out = [];
  for (const m of d.data || []) {
    for (const c of (m.comments && m.comments.data) || []) {
      if (c.username && m.username && c.username === m.username) continue;
      const replied = ((c.replies && c.replies.data) || []).some((r) => m.username && r.username === m.username);
      if (replied) continue;
      out.push({ platform: "instagram", id: c.id, author: c.username || "someone", text: c.text || "", postText: m.caption || "", at: c.timestamp });
    }
  }
  return out;
}
async function fetchBskyMentions(env) {
  const s = await bskySession(env);
  const res = await xfetch(`${s.base}/xrpc/app.bsky.notification.listNotifications?limit=30`, { headers: { authorization: "Bearer " + s.jwt } });
  const d = await readJson(res);
  if (!res.ok) throw new Error(apiError(d, res));
  return (d.notifications || [])
    .filter((n) => (n.reason === "reply" || n.reason === "mention") && n.author && n.author.did !== s.did)
    .map((n) => ({
      platform: "bluesky",
      id: n.cid,
      author: n.author.handle,
      text: (n.record && n.record.text) || "",
      at: n.indexedAt,
      uri: n.uri,
      cid: n.cid,
      root: (n.record && n.record.reply && n.record.reply.root) || { uri: n.uri, cid: n.cid },
    }));
}

async function sendReply(env, c, text) {
  if (c.platform === "facebook") {
    const d = await graphPost(`${graph(env)}/${c.id}/comments`, { message: text, access_token: env.FB_PAGE_TOKEN });
    return d.id;
  }
  if (c.platform === "instagram") {
    const d = await graphPost(`${graph(env)}/${c.id}/replies`, { message: text, access_token: env.FB_PAGE_TOKEN });
    return d.id;
  }
  if (c.platform === "bluesky") {
    const s = await bskySession(env);
    const record = { $type: "app.bsky.feed.post", text: fit(text, 300), createdAt: new Date().toISOString(), reply: { root: c.root, parent: { uri: c.uri, cid: c.cid } } };
    const res = await xfetch(s.base + "/xrpc/com.atproto.repo.createRecord", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.jwt }, body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record }) });
    const d = await readJson(res);
    if (!res.ok) throw new Error(apiError(d, res));
    return d.uri;
  }
  throw new Error("replies not supported on " + c.platform);
}

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------
async function buildStats(env, days) {
  const since = Date.now() - days * 86400000;
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const clicks = (await env.DB.prepare("SELECT platform, SUM(n) AS n FROM clicks WHERE day >= ? GROUP BY platform ORDER BY n DESC").bind(sinceDay).all()).results || [];
  const top = (await env.DB.prepare("SELECT post_id, SUM(n) AS n FROM clicks WHERE day >= ? GROUP BY post_id ORDER BY n DESC LIMIT 5").bind(sinceDay).all()).results || [];
  const topPosts = [];
  for (const t of top) {
    const p = t.post_id === "links" ? { short: "Link-in-bio page" } : await getPost(env, t.post_id);
    topPosts.push({ n: t.n, text: p ? (p.short || p.long || "").slice(0, 90) : t.post_id, id: t.post_id });
  }
  const published = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE when_ms >= ? AND status IN ('published','partial')").bind(since).first()).n;
  const subs = (await env.DB.prepare("SELECT COUNT(*) AS n FROM subs WHERE created >= ?").bind(since).first()).n;
  const subsTotal = (await env.DB.prepare("SELECT COUNT(*) AS n FROM subs").first()).n;
  const replies = (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE created >= ? AND status IN ('auto-replied','replied')").bind(since).first()).n;
  const comments = (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE created >= ?").bind(since).first()).n;
  const totalClicks = clicks.reduce((a, c) => a + (c.n || 0), 0);
  return { days, clicks, totalClicks, topPosts, published, subs, subsTotal, replies, comments };
}

async function weeklyReport(env, settings, now) {
  if (!settings.report.enabled) return;
  const tz = settings.station.timezone;
  const p = zoneParts(now, tz);
  if (DOW[p.dow] !== settings.report.day || p.time < settings.report.time) return;
  const key = "report:" + p.date;
  if (await kvGet(env, key)) return;
  await kvPut(env, key, "1", 8 * 86400);
  const s = await buildStats(env, 7);
  const lines = [
    `📊 Resofrik FM — last 7 days`,
    `Posts published: ${s.published}`,
    `Link clicks: ${s.totalClicks}` + (s.clicks.length ? ` (${s.clicks.map((c) => `${c.platform} ${c.n}`).join(", ")})` : ""),
    `New email sign-ups: ${s.subs} (total ${s.subsTotal})`,
    `Comments: ${s.comments}, answered: ${s.replies}`,
    s.topPosts.length ? `Top post: "${s.topPosts[0].text}" (${s.topPosts[0].n} clicks)` : "",
  ].filter(Boolean);
  await kvPut(env, "report:last", JSON.stringify({ at: now, text: lines.join("\n") }));
  await log(env, "ok", "Weekly report sent.");
  await notify(env, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------
const PLATFORMS = {
  bluesky: {
    label: "Bluesky",
    takes: ["none", "image", "images", "video"],
    ready: (env) => !!(env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD),
    publish: publishBluesky,
    resume: resumeBluesky,
    test: testBluesky,
    help: "BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (Bluesky → Settings → Privacy and security → App passwords).",
  },
  facebook: {
    label: "Facebook Page",
    takes: ["none", "image", "images", "video"],
    ready: (env) => !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN),
    publish: publishFacebook,
    test: testFacebook,
    help: "FB_PAGE_ID and FB_PAGE_TOKEN (long-lived Page token; for replies add pages_read_user_content and pages_manage_engagement).",
  },
  instagram: {
    label: "Instagram",
    takes: ["image", "images", "video"],
    ready: (env) => !!(env.IG_USER_ID && env.FB_PAGE_TOKEN),
    publish: publishInstagram,
    resume: resumeMetaContainer("instagram"),
    test: testInstagram,
    help: "IG_USER_ID (professional account linked to the Page). Uses FB_PAGE_TOKEN with instagram_content_publish (and instagram_manage_comments for replies).",
  },
  threads: {
    label: "Threads",
    takes: ["none", "image", "images", "video"],
    ready: (env) => !!env.THREADS_TOKEN,
    publish: publishThreads,
    resume: resumeMetaContainer("threads"),
    test: testThreads,
    help: "THREADS_TOKEN (long-lived; renewed weekly by the robot). THREADS_USER_ID is optional.",
  },
  mastodon: {
    label: "Mastodon",
    takes: ["none", "image", "images", "video"],
    ready: (env) => !!(env.MASTODON_URL && env.MASTODON_TOKEN),
    publish: publishMastodon,
    resume: resumeMastodon,
    test: testMastodon,
    help: "MASTODON_URL (e.g. https://mastodon.social) and MASTODON_TOKEN (write:statuses, write:media).",
  },
  telegram: {
    label: "Telegram channel",
    takes: ["none", "image", "images", "video"],
    ready: (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID),
    publish: publishTelegram,
    test: testTelegram,
    help: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID (e.g. @resofrikfm); add the bot as channel admin.",
  },
};

async function publishPost(env, settings, post) {
  normalizePost(post);
  const results = post.results;
  let attempted = false;
  let deferred = false;
  for (const p of post.platforms || []) {
    const r = results[p];
    if (r && (r.ok || r.skipped)) continue;
    const def = PLATFORMS[p];
    if (!def || !def.ready(env)) {
      results[p] = { ok: false, error: "not connected" };
      continue;
    }
    if (!def.takes.includes(post.media.type)) {
      results[p] = { ok: false, skipped: true, error: post.media.type === "none" ? "needs a picture or video" : `doesn't take ${post.media.type}` };
      continue;
    }
    if (budgetLeft() < 12) {
      deferred = true;
      break;
    }
    try {
      const view = post.variants && post.variants[p] ? { ...post, short: post.variants[p], long: post.variants[p] } : post;
      const out = r && r.pending ? await def.resume(env, settings, view, p, r.state) : await def.publish(env, settings, view, p);
      if (out && out.pending) {
        const since = (r && r.since) || Date.now();
        if (Date.now() - since > 2 * 3600 * 1000) throw new Error("the platform took too long to process the media");
        results[p] = { pending: true, state: out.state, since };
      } else {
        results[p] = { ok: true, id: String((out && out.id) || out || ""), at: Date.now() };
      }
      if (!(r && r.pending)) attempted = true;
    } catch (e) {
      results[p] = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
      attempted = true;
    }
  }
  if (attempted) post.attempts = (post.attempts || 0) + 1;
  const vals = Object.values(results);
  const tried = vals.filter((r) => !r.skipped && r.error !== "not connected");
  const okN = tried.filter((r) => r.ok).length;
  if (deferred) post.status = "publishing";
  else if (tried.some((r) => r.pending)) post.status = "processing";
  else post.status = tried.length === 0 ? "nowhere" : okN === tried.length ? "published" : okN > 0 ? "partial" : "failed";
  return post;
}

function withUtm(url, platform, campaign, settings) {
  try {
    const u = new URL(url);
    const site = new URL(settings.station.website);
    if (u.hostname.replace(/^www\./, "") !== site.hostname.replace(/^www\./, "")) return url;
    u.searchParams.set("utm_source", platform);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", campaign || "autopilot");
    return u.toString();
  } catch {
    return url;
  }
}
function postLink(env, settings, post, platform) {
  const target = post.link || settings.station.listenUrl;
  if (!target) return "";
  if (env.PUBLIC_URL) return `${env.PUBLIC_URL.replace(/\/$/, "")}/go/${post.id}/${platform}`;
  return post.linkExternal ? target : withUtm(target, platform, post.kind, settings);
}
function linkLabelFor(settings, post) {
  if (post.linkExternal) {
    try {
      return new URL(post.link).hostname.replace(/^www\./, "");
    } catch {}
  }
  return settings.station.linkLabel;
}
function graphemes(s) {
  try {
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;
  } catch {
    return [...s].length;
  }
}
function fit(text, max) {
  if (graphemes(text) <= max) return text;
  let out = [...text].slice(0, Math.max(0, max - 1)).join("");
  while (graphemes(out) > max - 1) out = [...out].slice(0, -1).join("");
  return out.replace(/\s+\S*$/, "") + "…";
}
function shortText(post) {
  return post.short || (post.long || "").split("\n")[0];
}
async function readJson(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t.slice(0, 200) };
  }
}
function apiError(data, res) {
  if (data && data.error) return typeof data.error === "string" ? data.error + (data.message ? ": " + data.message : "") : data.error.error_user_msg || data.error.message || JSON.stringify(data.error);
  if (data && data.message) return data.message;
  if (data && data.description) return data.description;
  return `HTTP ${res.status}`;
}
async function getJson(url, headers) {
  const res = await xfetch(url, { headers });
  const d = await readJson(res);
  if (!res.ok || d.error) throw new Error(apiError(d, res));
  return d;
}
async function graphPost(url, params) {
  const res = await xfetch(url, { method: "POST", body: new URLSearchParams(params) });
  const d = await readJson(res);
  if (!res.ok || d.error) throw new Error(apiError(d, res));
  return d;
}
async function fetchBytes(url, max) {
  try {
    const u = new URL(url);
    const own = MEDIA_ENV && MEDIA_ENV.MEDIA && u.pathname.startsWith("/m/") && (u.hostname.endsWith(".workers.dev") || (MEDIA_ENV.PUBLIC_URL && new URL(MEDIA_ENV.PUBLIC_URL).hostname === u.hostname));
    if (own) {
      const obj = await MEDIA_ENV.MEDIA.get(decodeURIComponent(u.pathname.slice(3)));
      if (obj) {
        const buf = await obj.arrayBuffer();
        if (max && buf.byteLength > max) throw new Error(`media too large (${Math.round(buf.byteLength / 1e6)} MB)`);
        return { buf, type: (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream" };
      }
    }
  } catch (e) {
    if (/too large/.test(String(e && e.message))) throw e;
  }
  const res = await xfetch(url);
  if (!res.ok) throw new Error(`couldn't load media (${res.status})`);
  const buf = await res.arrayBuffer();
  if (max && buf.byteLength > max) throw new Error(`media too large (${Math.round(buf.byteLength / 1e6)} MB)`);
  return { buf, type: res.headers.get("content-type") || "application/octet-stream" };
}

// --- Bluesky -----------------------------------------------------------------
async function bskySession(env) {
  const base = env.BLUESKY_SERVICE || "https://bsky.social";
  const res = await xfetch(base + "/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: String(env.BLUESKY_HANDLE || "").trim().replace(/^@/, ""), password: String(env.BLUESKY_APP_PASSWORD || "").replace(/\s+/g, "") }) });
  const d = await readJson(res);
  if (!res.ok) throw new Error("login: " + apiError(d, res));
  let pds = base;
  try {
    const svc = (d.didDoc && d.didDoc.service) || [];
    const s = svc.find((x) => x.id === "#atproto_pds") || svc[0];
    if (s && s.serviceEndpoint) pds = s.serviceEndpoint;
  } catch {}
  return { base, pds, jwt: d.accessJwt, did: d.did };
}
function bskyText(settings, post, env, p) {
  const url = postLink(env, settings, post, p);
  const label = linkLabelFor(settings, post);
  const tail = url ? "\n\n" + label : "";
  const body = fit(shortText(post), 300 - graphemes(tail));
  const text = body + tail;
  const facets = [];
  if (url) {
    const enc = new TextEncoder();
    const byteStart = enc.encode(body + "\n\n").length;
    facets.push({ index: { byteStart, byteEnd: byteStart + enc.encode(label).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: url }] });
  }
  return { text, facets };
}
async function bskyCreate(env, s, record) {
  const res = await xfetch(s.base + "/xrpc/com.atproto.repo.createRecord", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.jwt }, body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record }) });
  const d = await readJson(res);
  if (!res.ok) throw new Error(apiError(d, res));
  return d.uri;
}
async function publishBluesky(env, settings, post, p) {
  const s = await bskySession(env);
  const { text, facets } = bskyText(settings, post, env, p);
  const record = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"], facets };
  const alt = post.headline || `${settings.station.name} — ${settings.station.slogan}`;
  if (post.media.type === "image" || post.media.type === "images") {
    const images = [];
    for (const u of post.media.urls.slice(0, 4)) {
      try {
        const { buf, type } = await fetchBytes(u, 990000);
        const up = await xfetch(s.base + "/xrpc/com.atproto.repo.uploadBlob", { method: "POST", headers: { authorization: "Bearer " + s.jwt, "content-type": type }, body: buf });
        const upd = await readJson(up);
        if (up.ok && upd.blob) images.push({ alt, image: upd.blob });
      } catch {}
    }
    if (images.length) record.embed = { $type: "app.bsky.embed.images", images };
  }
  if (post.media.type === "video") {
    const { buf } = await fetchBytes(post.media.urls[0], 95 * 1e6);
    const pdsHost = new URL(s.pds).host;
    const auth = await getJson(`${s.base}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent("did:web:" + pdsHost)}&lxm=com.atproto.repo.uploadBlob&exp=${Math.floor(Date.now() / 1000) + 1800}`, { authorization: "Bearer " + s.jwt });
    const up = await xfetch(`https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(s.did)}&name=${post.id}.mp4`, { method: "POST", headers: { authorization: "Bearer " + auth.token, "content-type": "video/mp4" }, body: buf });
    const job = await readJson(up);
    const jobId = job.jobId || (job.jobStatus && job.jobStatus.jobId);
    if (!jobId) throw new Error("video upload: " + apiError(job, up));
    return { pending: true, state: { jobId, text, facets } };
  }
  return { id: await bskyCreate(env, s, record) };
}
async function resumeBluesky(env, settings, post, p, state) {
  const st = await getJson(`https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(state.jobId)}`);
  const js = st.jobStatus || st;
  if (js.state === "JOB_STATE_FAILED") throw new Error("Bluesky video processing failed: " + (js.error || js.message || ""));
  if (!js.blob) return { pending: true, state };
  const s = await bskySession(env);
  const record = { $type: "app.bsky.feed.post", text: state.text, createdAt: new Date().toISOString(), langs: ["en"], facets: state.facets, embed: { $type: "app.bsky.embed.video", video: js.blob, aspectRatio: { width: 9, height: 16 } } };
  return { id: await bskyCreate(env, s, record) };
}
async function testBluesky(env) {
  const s = await bskySession(env);
  return `Signed in as ${env.BLUESKY_HANDLE}`;
}

// --- Meta: Facebook, Instagram, Threads -------------------------------------------
function graph(env) {
  return "https://graph.facebook.com/" + (env.GRAPH_VERSION || "v25.0");
}
async function publishFacebook(env, settings, post, p) {
  const url = postLink(env, settings, post, p);
  const message = (post.long || shortText(post)) + (url ? "\n\n" + url : "");
  const g = graph(env);
  const tok = env.FB_PAGE_TOKEN;
  const t = post.media.type;
  if (t === "video") {
    const d = await graphPost(`${g}/${env.FB_PAGE_ID}/videos`, { file_url: post.media.urls[0], description: message, title: (post.headline || "").slice(0, 90), access_token: tok });
    return { id: d.id };
  }
  if (t === "image") {
    const d = await graphPost(`${g}/${env.FB_PAGE_ID}/photos`, { url: post.media.urls[0], caption: message, access_token: tok });
    return { id: d.post_id || d.id };
  }
  if (t === "images") {
    const params = { message, access_token: tok };
    let i = 0;
    for (const u of post.media.urls.slice(0, 10)) {
      const ph = await graphPost(`${g}/${env.FB_PAGE_ID}/photos`, { url: u, published: "false", access_token: tok });
      params[`attached_media[${i++}]`] = JSON.stringify({ media_fbid: ph.id });
    }
    const d = await graphPost(`${g}/${env.FB_PAGE_ID}/feed`, params);
    return { id: d.id };
  }
  const params = { message, access_token: tok };
  if (url) params.link = url;
  const d = await graphPost(`${g}/${env.FB_PAGE_ID}/feed`, params);
  return { id: d.id };
}
async function testFacebook(env) {
  const d = await getJson(`${graph(env)}/${env.FB_PAGE_ID}?fields=name&access_token=${encodeURIComponent(env.FB_PAGE_TOKEN)}`);
  return "Connected to Page: " + d.name;
}
function igCaption(settings, post) {
  const linkLine = post.kind === "community" || (post.linkExternal && post.source)
    ? `Full story${post.source ? ` from ${post.source}` : ""}: tap the link in our bio, then "In the news".`
    : `Listen live: tap the link in our bio (${settings.station.linkLabel}).`;
  const body = (post.long || shortText(post)).replace(/\n*More details[^\n]*at the link\.[ \t]*/g, ""); // Instagram captions can't hold a working link
  return fit(body + "\n\n" + linkLine, 2200);
}
async function publishInstagram(env, settings, post) {
  const g = graph(env);
  const tok = env.FB_PAGE_TOKEN;
  const caption = igCaption(settings, post);
  const t = post.media.type;
  let id;
  if (t === "video") {
    id = (await graphPost(`${g}/${env.IG_USER_ID}/media`, { media_type: "REELS", video_url: post.media.urls[0], caption, share_to_feed: "true", access_token: tok })).id;
  } else if (t === "images" && post.media.urls.length > 1) {
    const kids = [];
    for (const u of post.media.urls.slice(0, 10)) kids.push((await graphPost(`${g}/${env.IG_USER_ID}/media`, { image_url: u, is_carousel_item: "true", access_token: tok })).id);
    id = (await graphPost(`${g}/${env.IG_USER_ID}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption, access_token: tok })).id;
  } else {
    id = (await graphPost(`${g}/${env.IG_USER_ID}/media`, { image_url: post.media.urls[0], caption, access_token: tok })).id;
  }
  const state = { id };
  if (t === "video") return { pending: true, state };
  return resumeMetaContainer("instagram")(env, settings, post, "instagram", state);
}
async function testInstagram(env) {
  const d = await getJson(`${graph(env)}/${env.IG_USER_ID}?fields=username&access_token=${encodeURIComponent(env.FB_PAGE_TOKEN)}`);
  return "Connected to Instagram: @" + d.username;
}
function threadsKey(env) {
  return "threads:token:" + String(env.THREADS_TOKEN || "").replace(/\s+/g, "").slice(-24);
}
async function threadsToken(env) {
  return (await kvGet(env, threadsKey(env))) || String(env.THREADS_TOKEN || "").replace(/\s+/g, "");
}
async function refreshThreadsToken(env) {
  if (!env.THREADS_TOKEN) return;
  const d = await getJson(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(await threadsToken(env))}`);
  if (!d.access_token) throw new Error("no token returned");
  await kvPut(env, threadsKey(env), d.access_token);
}
async function publishThreads(env, settings, post, p) {
  const token = await threadsToken(env);
  const url = postLink(env, settings, post, p);
  const tail = url ? "\n\n" + url : "";
  const text = fit(shortText(post), 480 - graphemes(tail)) + tail;
  const base = `https://graph.threads.net/v1.0/${env.THREADS_USER_ID || "me"}`;
  const t = post.media.type;
  let id;
  if (t === "none") {
    id = (await graphPost(`${base}/threads`, { media_type: "TEXT", text, access_token: token })).id;
    return { id: (await graphPost(`${base}/threads_publish`, { creation_id: id, access_token: token })).id };
  }
  if (t === "images" && post.media.urls.length > 1) {
    const kids = [];
    for (const u of post.media.urls.slice(0, 10)) kids.push((await graphPost(`${base}/threads`, { media_type: "IMAGE", image_url: u, is_carousel_item: "true", access_token: token })).id);
    id = (await graphPost(`${base}/threads`, { media_type: "CAROUSEL", children: kids.join(","), text, access_token: token })).id;
  } else if (t === "video") {
    id = (await graphPost(`${base}/threads`, { media_type: "VIDEO", video_url: post.media.urls[0], text, access_token: token })).id;
  } else {
    id = (await graphPost(`${base}/threads`, { media_type: "IMAGE", image_url: post.media.urls[0], text, access_token: token })).id;
  }
  return { pending: true, state: { id } }; // Meta asks for a short wait before publishing media
}
function resumeMetaContainer(platform) {
  return async (env, settings, post, p, state) => {
    if (platform === "instagram") {
      const tok = env.FB_PAGE_TOKEN;
      const st = await getJson(`${graph(env)}/${state.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`);
      if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("Instagram couldn't process the media");
      if (st.status_code !== "FINISHED") return { pending: true, state };
      return { id: (await graphPost(`${graph(env)}/${env.IG_USER_ID}/media_publish`, { creation_id: state.id, access_token: tok })).id };
    }
    const token = await threadsToken(env);
    const st = await getJson(`https://graph.threads.net/v1.0/${state.id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    if (st.status === "ERROR" || st.status === "EXPIRED") throw new Error("Threads couldn't process the media: " + (st.error_message || ""));
    if (st.status && st.status !== "FINISHED") return { pending: true, state };
    return { id: (await graphPost(`https://graph.threads.net/v1.0/${env.THREADS_USER_ID || "me"}/threads_publish`, { creation_id: state.id, access_token: token })).id };
  };
}
async function testThreads(env) {
  const d = await getJson(`https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(await threadsToken(env))}`);
  return "Connected to Threads: @" + d.username;
}

// --- Mastodon ----------------------------------------------------------------
async function mastoUpload(env, url, alt) {
  const { buf, type } = await fetchBytes(url, 99 * 1e6);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), type.includes("video") ? "clip.mp4" : "image.jpg");
  if (alt) fd.append("description", alt.slice(0, 1400));
  const res = await xfetch(env.MASTODON_URL.replace(/\/$/, "") + "/api/v2/media", { method: "POST", headers: { authorization: "Bearer " + env.MASTODON_TOKEN }, body: fd });
  const d = await readJson(res);
  if (!res.ok) throw new Error(apiError(d, res));
  return { id: d.id, ready: res.status === 200 && !!d.url };
}
async function mastoStatus(env, status, mediaIds) {
  const params = new URLSearchParams({ status, visibility: "public" });
  for (const id of mediaIds || []) params.append("media_ids[]", id);
  const res = await xfetch(env.MASTODON_URL.replace(/\/$/, "") + "/api/v1/statuses", { method: "POST", headers: { authorization: "Bearer " + env.MASTODON_TOKEN, "content-type": "application/x-www-form-urlencoded" }, body: params });
  const d = await readJson(res);
  if (!res.ok) throw new Error(apiError(d, res));
  return d.id;
}
async function publishMastodon(env, settings, post, p) {
  const url = postLink(env, settings, post, p);
  const status = fit(shortText(post), 440) + (url ? "\n\n" + url : "");
  const t = post.media.type;
  if (t === "none") return { id: await mastoStatus(env, status) };
  const ids = [];
  let allReady = true;
  for (const u of t === "video" ? post.media.urls.slice(0, 1) : post.media.urls.slice(0, 4)) {
    const m = await mastoUpload(env, u, post.headline || settings.station.name);
    ids.push(m.id);
    if (!m.ready) allReady = false;
  }
  if (!allReady) return { pending: true, state: { status, ids } };
  return { id: await mastoStatus(env, status, ids) };
}
async function resumeMastodon(env, settings, post, p, state) {
  for (const id of state.ids) {
    const d = await getJson(env.MASTODON_URL.replace(/\/$/, "") + "/api/v1/media/" + id, { authorization: "Bearer " + env.MASTODON_TOKEN });
    if (!d.url) return { pending: true, state };
  }
  return { id: await mastoStatus(env, state.status, state.ids) };
}
async function testMastodon(env) {
  const d = await getJson(env.MASTODON_URL.replace(/\/$/, "") + "/api/v1/accounts/verify_credentials", { authorization: "Bearer " + env.MASTODON_TOKEN });
  return "Connected to Mastodon: @" + d.acct;
}

// --- Telegram ----------------------------------------------------------------
async function tg(env, method, payload) {
  const res = await xfetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const d = await readJson(res);
  if (!res.ok || !d.ok) throw new Error(apiError(d, res));
  return d.result;
}
async function publishTelegram(env, settings, post, p) {
  const url = postLink(env, settings, post, p);
  const chat = env.TELEGRAM_CHANNEL_ID;
  const body = post.long || shortText(post);
  const caption = fit(body, 1000 - (url ? url.length + 2 : 0)) + (url ? "\n\n" + url : "");
  const t = post.media.type;
  if (t === "video") {
    try {
      return { id: (await tg(env, "sendVideo", { chat_id: chat, video: post.media.urls[0], caption, supports_streaming: true })).message_id };
    } catch (e) {
      return { id: (await tg(env, "sendMessage", { chat_id: chat, text: caption + "\n\n▶️ " + post.media.urls[0] })).message_id };
    }
  }
  if (t === "images" && post.media.urls.length > 1) {
    const media = post.media.urls.slice(0, 10).map((u, i) => ({ type: "photo", media: u, ...(i === 0 ? { caption } : {}) }));
    const r = await tg(env, "sendMediaGroup", { chat_id: chat, media });
    return { id: r[0] && r[0].message_id };
  }
  if (t === "image" || t === "images") return { id: (await tg(env, "sendPhoto", { chat_id: chat, photo: post.media.urls[0], caption })).message_id };
  return { id: (await tg(env, "sendMessage", { chat_id: chat, text: body + (url ? "\n\n" + url : "") })).message_id };
}
async function testTelegram(env) {
  const me = await tg(env, "getMe", {});
  return `Bot @${me.username} is ready (posting to ${env.TELEGRAM_CHANNEL_ID})`;
}

// --- Private alerts ------------------------------------------------------------
async function notify(env, text) {
  try {
    if (env.NOTIFY_DISCORD_WEBHOOK) await xfetch(env.NOTIFY_DISCORD_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
    if (env.TELEGRAM_BOT_TOKEN && env.NOTIFY_TELEGRAM_CHAT_ID) await tg(env, "sendMessage", { chat_id: env.NOTIFY_TELEGRAM_CHAT_ID, text: text.slice(0, 4000) });
  } catch {}
}

// ---------------------------------------------------------------------------
// Studio API (for the GitHub Actions Studio). Bearer STUDIO_TOKEN.
// ---------------------------------------------------------------------------
function origin(env, request) {
  return (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, "");
}
function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
}

async function handleStudio(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const want = String(env.STUDIO_TOKEN || "").trim();
  if (!want || auth.replace(/^Bearer\s+/i, "").trim() !== want) return json({ error: "unauthorized" }, 401);
  const settings = await loadSettings(env);
  const tz = settings.station.timezone;
  const path = url.pathname.replace("/api/studio/", "");
  const now = Date.now();

  if (path === "tasks" && request.method === "GET") {
    const cards = (await queryPosts(env, "WHERE when_ms >= ? AND when_ms <= ? AND status IN ('scheduled','needs_review','approved') ORDER BY when_ms LIMIT 60", now, now + 9 * 86400000)).filter((p) => p.needsImage && p.media.type === "none");
    const jobs = (await env.DB.prepare("SELECT id, type, data FROM jobs WHERE status = 'queued' ORDER BY created LIMIT 5").all()).results.map((j) => ({ id: j.id, type: j.type, ...JSON.parse(j.data) }));
    const weeklyReq = await kvJson(env, "studio:weekly", null);
    const weeklyDone = weeklyReq ? await kvGet(env, "carousels:" + weeklyReq.monday) : "x";
    const showcards = await kvJson(env, "showcards", {});
    const promoted = await kvJson(env, "promoted", {});
    const monday = weeklyReq ? weeklyReq.monday : thisMonday(now, tz);
    const weekStart = zonedToUtc(monday, "00:00", tz);
    const boardItems = (await getItems(env, "WHERE status IN ('new','scheduled','posted') AND created >= ? ORDER BY score DESC LIMIT 12", now - 10 * 86400000)).filter((i) => !i.eventDate || i.eventDate >= zoneParts(now, tz).date);
    return json({
      now,
      publicUrl: origin(env, request),
      settings: { station: settings.station, studio: settings.studio, pillars: settings.pillars, artists: settings.artists, schedule: activeShows(settings), sources: settings.sources, community: settings.community, ai: settings.ai },
      cards: cards.map((p) => ({ id: p.id, kind: p.kind, pillar: p.pillar, headline: p.headline, short: p.short, source: p.source || "", eventDate: p.eventDate || "", place: p.place || "", when: p.when })),
      jobs,
      weekly: weeklyReq && !weeklyDone ? { monday, weekStart, board: boardItems.slice(0, 6) } : null,
      showCardsNeeded: activeShows(settings).filter((s) => !showcards[slug(s.show)]).map((s) => ({ show: s.show, slug: slug(s.show), day: s.day, start: s.start, description: s.description })),
      artistPromos: (settings.artists || []).filter((a) => a.name && a.audio && /^https?:\/\//.test(a.audio) && !promoted[slug(a.name)]).slice(0, 2),
      seenFeedEntries: await kvJson(env, "feeds:seen", []),
      stories: settings.studio.stories && settings.studio.stories.enabled === false ? null : await storyPlan(env, settings, now),
      photos: (await listPhotos(env)).map(({ url, tag, about, credit }) => ({ url, tag, about, credit })),
      music: (await listMusic(env)).map(({ genre, url }) => ({ genre, url })),
      // every story video gets a cover picture for the website (older ones are filled in once)
      storyPosters: (await queryPosts(env, "WHERE kind = 'story' AND status IN ('published','partial','scheduled','approved') ORDER BY when_ms DESC LIMIT 60"))
        .filter((p) => p.media && p.media.type === "video" && p.media.urls[0] && !(p.story && p.story.poster))
        .slice(0, 12)
        .map((p) => ({ postId: p.id, video: p.media.urls[0] })),
      transcribe: (await loadEpisodes(env)).filter((e) => e.video && !e.transcript).slice(0, 6).map((e) => ({ id: episodeId(e), video: e.video, poet: e.poet, title: e.title })),
      nowPlayingCards: settings.nowPlaying.enabled ? await (async () => { const cards = await kvJson(env, "np:cards", {}); return (await kvJson(env, "np:seen", [])).filter((x) => !cards[x.track]).slice(-12); })() : [],
    });
  }
  if (path === "upload" && request.method === "POST") {
    if (!env.MEDIA) return json({ error: "no R2 bucket bound as MEDIA" }, 500);
    const name = (url.searchParams.get("name") || newId()).replace(/[^a-zA-Z0-9._-]/g, "-");
    const type = url.searchParams.get("type") || request.headers.get("content-type") || "application/octet-stream";
    const key = `${new Date(Date.now()).toISOString().slice(0, 10)}/${newId()}-${name}`;
    const size = Number(request.headers.get("content-length") || 0);
    if (size > 95 * 1e6) return json({ error: "file too large (max 95 MB)" }, 413);
    await env.MEDIA.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: type } });
    return json({ key, url: `${origin(env, request)}/m/${key}` });
  }
  const body = await request.json().catch(() => ({}));
  if (path === "items") return json({ added: await ingestItems(env, settings, body.items || []) });
  if (path === "scout-report") {
    await kvPut(env, "scout:report", JSON.stringify({ at: now, ...body }));
    if (Array.isArray(body.seenFeedEntries)) await kvPut(env, "feeds:seen", JSON.stringify(body.seenFeedEntries.slice(-300)));
    return json({ ok: true });
  }
  if (path === "jobs" && request.method === "POST") {
    const id = body.id || (await hashId(body.url || newId()));
    if (await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first()) return json({ id, exists: true });
    await env.DB.prepare("INSERT INTO jobs (id, created, status, type, data) VALUES (?, ?, 'queued', ?, ?)").bind(id, now, body.type || "clip", JSON.stringify({ url: body.url, title: body.title || "", source: body.source || "", count: body.count || settings.studio.clipsPerVideo })).run();
    return json({ id });
  }
  if (path === "job-done") {
    await env.DB.prepare("UPDATE jobs SET status = ?, data = json_set(data, '$.result', ?) WHERE id = ?").bind(body.ok === false ? "failed" : "done", JSON.stringify(body.result || body.summary || body.error || ""), body.id).run();
    await log(env, body.ok === false ? "error" : "ok", `Studio job ${body.ok === false ? "failed" : "finished"}: ${body.summary || body.error || body.id}`);
    return json({ ok: true });
  }
  if (path === "attach") {
    const post = await getPost(env, body.postId);
    if (!post) return json({ error: "no such post" }, 404);
    post.media = { type: body.type || "image", urls: body.urls || [] };
    post.needsImage = false;
    await savePost(env, post);
    return json({ ok: true });
  }
  if (path === "episode-transcript") {
    const eps = await loadEpisodes(env);
    const e = eps.find((x) => episodeId(x) === body.id);
    if (e) {
      e.transcript = String(body.text || "").slice(0, 20000) || "(no words found)";
      await saveEpisodes(env, eps);
    }
    return json({ ok: !!e });
  }
  if (path === "story-poster") {
    const post = await getPost(env, body.postId);
    if (!post || post.kind !== "story" || !/^https:\/\//.test(body.url || "")) return json({ error: "bad request" }, 400);
    post.story = { ...(post.story || {}), poster: body.url };
    await savePost(env, post);
    return json({ ok: true });
  }
  if (path === "npcard") {
    const cards = await kvJson(env, "np:cards", {});
    if (body.track && /^https:\/\//.test(body.url || "")) cards[body.track] = body.url;
    await kvPut(env, "np:cards", JSON.stringify(cards));
    return json({ ok: true });
  }
  if (path === "showcard") {
    const cards = await kvJson(env, "showcards", {});
    cards[body.slug] = body.url;
    await kvPut(env, "showcards", JSON.stringify(cards));
    return json({ ok: true });
  }
  if (path === "story-used") {
    const used = await kvJson(env, "stories:used", []);
    if (body.id && !used.includes(body.id)) used.push(body.id);
    await kvPut(env, "stories:used", JSON.stringify(used));
    return json({ ok: true });
  }
  if (path === "stories-left") {
    await kvPut(env, "stories:left", JSON.stringify({ left: Number(body.left) || 0, total: Number(body.total) || 0, at: now }));
    return json({ ok: true });
  }
  if (path === "promoted") {
    const pr = await kvJson(env, "promoted", {});
    pr[body.slug] = now;
    await kvPut(env, "promoted", JSON.stringify(pr));
    return json({ ok: true });
  }
  if (path === "carousels-done") {
    await kvPut(env, "carousels:" + body.monday, "1", 30 * 86400);
    return json({ ok: true });
  }
  if (path === "post") {
    // a finished piece from the Studio: clip, carousel, slideshow video, promo
    let when = now + 5 * 60000;
    if (body.whenLocal && isValidDate(body.whenLocal.date) && isValidTime(body.whenLocal.time)) when = zonedToUtc(body.whenLocal.date, body.whenLocal.time, tz);
    else if (body.schedule === "auto") when = await nextFreeSlot(env, settings, settings.studio.clipTimes, now, body.kind || "clip");
    const isVideo = body.media && body.media.type === "video";
    const post = normalizePost({
      id: newId(),
      kind: body.kind || "clip",
      when,
      status: body.review ? "needs_review" : "scheduled",
      pillar: body.pillar || "program",
      headline: body.headline || "",
      short: String(body.short || "").slice(0, 300),
      long: String(body.long || body.short || ""),
      link: body.link || settings.station.listenUrl,
      linkExternal: !!body.linkExternal,
      media: body.media || { type: "none", urls: [] },
      platforms: body.platforms || (isVideo ? settings.studio.videoPlatforms : settings.weekly.platforms),
      results: {},
      createdAt: now,
      jobId: body.jobId || "",
      variants: body.variants && typeof body.variants === "object" ? body.variants : undefined,
      story: body.story && typeof body.story === "object" ? body.story : undefined,
      download: isVideo ? body.media.urls[0] : "",
    });
    await savePost(env, post);
    return json({ id: post.id, when, whenLocal: fmtLocal(when, tz) });
  }
  return json({ error: "unknown" }, 404);
}

async function listMusic(env, request) {
  if (!env.MEDIA || typeof env.MEDIA.list !== "function") return [];
  const out = [];
  let cursor;
  do {
    const r = await env.MEDIA.list({ prefix: "music/", cursor, limit: 500 });
    for (const o of r.objects) {
      const parts = o.key.split("/");
      out.push({ key: o.key, genre: parts[1] || "other", name: parts.slice(2).join("/").replace(/^[a-z0-9]{8,12}-/, ""), url: `${env.PUBLIC_URL || ""}/m/${o.key}`, size: o.size });
    }
    cursor = r.truncated ? r.cursor : null;
  } while (cursor);
  return out;
}
const PHOTO_TAGS = { station: "Station & studio", shows: "Shows & hosts", community: "Events & community", artists: "Artists", behind: "Behind the scenes" };
async function listPhotos(env, prefix = "photos/") {
  if (!env.MEDIA || typeof env.MEDIA.list !== "function") return [];
  const out = [];
  let cursor;
  do {
    const r = await env.MEDIA.list({ prefix, cursor, limit: 500, include: ["customMetadata"] });
    for (const o of r.objects) {
      const parts = o.key.split("/");
      const meta = o.customMetadata || {};
      out.push({ key: o.key, tag: prefix === "photos/" ? parts[1] || "station" : "artists", url: `${env.PUBLIC_URL || ""}/m/${o.key}`, about: meta.about || "", credit: meta.credit || "", email: meta.email || "", instagram: meta.instagram || "", size: o.size });
    }
    cursor = r.truncated ? r.cursor : null;
  } while (cursor);
  return out;
}
function cleanName(n, fallback) {
  return String(n || fallback).replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80);
}
function isImageFile(f) {
  return f && typeof f !== "string" && f.size && (/^image\/(jpeg|png|webp)$/.test(f.type || "") || /\.(jpe?g|png|webp)$/i.test(f.name || ""));
}
function sendPhotosPage(settings, msg) {
  const st = settings.station;
  return page(
    `Send your photos · ${st.name}`,
    `<main class="links"><section class="hero">${st.logoUrl ? `<img src="${esc(st.logoUrl)}" alt="${esc(st.name)} logo" class="logo">` : ""}<h1>Send us your photos</h1><p class="tag">For artists we play on ${esc(st.name)}</p></section>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<section><p class="small">Send up to 5 photos of yourself or your band (JPG or PNG, up to 15 MB each). We'll use them to feature you on our website and social media when your music is in rotation. Please only send photos you own or have the photographer's permission to share.</p>
<form method="post" action="/send-photos" enctype="multipart/form-data">
<input name="artist" placeholder="Artist or band name" required maxlength="80">
<input name="credit" placeholder="Photo credit (photographer's name, optional)" maxlength="80">
<input name="instagram" placeholder="Instagram handle (optional)" maxlength="60">
<input type="email" name="email" placeholder="Your email" required maxlength="120">
<input type="file" name="file" accept="image/jpeg,image/png,image/webp" multiple required>
<input name="website" style="display:none" tabindex="-1" autocomplete="off" aria-hidden="true">
<label class="small" style="display:flex;gap:8px;align-items:flex-start;margin:10px 0"><input type="checkbox" name="consent" value="yes" required style="width:auto;margin-top:3px"> I own these photos or have the photographer's permission, and I allow ${esc(st.name)} to use them to promote my music on its website and social media.</label>
<button>Send photos</button></form></section>
<p class="small center"><a href="${esc(st.website)}">${esc(st.linkLabel)}</a></p></main>`,
    st.brandColor,
    LINKS_CSS
  );
}

// ---- Original series episodes (videos hosted in our own storage) ----
const SERIES_TITLE = { "cleveland-poetry-in-black-and-white": "Cleveland Poetry in Black and White", "cleveland-music-in-black-and-white": "Cleveland Music in Black and White" };
const SERIES_CODES = { cpbw: "cleveland-poetry-in-black-and-white", cmbw: "cleveland-music-in-black-and-white" };
function parseEpisodeName(name) {
  // cpbw-s1-e01--Poet name--Poem title.mp4  (or .jpg for its picture)
  const m = String(name || "").match(/^([a-z]+)-s(\d{1,2})-e(\d{1,3})--(.*?)--(.+)\.(mp4|m4v|mov|jpe?g|png|webp)$/i);
  if (!m || !SERIES_CODES[m[1].toLowerCase()]) return null;
  return { series: SERIES_CODES[m[1].toLowerCase()], season: +m[2], episode: +m[3], poet: m[4].trim(), title: m[5].trim(), kind: /^(mp4|m4v|mov)$/i.test(m[6]) ? "video" : "poster" };
}
async function loadEpisodes(env) {
  return kvJson(env, "originals:eps", []);
}
async function saveEpisodes(env, eps) {
  eps.sort((a, b) => a.series.localeCompare(b.series) || b.season - a.season || a.episode - b.episode);
  await kvPut(env, "originals:eps", JSON.stringify(eps));
}
function episodeId(e) {
  return `${e.series}-s${e.season}e${e.episode}`;
}

async function storyPlan(env, settings, now) {
  const cfg = settings.studio.stories || {};
  const tz = settings.station.timezone;
  const ups = await queryPosts(env, "WHERE kind = 'story' AND when_ms >= ? AND status IN ('scheduled','approved','needs_review','processing','publishing')", now - 86400000);
  return {
    days: cfg.days || ["Tue", "Fri"],
    time: cfg.time || "19:30",
    today: zoneParts(now, tz).date,
    takenDates: ups.map((p) => zoneParts(p.when, tz).date),
    used: await kvJson(env, "stories:used", []),
    music: (await listMusic(env)).map((m) => ({ genre: m.genre, url: m.url })),
    platforms: settings.studio.videoPlatforms,
  };
}

async function nextFreeSlot(env, settings, times, now, kind) {
  const tz = settings.station.timezone;
  const today = zoneParts(now, tz).date;
  const valid = (times || []).filter(isValidTime).sort();
  for (let d = 0; d < 30; d++) {
    const date = addDays(today, d);
    for (const t of valid) {
      const when = zonedToUtc(date, t, tz);
      if (when < now + 30 * 60000) continue;
      if (await env.DB.prepare("SELECT id FROM posts WHERE kind IN ('clip','promo','slideshow','carousel','story') AND when_ms = ?").bind(when).first()) continue;
      return when;
    }
  }
  return now + 3600000;
}

// ---------------------------------------------------------------------------
// Public endpoints: media, click tracking, website feeds, link-in-bio, forms
// ---------------------------------------------------------------------------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };

async function serveMedia(request, env, key) {
  if (!env.MEDIA) return new Response("no media store", { status: 404 });
  const range = request.headers.get("range");
  let opts = {};
  let m = range && range.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const offset = Number(m[1]);
    opts.range = m[2] ? { offset, length: Number(m[2]) - offset + 1 } : { offset };
  }
  const obj = await env.MEDIA.get(key, opts);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers({ "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream", "cache-control": "public, max-age=31536000", "accept-ranges": "bytes", ...CORS });
  if (m && obj.range) {
    const start = obj.range.offset || 0;
    const len = obj.range.length != null ? obj.range.length : obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function countClick(env, postId, platform) {
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO clicks (day, post_id, platform, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, post_id, platform) DO UPDATE SET n = n + 1").bind(day, postId.slice(0, 40), platform.slice(0, 20)).run();
}

async function handleGo(env, settings, postId, platform) {
  const post = postId === "links" ? null : await getPost(env, postId);
  let target = post ? post.link || settings.station.listenUrl : settings.station.listenUrl;
  if (postId === "links") target = settings.station.listenUrl;
  await countClick(env, postId, platform || "web");
  const dest = post && post.linkExternal ? target : withUtm(target, platform || "web", post ? post.kind : "links", settings);
  return Response.redirect(dest, 302);
}

async function publicEvents(env, settings) {
  const tz = settings.station.timezone;
  const today = zoneParts(Date.now(), tz).date;
  const items = (await getItems(env, "WHERE status IN ('new','scheduled','posted') AND created >= ? ORDER BY created DESC LIMIT 80", Date.now() - 21 * 86400000)).filter((i) => !i.eventDate || i.eventDate >= today);
  const events = items.filter((i) => i.eventDate).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const news = items.filter((i) => !i.eventDate).sort((a, b) => b.score - a.score);
  return [...events, ...news].slice(0, 15).map((i) => ({
    title: i.title,
    date: i.eventDate ? prettyDate(i.eventDate) : prettyDate(zoneParts(i.published || Date.now(), tz).date),
    place: i.place || i.source || "",
    area: i.region === "Global" ? "Global" : "Northeast Ohio",
    where: i.region === "Global" ? "Global" : "Northeast Ohio",
    description: i.summary || i.short || "",
    desc: i.summary || i.short || "",
    link: i.url,
    source: i.source,
    auto: true,
  }));
}

async function publicMedia(env, settings) {
  const posts = await queryPosts(env, "WHERE status IN ('published','partial') AND kind IN ('clip','promo','slideshow','carousel') ORDER BY when_ms DESC LIMIT 12");
  return posts.map((p) => ({ title: p.headline || shortText(p).slice(0, 80), type: p.media.type, urls: p.media.urls, when: p.when, text: shortText(p) }));
}

async function publicStories(env, settings) {
  // Rare Breed Stories that have already gone out on social media, newest first
  const posts = await queryPosts(env, "WHERE status IN ('published','partial') AND kind = 'story' ORDER BY when_ms DESC LIMIT 24");
  return posts.map((p) => {
    const s = p.story || {};
    return {
      id: s.id || p.id,
      artist: s.artist || p.headline || "",
      genre: s.genre || "",
      hook: s.hook || "",
      beats: Array.isArray(s.beats) ? s.beats : [],
      payoff: s.payoff || "",
      question: s.question || "",
      source: s.source || null,
      video: p.media && p.media.type === "video" ? p.media.urls[0] : "",
      poster: /^https:\/\//.test(s.poster || "") ? s.poster : "",
      text: s.hook ? "" : String(p.long || p.short || ""),
      when: p.when,
      date: prettyDate(zoneParts(p.when, settings.station.timezone).date),
    };
  });
}

function publicArtists(settings) {
  // artists in rotation (sent with permission); one is featured each week
  const list = (settings.artists || []).filter((a) => a && a.name).map((a) => ({ name: a.name, from: a.from || a.country || a.city || "", genre: a.genre || a.sound || "", song: a.song || "", bio: a.bio || a.blurb || "", image: a.image || "", link: a.link || a.url || (a.instagram ? "https://www.instagram.com/" + String(a.instagram).replace(/^@/, "") + "/" : "") }));
  const week = Math.floor(Date.now() / (7 * 86400000));
  return { featured: list.length ? list[week % list.length] : null, artists: list };
}

function linksPage(env, settings, board, media, msg, news = []) {
  const st = settings.station;
  const go = (id) => `/go/links/${id}`;
  return page(
    st.name,
    `<main class="links"><section class="hero">${st.logoUrl ? `<img src="${esc(st.logoUrl)}" alt="${esc(st.name)} logo" class="logo">` : ""}<h1>${esc(st.name)}</h1><p class="tag">${esc(st.slogan)}</p></section>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<a class="big" href="${go("listen")}">▶ Listen live</a>
${news.length ? `<section id="news"><h2>In the news</h2><p class="small">The full stories behind our posts, newest first.</p>${news.map((n) => `<a class="ev" href="/go/${esc(n.id)}/bio" rel="noopener"><b>${esc(n.headline || shortText(n))}</b><span>${n.source ? "via " + esc(n.source) + " · " : ""}${esc(new Date(n.when).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: settings.station.timezone }))}</span></a>`).join("")}</section>` : ""}
${st.donateUrl ? `<a class="big alt" href="${esc(st.donateUrl)}" onclick="navigator.sendBeacon && navigator.sendBeacon('/api/public/click/links/donate')">♥ Support the station</a>` : ""}
<section><h2>Join the list</h2><p class="small">New shows, new music and community news. No spam.</p>
<form method="post" action="/api/public/subscribe"><input type="email" name="email" placeholder="you@email.com" required aria-label="Email"><input type="text" name="name" placeholder="First name (optional)" aria-label="First name"><input type="hidden" name="source" value="links"><button>Sign me up</button></form></section>
${media.length ? `<section><h2>Latest clips</h2><div class="clips">${media.slice(0, 4).map((m) => (m.type === "video" ? `<video src="${esc(m.urls[0])}" controls preload="none" playsinline></video>` : `<img src="${esc(m.urls[0])}" alt="${esc(m.title)}">`)).join("")}</div></section>` : ""}
${board.length ? `<section><h2>Around ${esc(st.city)}</h2>${board.slice(0, 5).map((e) => `<a class="ev" href="${esc(e.link)}" rel="noopener"><b>${esc(e.title)}</b><span>${esc(e.date)}${e.place ? " · " + esc(e.place) : ""}</span></a>`).join("")}</section>` : ""}
<section><h2>Share your event</h2><p class="small">Nonprofits, schools, faith and community groups: tell us what's happening and we may share it on air and online.</p>
<form method="post" action="/api/public/announce"><input name="org" placeholder="Organization" required><input name="title" placeholder="What's happening" required><input type="date" name="date" aria-label="Date"><input name="place" placeholder="Where"><textarea name="msg" placeholder="Tell us about it (60 words or fewer)" maxlength="420" required></textarea><input type="email" name="email" placeholder="Contact email" required><input name="link" placeholder="Link for details (optional)"><button>Send</button></form></section>
<p class="small center">Call in: ${esc(st.callIn)} · <a href="${esc(st.website)}">${esc(st.linkLabel)}</a></p></main>`,
    st.brandColor,
    LINKS_CSS
  );
}

async function handlePublic(request, env, url) {
  const settings = await loadSettings(env);
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const p = url.pathname;
  if (p === "/api/public/events") return json(await publicEvents(env, settings), 200, { ...CORS, "cache-control": "public, max-age=600" });
  if (p === "/api/public/media") return json(await publicMedia(env, settings), 200, { ...CORS, "cache-control": "public, max-age=600" });
  if (p === "/api/public/stories") return json(await publicStories(env, settings), 200, { ...CORS, "cache-control": "public, max-age=600" });
  if (p === "/api/public/photos") return json((await listPhotos(env)).filter((x) => x.tag === "station" || x.tag === "shows").map(({ url, tag, about }) => ({ url, tag, about })), 200, { ...CORS, "cache-control": "public, max-age=900" });
  if (p === "/api/public/originals") return json((await loadEpisodes(env)).filter((e) => e.video && !e.hidden).map(({ transcript, hidden, ...e }) => e), 200, { ...CORS, "cache-control": "public, max-age=300" });
  if (p === "/api/public/artists") return json(publicArtists(settings), 200, { ...CORS, "cache-control": "public, max-age=600" });
  if (p === "/api/public/live") return json(await publicLive(env, settings), 200, { ...CORS, "cache-control": "public, max-age=15" });
  if (p.startsWith("/api/public/click/")) {
    const [, , , , postId, platform] = p.split("/");
    await countClick(env, postId || "links", platform || "web");
    return new Response(null, { status: 204, headers: CORS });
  }
  if (p === "/api/public/subscribe" && request.method === "POST") {
    const f = await request.formData();
    const email = String(f.get("email") || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return redirect("/links?msg=" + encodeURIComponent("That email doesn't look right."));
    await env.DB.prepare("INSERT OR IGNORE INTO subs (email, created, source, name) VALUES (?, ?, ?, ?)").bind(email, Date.now(), String(f.get("source") || "web").slice(0, 30), String(f.get("name") || "").slice(0, 60)).run();
    const back = f.get("back");
    return redirect(back && /^https:\/\//.test(back) ? back : "/links?msg=" + encodeURIComponent("You're on the list. Welcome to the rare breed!"));
  }
  if (p === "/api/public/announce" && request.method === "POST") {
    const f = await request.formData();
    const title = String(f.get("title") || f.get("org") || "").trim();
    const msg = String(f.get("msg") || "").trim();
    if (!title || !msg || String(f.get("website") || "")) return redirect("/links?msg=" + encodeURIComponent("Please fill in the form."));
    const link = /^https?:\/\//.test(String(f.get("link") || "")) ? String(f.get("link")) : `${settings.station.website}#community-${newId()}`;
    await ingestItems(env, settings, [{
      url: link,
      title: `${title}${f.get("org") && f.get("org") !== title ? " — " + f.get("org") : ""}`,
      summary: msg.slice(0, 420),
      source: String(f.get("org") || "Community submission").slice(0, 80),
      region: "Northeast Ohio",
      kind: f.get("date") ? "event" : "news",
      eventDate: String(f.get("date") || ""),
      place: String(f.get("place") || ""),
      submitted: true,
      contact: String(f.get("email") || "").slice(0, 120),
      score: 7,
    }]);
    await notify(env, `📮 New community announcement waiting for your OK: ${title}`);
    return redirect("/links?msg=" + encodeURIComponent("Thank you! We'll review it and share it if it's a fit."));
  }
  return json({ error: "not found" }, 404, CORS);
}

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------
async function sessionToken(env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_PASSWORD || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("resofrik-autopilot-session"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}
function redirect(to, extra = {}) {
  return new Response(null, { status: 303, headers: { location: to, ...extra } });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function handleHttp(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (p === "/health") return json({ ok: true, version: VERSION, lastTick: Number((await kvGet(env, "status:lastTick")) || 0) || null });
  if (p.startsWith("/m/photos-pending/") && env.ADMIN_PASSWORD && getCookie(request, "rp") !== (await sessionToken(env))) return new Response("not found", { status: 404 });
  if (p.startsWith("/m/")) return serveMedia(request, env, decodeURIComponent(p.slice(3)));
  if (p.startsWith("/go/")) {
    const [, , postId, platform] = p.split("/");
    return handleGo(env, await loadSettings(env), postId || "links", platform || "web");
  }
  if (p.startsWith("/api/studio/")) return handleStudio(request, env, url);
  if (p.startsWith("/api/public/")) return handlePublic(request, env, url);
  if (p === "/send-photos") {
    const settings = await loadSettings(env);
    if (request.method !== "POST") return html(sendPhotosPage(settings, url.searchParams.get("msg")));
    const form = await request.formData();
    const artist = String(form.get("artist") || "").trim().slice(0, 80);
    const email = String(form.get("email") || "").trim().slice(0, 120);
    const files = form.getAll("file").filter(isImageFile).slice(0, 5);
    if (String(form.get("website") || "")) return redirect("/send-photos?msg=" + encodeURIComponent("Thank you!"));
    if (!artist || !email || form.get("consent") !== "yes" || !files.length) return redirect("/send-photos?msg=" + encodeURIComponent("Please fill in your name and email, tick the permission box, and choose at least one JPG or PNG photo."));
    if (!env.MEDIA) return redirect("/send-photos?msg=" + encodeURIComponent("Uploads aren't open yet. Please email your photos to us instead."));
    let n = 0;
    for (const f of files) {
      if (f.size > 15 * 1e6) continue;
      await env.MEDIA.put(`photos-pending/${newId()}-${cleanName(f.name, "photo.jpg")}`, f, {
        httpMetadata: { contentType: f.type || "image/jpeg" },
        customMetadata: { about: artist, credit: String(form.get("credit") || "").trim().slice(0, 80), email, instagram: String(form.get("instagram") || "").trim().replace(/^@/, "").slice(0, 60), consent: new Date().toISOString() },
      });
      n++;
    }
    if (n) await notify(env, `📸 ${artist} sent ${n} photo${n === 1 ? "" : "s"}. Approve them in the control panel → Photo library.`);
    return redirect("/send-photos?msg=" + encodeURIComponent(n ? `Thank you, ${artist}! We received ${n} photo${n === 1 ? "" : "s"} and will review them shortly.` : "Those files were too large (15 MB each at most)."));
  }
  if (p === "/links") {
    const settings = await loadSettings(env);
    const news = await queryPosts(env, "WHERE kind = 'community' AND status IN ('published','partial') ORDER BY when_ms DESC LIMIT 10");
    return html(linksPage(env, settings, await publicEvents(env, settings), await publicMedia(env, settings), url.searchParams.get("msg"), news));
  }
  if (!env.ADMIN_PASSWORD) return html(page("Setup needed", `<main><section><p>Add a secret named <b>ADMIN_PASSWORD</b> to this Worker, then reload.</p></section></main>`));
  if (p === "/login" && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("password") || "").trim() === String(env.ADMIN_PASSWORD).trim()) return redirect("/", { "set-cookie": `rp=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
    return html(loginPage("Wrong password. Try again."), 401);
  }
  if (p === "/logout") return redirect("/", { "set-cookie": "rp=; Path=/; Max-Age=0" });
  if (getCookie(request, "rp") !== (await sessionToken(env))) return html(loginPage(""));
  if (p === "/export/subscribers.csv") {
    const rows = (await env.DB.prepare("SELECT email, name, source, created FROM subs ORDER BY created").all()).results || [];
    const csv = "email,name,source,joined\n" + rows.map((r) => [r.email, r.name || "", r.source || "", new Date(r.created).toISOString().slice(0, 10)].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=resofrik-subscribers.csv" } });
  }
  if (request.method === "POST" && p === "/upload-episode") {
    const name = decodeURIComponent(url.searchParams.get("name") || "");
    const info = parseEpisodeName(name);
    if (!info) return json({ error: "Name the file like cpbw-s1-e01--Poet--Title.mp4" }, 400);
    if (!env.MEDIA) return json({ error: "no media storage" }, 500);
    const ext = name.split(".").pop().toLowerCase();
    const key = `originals/${info.series}/s${info.season}e${String(info.episode).padStart(2, "0")}-${info.kind}.${ext}`;
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") || (info.kind === "video" ? "video/mp4" : "image/jpeg") } });
    const eps = await loadEpisodes(env);
    let e = eps.find((x) => episodeId(x) === episodeId(info));
    if (!e) eps.push((e = { series: info.series, season: info.season, episode: info.episode, poet: info.poet, title: info.title, description: "", video: "", poster: "", transcript: "" }));
    if (!e.poet && info.poet !== "Poet") e.poet = info.poet;
    if (!e.title) e.title = info.title;
    e[info.kind] = `${origin(env, request)}/m/${key}`;
    await saveEpisodes(env, eps);
    return json({ ok: true, id: episodeId(e), kind: info.kind });
  }
  if (p === "/admin/episodes.json") return json(await loadEpisodes(env));
  if (request.method === "POST" && p === "/action") return handleAction(request, env);
  return html(await dashboard(env, url, request));
}

async function dispatchStudio(env) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return false;
  const res = await xfetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/studio.yml/dispatches`, {
    method: "POST",
    headers: { authorization: "Bearer " + env.GH_DISPATCH_TOKEN, accept: "application/vnd.github+json", "user-agent": "resofrik-autopilot", "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GH_BRANCH || "main", inputs: { task: "all" } }),
  });
  return res.status === 204;
}

async function handleAction(request, env) {
  const form = await request.formData();
  const act = form.get("do");
  const settings = await loadSettings(env);
  const tz = settings.station.timezone;
  const anchor = form.get("anchor");
  const back = (msg) => redirect("/?msg=" + encodeURIComponent(msg) + (anchor ? "#" + anchor : ""));

  if (act === "pause" || act === "resume") {
    settings.paused = act === "pause";
    await saveSettings(env, settings);
    return back(settings.paused ? "Autopilot paused. Nothing will post until you resume." : "Autopilot is running.");
  }
  if (act === "generate") {
    const r = await weeklyJob(env, { force: true });
    return back(r.count ? `Wrote ${r.count} posts for the week of ${r.monday} (${r.source}). The Studio will add pictures and carousels on its next run.` : "Nothing written: " + (r.skipped || "unknown"));
  }
  if (act === "tick") {
    const r = await tick(env);
    return back(r.paused ? "Autopilot is paused." : `Ran now: ${r.published} published, ${r.reminders} reminders, ${r.community} community posts scheduled, ${r.inbox} new comments.`);
  }
  if (act === "restyle") {
    // redo pictures in the current look: upcoming cards and community photos are re-made, this week's carousels rebuilt
    const ups = await queryPosts(env, "WHERE when_ms >= ? AND status IN ('scheduled','needs_review','approved') ORDER BY when_ms LIMIT 200", Date.now());
    let cards = 0, removed = 0;
    for (const p of ups) {
      const urls = p.media.urls || [];
      if (p.kind === "carousel" || p.kind === "slideshow") {
        await deletePost(env, p.id);
        removed++;
      } else if ((p.media.type === "image" && urls.length && urls.every((u) => /-card-/.test(u))) || (p.kind === "community" && p.media.type !== "video")) {
        p.media = { type: "none", urls: [] };
        p.needsImage = true;
        await savePost(env, p);
        cards++;
      }
    }
    const wk = await kvJson(env, "studio:weekly", null);
    if (wk) await kvDel(env, "carousels:" + wk.monday);
    await kvDel(env, "showcards");
    const started = await dispatchStudio(env);
    return back(`${cards} pictures and ${removed} carousels will be re-made in the current look. ` + (started ? "Studio started." : "Run the Studio (GitHub → Actions → Studio) to make them."));
  }
  if (act === "studio_now") {
    return back((await dispatchStudio(env)) ? "Studio started. New pictures, clips and carousels appear here in 5–30 minutes." : "Couldn't start the Studio from here. Add GH_DISPATCH_TOKEN and GH_REPO, or run it from GitHub → Actions → Studio → Run workflow.");
  }
  if (act === "save_settings") {
    let parsed;
    try {
      parsed = JSON.parse(form.get("settings"));
    } catch (e) {
      return back("Settings not saved — there is a typo in the text (" + e.message + "). Your old settings are unchanged.");
    }
    await saveSettings(env, mergeDefaults(structuredClone(DEFAULT_SETTINGS), parsed));
    return back("Settings saved.");
  }
  if (act === "reset_settings") {
    await kvDel(env, "settings");
    return back("Settings reset to the starting defaults.");
  }
  if (act === "test") {
    const p = PLATFORMS[form.get("platform")];
    if (!p) return back("Unknown platform.");
    if (!p.ready(env)) return back(`${p.label} is not connected yet. ${p.help}`);
    try {
      return back("✅ " + (await p.test(env)));
    } catch (e) {
      return back(`❌ ${p.label}: ${e.message}`);
    }
  }
  if (act === "music_upload") {
    if (!env.MEDIA) return back("Media storage (R2) isn't connected yet.");
    const genre = ["reggae", "soul", "african", "afrobeats", "hiphop", "jazz"].includes(String(form.get("genre"))) ? String(form.get("genre")) : "other";
    const files = form.getAll("file").filter((f) => f && typeof f !== "string" && f.size);
    if (!files.length) return back("Choose one or more audio files first.");
    for (const f of files.slice(0, 20)) {
      if (f.size > 40 * 1e6) continue;
      const key = `music/${genre}/${newId()}-${String(f.name || "track.mp3").replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      await env.MEDIA.put(key, f, { httpMetadata: { contentType: f.type || "audio/mpeg" } });
    }
    return back(`Added ${files.length} track${files.length === 1 ? "" : "s"} to ${genre}.`);
  }
  if (act === "photo_upload") {
    if (!env.MEDIA) return back("Media storage (R2) isn't connected yet.");
    const tag = PHOTO_TAGS[String(form.get("tag"))] ? String(form.get("tag")) : "station";
    const files = form.getAll("file").filter(isImageFile);
    if (!files.length) return back("Choose one or more JPG, PNG or WebP photos first.");
    const about = String(form.get("about") || "").trim().slice(0, 120), credit = String(form.get("credit") || "").trim().slice(0, 80);
    let n = 0;
    for (const f of files.slice(0, 60)) {
      if (f.size > 25 * 1e6) continue;
      // files prepared as "<section>--<who or what>--01.jpg" sort themselves
      const m = String(f.name || "").match(/^(station|shows|community|artists|behind)--(.{1,120}?)--\d+\.(jpe?g|png|webp)$/i);
      const t = m ? m[1].toLowerCase() : tag;
      await env.MEDIA.put(`photos/${t}/${newId()}-${cleanName(f.name, "photo.jpg")}`, f, { httpMetadata: { contentType: f.type || "image/jpeg" }, customMetadata: { about: m ? m[2].trim() : about, credit } });
      n++;
    }
    return back(`Added ${n} photo${n === 1 ? "" : "s"} to the library.${n < files.length ? " Some were skipped (over 25 MB, or more than 60 at once)." : ""}`);
  }
  if (act === "photo_delete" || act === "photo_reject") {
    const key = String(form.get("key") || "");
    if (!/^photos(-pending)?\//.test(key)) return back("Unknown photo.");
    await env.MEDIA.delete(key);
    const s = await loadSettings(env);
    const owner = (s.artists || []).find((x) => x.image && x.image.endsWith("/m/" + key));
    if (owner) {
      owner.image = "";
      await saveSettings(env, s);
    }
    return back(act === "photo_reject" ? "Photo declined and removed." : "Photo removed from the library.");
  }
  if (act === "photo_move") {
    // re-file a library photo under another section and/or description
    const key = String(form.get("key") || "");
    const tag = String(form.get("tag") || "");
    if (!/^photos\/[a-z]+\//.test(key) || !PHOTO_TAGS[tag] || !env.MEDIA) return back("Unknown photo.");
    const obj = await env.MEDIA.get(key);
    if (!obj) return back("That photo is gone already.");
    const meta = { ...(obj.customMetadata || {}) };
    if (form.get("about") != null) meta.about = String(form.get("about")).trim().slice(0, 120);
    const newKey = `photos/${tag}/${key.split("/").slice(2).join("/")}`;
    if (newKey !== key) {
      await env.MEDIA.put(newKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: meta });
      await env.MEDIA.delete(key);
    } else {
      await env.MEDIA.put(key, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: meta });
    }
    return back(`Photo moved to ${PHOTO_TAGS[tag]}.`);
  }
  if (act === "episode_edit") {
    const eps = await loadEpisodes(env);
    const e = eps.find((x) => episodeId(x) === String(form.get("id")));
    if (!e) return back("Unknown episode.");
    for (const k of ["poet", "title", "description"]) if (form.get(k) != null) e[k] = String(form.get(k)).trim().slice(0, k === "description" ? 600 : 120);
    if (form.get("hidden") != null) e.hidden = form.get("hidden") === "yes";
    await saveEpisodes(env, eps);
    return back(`Saved ${e.poet ? e.poet + " — " : ""}${e.title}.`);
  }
  if (act === "photo_approve") {
    const key = String(form.get("key") || "");
    if (!key.startsWith("photos-pending/") || !env.MEDIA) return back("Unknown photo.");
    const obj = await env.MEDIA.get(key);
    if (!obj) return back("That photo is gone already.");
    const meta = obj.customMetadata || {};
    const newKey = "photos/artists/" + key.slice("photos-pending/".length);
    await env.MEDIA.put(newKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: meta });
    await env.MEDIA.delete(key);
    // first approved photo of an artist in rotation becomes their picture
    const s = await loadSettings(env);
    const a = (s.artists || []).find((x) => x.name && meta.about && x.name.toLowerCase() === meta.about.toLowerCase());
    if (a && !a.image) {
      a.image = `${origin(env, request)}/m/${newKey}`;
      if (!a.instagram && meta.instagram) a.instagram = meta.instagram;
      await saveSettings(env, s);
    }
    return back(`Approved. It's in the Photo library under Artists${a && a.image.endsWith(newKey) ? ` and is now ${a.name}'s picture` : ""}.`);
  }
  if (act === "clip_url" || act === "clip_upload") {
    let src = String(form.get("url") || "").trim();
    if (act === "clip_upload") {
      const file = form.get("file");
      if (!file || typeof file === "string" || !file.size) return back("Choose a video or audio file first.");
      if (!env.MEDIA) return back("Media storage (R2) isn't connected yet.");
      const key = `inbox/${newId()}-${String(file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      await env.MEDIA.put(key, file, { httpMetadata: { contentType: file.type || "video/mp4" } });
      src = `${origin(env, request)}/m/${key}`;
    }
    if (!/^https?:\/\//.test(src)) return back("Paste a link to a video or audio file (or a YouTube link).");
    const id = await hashId(src + Date.now());
    await env.DB.prepare("INSERT INTO jobs (id, created, status, type, data) VALUES (?, ?, 'queued', 'clip', ?)").bind(id, Date.now(), JSON.stringify({ url: src, title: String(form.get("title") || ""), count: Math.min(8, Math.max(1, Number(form.get("count")) || settings.studio.clipsPerVideo)) })).run();
    const started = await dispatchStudio(env);
    return back(`Got it. The Studio will cut shorts from it ${started ? "now" : "on its next run"} and schedule them.`);
  }
  if (act === "item_post" || act === "item_skip" || act === "item_approve") {
    const id = form.get("item");
    const it = (await getItems(env, "WHERE id = ?", id))[0];
    if (!it) return back("That item is gone.");
    if (act === "item_skip") {
      await setItemStatus(env, id, "skipped");
      return back("Skipped.");
    }
    if (act === "item_approve") {
      await setItemStatus(env, id, "new");
      await scheduleCommunity(env, settings, Date.now());
      return back("Approved. It's on the community board and will be posted in the next open slot.");
    }
    const post = communityPost(settings, it, Date.now() + 60000, "scheduled");
    await savePost(env, post);
    await setItemStatus(env, id, "scheduled", { postId: post.id });
    return back("Scheduled to post on the next check (within 15 minutes).");
  }
  if (act === "reply" || act === "ignore") {
    const id = form.get("inbox");
    const row = await env.DB.prepare("SELECT data FROM inbox WHERE id = ?").bind(id).first();
    if (!row) return back("That comment is gone.");
    const c = JSON.parse(row.data);
    if (act === "ignore") {
      await env.DB.prepare("UPDATE inbox SET status = 'ignored' WHERE id = ?").bind(id).run();
      return back("Marked as handled.");
    }
    const text = String(form.get("reply") || "").trim();
    if (!text) return back("Write a reply first.");
    try {
      await sendReply(env, c, text);
      c.reply = text;
      await env.DB.prepare("UPDATE inbox SET status = 'replied', data = ? WHERE id = ?").bind(JSON.stringify(c), id).run();
      return back("Reply posted.");
    } catch (e) {
      return back("Couldn't post the reply: " + e.message);
    }
  }
  if (act === "new_post") {
    const date = form.get("date");
    const time = form.get("time");
    const long = String(form.get("long") || "").trim();
    if (!long) return back("Write something first.");
    const when = isValidDate(date) && isValidTime(time) ? zonedToUtc(date, time, tz) : Date.now();
    const urls = String(form.get("media") || "").split(/\s+/).filter((u) => /^https:\/\//.test(u));
    const type = urls.length === 0 ? "none" : /\.(mp4|mov|m4v)(\?|$)/i.test(urls[0]) ? "video" : urls.length > 1 ? "images" : "image";
    const platforms = form.getAll("platforms");
    await savePost(env, normalizePost({ id: newId(), kind: "manual", when, status: "scheduled", pillar: "manual", short: String(form.get("short") || "").trim(), long, link: String(form.get("link") || "").trim() || settings.station.listenUrl, media: { type, urls }, platforms: platforms.length ? platforms : settings.weekly.platforms, results: {}, createdAt: Date.now() }));
    return back(`Post scheduled for ${fmtLocal(when, tz)}.`);
  }

  const post = await getPost(env, form.get("id"));
  if (!post) return back("That post no longer exists.");
  if (act === "skip") post.status = "skipped";
  else if (act === "restore" || act === "approve") post.status = "scheduled";
  else if (act === "delete") {
    await deletePost(env, post.id);
    return back("Deleted.");
  } else if (act === "save") {
    post.short = String(form.get("short") || "").trim();
    post.long = String(form.get("long") || "").trim();
    const urls = String(form.get("media") || "").split(/\s+/).filter((u) => /^https:\/\//.test(u));
    if (urls.join(" ") !== post.media.urls.join(" ")) post.media = { type: urls.length === 0 ? "none" : /\.(mp4|mov|m4v)(\?|$)/i.test(urls[0]) || post.media.type === "video" ? "video" : urls.length > 1 ? "images" : "image", urls };
    const date = form.get("date");
    const time = form.get("time");
    if (isValidDate(date) && isValidTime(time)) post.when = zonedToUtc(date, time, tz);
  } else if (act === "post_now") {
    post.when = Date.now(); // so anything still processing is finished by the next check
    await publishPost(env, settings, post);
    await savePost(env, post);
    await reportPost(env, settings, post);
    const ok = Object.entries(post.results).filter(([, r]) => r.ok).map(([p]) => p);
    const pend = Object.entries(post.results).filter(([, r]) => r.pending).map(([p]) => p);
    const bad = Object.entries(post.results).filter(([, r]) => !r.ok && !r.pending).map(([p, r]) => `${p} (${r.error})`);
    return back((ok.length ? "Posted to " + ok.join(", ") + ". " : "") + (pend.length ? "Processing on " + pend.join(", ") + " — finishes on the next check. " : "") + (bad.length ? "Not posted: " + bad.join(", ") : ""));
  }
  await savePost(env, post);
  return back(act === "skip" ? "Skipped. It won't be posted." : act === "approve" ? "Approved." : act === "restore" ? "Back in the queue." : "Saved.");
}

const CSS = `
:root{--accent:#c9a227;--ink:#1b1b1b;--muted:#6b6b6b;--line:#e4e1da;--bg:#faf9f6;--ok:#2e7d32;--warn:#b26a00;--bad:#c62828}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#111;color:#fff;padding:14px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5}
header b{font-size:18px}header .tag{color:var(--accent);font-style:italic}header a{color:#ccc;font-size:13px}header nav{margin-left:auto;display:flex;gap:12px;flex-wrap:wrap}
main{max-width:1000px;margin:0 auto;padding:16px}
section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0;scroll-margin-top:70px}
h2{margin:0 0 10px;font-size:17px}h3{margin:12px 0 6px;font-size:14px}
.msg{background:#fff8e1;border:1px solid #f0d58a;border-radius:8px;padding:10px 14px;margin:12px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
button,.btn{background:var(--accent);color:#111;border:0;border-radius:7px;padding:8px 14px;font-size:14px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block}
button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line);font-weight:500}button.danger{background:#fff;color:var(--bad);border:1px solid #f1c4c4;font-weight:500}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);background:#fff;color:var(--ink)}
.pill.ok{border-color:#b9dfbb;color:var(--ok)}.pill.warn{border-color:#f3d39b;color:var(--warn)}.pill.bad{border-color:#f1c4c4;color:var(--bad)}
.alert{border-left:4px solid var(--warn);background:#fffaf0;padding:8px 12px;margin:6px 0;border-radius:4px}
.post{border:1px solid var(--line);border-radius:9px;padding:12px;margin:10px 0;display:flex;gap:12px}
.post .body{flex:1;min-width:0}.post.dim{opacity:.55}.thumb{width:84px;height:105px;object-fit:cover;border-radius:6px;background:#eee;flex:none}
.meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--muted)}.meta b{color:var(--ink);font-size:14px}
textarea,input[type=text],input[type=date],input[type=time],input[type=url],input[type=password],input[type=number],input[type=email],input:not([type]){width:100%;padding:8px;border:1px solid var(--line);border-radius:7px;font:inherit}
textarea{min-height:70px}textarea.code{font:13px/1.4 ui-monospace,Menlo,monospace;min-height:460px}
details summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:10px 0}.photos figure{margin:0;display:grid;gap:6px;font-size:13px}.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block}.photos form{margin:0}.photos button{padding:5px 10px;font-size:13px}
.small{font-size:13px;color:var(--muted)}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:700px){.grid2,.grid3{grid-template-columns:1fr}.post{flex-direction:column}.thumb{width:100%;height:auto;aspect-ratio:4/5}}
.preview{white-space:pre-wrap}.stat{border:1px solid var(--line);border-radius:9px;padding:10px}.stat b{font-size:22px;display:block}
.bar{height:8px;background:var(--accent);border-radius:4px}
`;
const LINKS_CSS = `
body{background:#0e0e0e;color:#f4f1ea}.links{max-width:520px;margin:0 auto;padding:24px 16px}
.links section{background:#1a1a1a;border-color:#2a2a2a}.hero{text-align:center;background:none!important;border:0!important}
.hero h1{margin:8px 0 0;font-size:28px}.hero .tag{color:var(--accent);font-style:italic;margin:4px 0 0}.logo{width:110px;height:110px;object-fit:contain;border-radius:16px}
.big{display:block;text-align:center;background:var(--accent);color:#111;font-weight:700;padding:16px;border-radius:12px;margin:12px 0;text-decoration:none;font-size:18px}
.big.alt{background:#fff;color:#111}.links input,.links textarea{background:#111;color:#f4f1ea;border-color:#333;margin:4px 0}.links button{width:100%;margin-top:6px}
.clips{display:grid;grid-template-columns:1fr 1fr;gap:8px}.clips video,.clips img{width:100%;border-radius:8px;aspect-ratio:9/16;object-fit:cover;background:#000}
.ev{display:block;padding:10px 0;border-bottom:1px solid #2a2a2a;color:#f4f1ea;text-decoration:none}.ev span{display:block;color:#aaa;font-size:13px}
.links .small{color:#aaa}.center{text-align:center}.links a{color:var(--accent)}.links a.big{color:#111}.links .msg{background:#2a2410;border-color:#5a4a10;color:#f4f1ea}
`;

function page(title, body, accent, extraCss = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}${accent ? `:root{--accent:${esc(accent)}}` : ""}${extraCss}</style></head><body>${body}</body></html>`;
}
function loginPage(err) {
  return page("Sign in · Autopilot", `<main style="max-width:380px;margin-top:12vh"><section><h2>Resofrik FM Autopilot</h2><form method="post" action="/login"><p><input type="password" name="password" placeholder="Password" autofocus required></p>${err ? `<p style="color:var(--bad)">${esc(err)}</p>` : ""}<button>Sign in</button></form></section></main>`);
}

const STATUS_PILL = {
  scheduled: ["Scheduled", ""],
  approved: ["Scheduled", ""],
  needs_review: ["Needs your OK", "warn"],
  processing: ["Platforms processing media", "warn"],
  publishing: ["Posting…", "warn"],
  published: ["Posted", "ok"],
  partial: ["Partly posted", "warn"],
  failed: ["Failed", "bad"],
  skipped: ["Skipped", ""],
  nowhere: ["No platform connected", "bad"],
};

async function dashboard(env, url, request) {
  const settings = await loadSettings(env);
  const tz = settings.station.timezone;
  const now = Date.now();
  const msg = url.searchParams.get("msg");
  const lastTick = Number((await kvGet(env, "status:lastTick")) || 0);
  const logs = (await env.DB.prepare("SELECT t, level, msg FROM logs ORDER BY id DESC LIMIT 25").all()).results || [];
  const upcoming = await queryPosts(env, "WHERE when_ms >= ? AND status IN ('scheduled','approved','needs_review','skipped','processing','publishing') ORDER BY when_ms LIMIT 80", now - 30 * 60000);
  const recent = await queryPosts(env, "WHERE when_ms < ? AND status NOT IN ('scheduled','approved','needs_review') ORDER BY when_ms DESC LIMIT 25", now + 30 * 60000);
  const readyVideos = await queryPosts(env, "WHERE kind IN ('clip','slideshow','promo') AND when_ms >= ? ORDER BY when_ms DESC LIMIT 12", now - 21 * 86400000);
  const connected = Object.entries(PLATFORMS).filter(([, p]) => p.ready(env));
  const items = await getItems(env, "WHERE status IN ('review','new') ORDER BY CASE status WHEN 'review' THEN 0 ELSE 1 END, score DESC, created DESC LIMIT 20");
  const inbox = ((await env.DB.prepare("SELECT id, status, data FROM inbox WHERE status = 'new' ORDER BY created DESC LIMIT 20").all()).results || []).map((r) => ({ id: r.id, status: r.status, ...JSON.parse(r.data) }));
  const autoReplied = (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'auto-replied' AND created >= ?").bind(now - 7 * 86400000).first()).n;
  const jobs = (await env.DB.prepare("SELECT id, status, type, created, data FROM jobs ORDER BY created DESC LIMIT 8").all()).results || [];
  const scout = await kvJson(env, "scout:report", null);
  const stats = await buildStats(env, 7);
  const report = await kvJson(env, "report:last", null);
  const music = await listMusic(env);
  const photos = await listPhotos(env);
  const pendingPhotos = await listPhotos(env, "photos-pending/");
  const episodes = await loadEpisodes(env);
  const storyBank = await kvJson(env, "stories:left", null);
  const storiesUp = await queryPosts(env, "WHERE kind = 'story' AND when_ms >= ? AND status IN ('scheduled','approved','needs_review','processing') ORDER BY when_ms LIMIT 6", now);

  const alerts = [];
  if (settings.paused) alerts.push("Autopilot is <b>paused</b>. Nothing will post until you press Resume.");
  if (!lastTick || now - lastTick > 40 * 60000) alerts.push("The 15-minute timer hasn't run recently. Check the Worker's Cron Triggers.");
  if (!connected.length) alerts.push("No social accounts are connected yet. See Connections.");
  if (!env.MEDIA) alerts.push("Media storage isn't connected: bind an R2 bucket as MEDIA so the Studio can store pictures and videos.");
  if (!env.STUDIO_TOKEN) alerts.push("The Studio isn't linked yet: add a STUDIO_TOKEN secret here and in GitHub (see setup guide).");
  if (!scout || now - scout.at > 12 * 3600000) alerts.push("The Studio's scout hasn't reported in the last 12 hours. Check GitHub → Actions.");
  if (!music.length) alerts.push("The Music library is empty, so Rare Breed Stories will be silent. Upload a few royalty-free tracks under Music library.");
  if (!photos.length) alerts.push("The Photo library is empty, so cards use designed backgrounds only. Upload your station photos under Photo library.");
  if (pendingPhotos.length) alerts.push(`${pendingPhotos.length} artist photo${pendingPhotos.length === 1 ? " is" : "s are"} waiting for your OK under Photo library.`);
  if (storyBank && storyBank.left < 6) alerts.push(`Only ${storyBank.left} Rare Breed Stories left in the bank. Ask Claude for the next batch.`);
  if (!activeShows(settings).length) alerts.push("No show times are switched on, so show reminders are off. Settings → schedule.");
  if (!(settings.artists || []).length) alerts.push("No artists listed yet. Add a few (with picture and song links) under Settings → artists so the Studio can make promo videos.");
  if (!env.PUBLIC_URL) alerts.push("Set PUBLIC_URL (this Worker's address) so links are tracked and media links are permanent.");
  if (inbox.length) alerts.push(`${inbox.length} comment(s) need you in the <a href="#inbox">Inbox</a>.`);
  if (items.some((i) => i.status === "review")) alerts.push(`Community announcements are waiting for your OK in <a href="#community">Community</a>.`);
  if (upcoming.some((p) => p.status === "needs_review")) alerts.push("Some posts are waiting for your OK (orange label).");

  const platformChecks = (sel) => Object.entries(PLATFORMS).map(([k, p]) => `<label class="small"><input type="checkbox" name="platforms" value="${k}" ${sel.includes(k) ? "checked" : ""} ${p.ready(env) ? "" : "disabled"}> ${esc(p.label)}</label>`).join(" ");
  const thumb = (p) => {
    const u = p.media.urls[0];
    if (!u) return "";
    return p.media.type === "video" ? `<video class="thumb" src="${esc(u)}" preload="none" muted playsinline></video>` : `<img class="thumb" src="${esc(u)}" alt="" loading="lazy">`;
  };
  const postCard = (p, editable) => {
    const [label, cls] = STATUS_PILL[p.status] || [p.status, ""];
    const lp = zoneParts(p.when, tz);
    const results = Object.entries(p.results || {}).map(([k, r]) => `<span class="pill ${r.ok ? "ok" : r.pending ? "warn" : r.skipped || r.error === "not connected" ? "" : "bad"}" title="${esc(r.error || (r.pending ? "processing" : ""))}">${esc(k)}${r.ok ? " ✓" : r.pending ? " …" : r.skipped ? " –" : r.error === "not connected" ? "" : " ✗"}</span>`).join(" ");
    const kindLabel = { weekly: "post", community: "community", clip: "short", slideshow: "video", promo: "artist promo", carousel: "carousel", reminder: "reminder", "on-air": "on air", "now-playing": "now playing", manual: "your post" }[p.kind] || p.kind;
    return `<div class="post ${p.status === "skipped" ? "dim" : ""}" id="p-${esc(p.id)}">${thumb(p)}<div class="body">
<div class="meta"><b>${esc(fmtLocal(p.when, tz))}</b><span class="pill ${cls}">${esc(label)}</span><span class="pill">${esc(kindLabel)}${p.global ? " · global" : ""}</span>${p.media.type !== "none" ? `<span class="pill">${p.media.type === "images" ? `🖼 ${p.media.urls.length} slides` : p.media.type === "video" ? "🎬 video" : "🖼 picture"}</span>` : p.needsImage ? `<span class="pill">picture coming</span>` : ""} ${results}</div>
<div class="preview">${esc(p.short || p.long)}</div>${p.source ? `<div class="small">Source: ${esc(p.source)}</div>` : ""}
${
  editable
    ? `<details><summary>Edit, skip or post now</summary><form method="post" action="/action"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="anchor" value="p-${esc(p.id)}">
<h3>Short version (Bluesky, Threads, Mastodon)</h3><textarea name="short">${esc(p.short)}</textarea>
<h3>Long version (Facebook, Instagram, Telegram)</h3><textarea name="long" style="min-height:120px">${esc(p.long)}</textarea>
<div class="grid2"><div><h3>Date</h3><input type="date" name="date" value="${lp.date}"></div><div><h3>Time (station time)</h3><input type="time" name="time" value="${lp.time}"></div></div>
<h3>Picture / video links (one per line; several pictures = carousel)</h3><textarea name="media" style="min-height:50px">${esc(p.media.urls.join("\n"))}</textarea>
<div class="row" style="margin-top:10px"><button name="do" value="save">Save</button>${p.status === "needs_review" ? `<button name="do" value="approve">Approve</button>` : ""}
${p.status === "skipped" ? `<button class="ghost" name="do" value="restore">Put back</button>` : `<button class="ghost" name="do" value="skip">Skip</button>`}
<button class="ghost" name="do" value="post_now" onclick="return confirm('Post this everywhere right now?')">Post now</button><button class="danger" name="do" value="delete" onclick="return confirm('Delete this post?')">Delete</button></div></form></details>`
    : p.status === "failed" || p.status === "partial" ? `<form method="post" action="/action" class="row" style="margin-top:6px"><input type="hidden" name="id" value="${esc(p.id)}"><button class="ghost" name="do" value="post_now">Try again</button></form>` : ""
}</div></div>`;
  };

  const maxClicks = Math.max(1, ...stats.clicks.map((c) => c.n || 0));
  const body = `
<header><b>${esc(settings.station.name)} Autopilot</b><span class="tag">${esc(settings.station.slogan)}</span><span class="pill ${settings.paused ? "bad" : "ok"}">${settings.paused ? "Paused" : "Running"}</span>
<nav><a href="#queue">Queue</a><a href="#studio">Studio</a><a href="#photos">Photos</a><a href="#series">Series</a><a href="#community">Community</a><a href="#inbox">Inbox${inbox.length ? ` (${inbox.length})` : ""}</a><a href="#results">Results</a><a href="#conn">Connections</a><a href="#settings">Settings</a><a href="/links" target="_blank">Link page ↗</a><a href="/logout">Sign out</a></nav></header>
<main>${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<section><h2>At a glance</h2><div class="grid3">
<div class="stat"><b>${upcoming.filter((p) => p.status !== "skipped").length}</b>posts queued</div><div class="stat"><b>${stats.published}</b>posted this week</div><div class="stat"><b>${stats.totalClicks}</b>link clicks this week</div>
<div class="stat"><b>${stats.subsTotal}</b>email subscribers (+${stats.subs})</div><div class="stat"><b>${autoReplied}</b>comments answered automatically</div><div class="stat"><b>${connected.length}/${Object.keys(PLATFORMS).length}</b>accounts connected</div></div>
${alerts.map((a) => `<div class="alert">${a}</div>`).join("")}
<form method="post" action="/action" class="row" style="margin-top:12px">${settings.paused ? `<button name="do" value="resume">Resume autopilot</button>` : `<button class="ghost" name="do" value="pause">Pause everything</button>`}
<button class="ghost" name="do" value="generate" onclick="return confirm('Write a fresh set of posts for next week? Unposted weekly posts for that week will be replaced.')">Write next week now</button>
<button class="ghost" name="do" value="studio_now">Run the Studio now</button><button class="ghost" name="do" value="restyle" onclick="return confirm('Re-make all upcoming pictures and this week\\'s carousels in the current look?')">Redo pictures</button><button class="ghost" name="do" value="tick">Run a check now</button></form>
<p class="small">Last check: ${lastTick ? esc(fmtLocal(lastTick, tz)) : "never"}. The writer runs Saturday evenings, the publisher every 15 minutes, the scout every 4 hours, the Studio every evening.</p></section>

<section id="queue"><h2>Coming up</h2>${upcoming.length ? upcoming.slice(0, 10).map((p) => postCard(p, true)).join("") + (upcoming.length > 10 ? `<details><summary>Show ${upcoming.length - 10} more</summary>${upcoming.slice(10).map((p) => postCard(p, true)).join("")}</details>` : "") : `<p class="small">Nothing queued yet. Press “Write next week now”.</p>`}</section>

<section id="studio"><h2>Studio — shorts, videos, carousels</h2>
<p class="small">Give the Studio a show recording, podcast episode or video. It finds the best moments, cuts vertical captioned shorts in the station's look, writes captions, and schedules them (${esc(settings.studio.clipTimes.join(" and "))} each day). It also makes picture cards for every post, weekly carousels, artist promo videos and a weekly “around Cleveland” video.</p>
<div class="grid2"><form method="post" action="/action"><input type="hidden" name="anchor" value="studio"><h3>From a link</h3><input type="url" name="url" placeholder="https://… (mp4, mp3, podcast episode, YouTube)" required><div class="grid2"><input name="title" placeholder="Title (optional)"><input type="number" name="count" min="1" max="8" value="${settings.studio.clipsPerVideo}" title="How many shorts"></div><p><button name="do" value="clip_url">Make shorts</button></p></form>
<form method="post" action="/action" enctype="multipart/form-data"><input type="hidden" name="anchor" value="studio"><h3>Upload a file (up to 100 MB)</h3><input type="file" name="file" accept="video/*,audio/*"><div class="grid2"><input name="title" placeholder="Title (optional)"><input type="number" name="count" min="1" max="8" value="${settings.studio.clipsPerVideo}"></div><p><button name="do" value="clip_upload">Upload and make shorts</button></p></form></div>
<h3>Studio jobs</h3><table>${jobs.map((j) => { const d = JSON.parse(j.data); return `<tr><td class="small">${esc(fmtLocal(j.created, tz))}</td><td>${esc(d.title || d.url)}</td><td><span class="pill ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}">${esc(j.status)}</span></td></tr>`; }).join("") || `<tr><td class="small">No jobs yet.</td></tr>`}</table>
<h3>Videos ready for TikTok and YouTube</h3><p class="small">TikTok and YouTube keep automated uploads private until an app passes their review, so download these and post them by hand (or through Content360).</p>
<table>${readyVideos.filter((p) => p.media.type === "video").map((p) => `<tr><td>${esc(p.headline || shortText(p).slice(0, 70))}</td><td><a href="${esc(p.media.urls[0])}" download>Download</a></td></tr>`).join("") || `<tr><td class="small">None yet.</td></tr>`}</table></section>
<section id="music"><h2>Rare Breed Stories &amp; Music library</h2>
<p class="small">Twice a week (${esc(((settings.studio.stories || {}).days || ["Tue", "Fri"]).join(" and "))} at ${esc((settings.studio.stories || {}).time || "19:30")}) the Studio turns a fact-checked artist story into a vertical video with music, writes a different caption for each platform, and ends with a question to get people talking. ${storyBank ? `<b>${storyBank.left}</b> of ${storyBank.total} stories left in the bank.` : ""}</p>
<h3>Coming up</h3><table>${storiesUp.map((p) => `<tr><td class="small" style="white-space:nowrap">${esc(fmtLocal(p.when, tz))}</td><td>${esc(p.headline || "")}</td><td>${p.media.urls[0] ? `<a href="${esc(p.media.urls[0])}" target="_blank">Watch</a>` : ""}</td></tr>`).join("") || `<tr><td class="small">The Studio makes the next ones on its evening run.</td></tr>`}</table>
<h3>Music library (${music.length} track${music.length === 1 ? "" : "s"})</h3>
<p class="small">Only upload music you're allowed to use: royalty-free tracks (for example Pixabay Music or the YouTube Audio Library, “no attribution required”) or songs artists sent with permission. Pick the closest style so each story gets fitting music.</p>
<table>${["reggae", "soul", "african", "afrobeats", "hiphop", "jazz"].map((g) => `<tr><td>${esc(g)}</td><td>${music.filter((m) => m.genre === g).map((m) => `<a href="${esc(m.url)}" target="_blank">${esc(m.name)}</a>`).join(", ") || `<span class="small">none yet</span>`}</td></tr>`).join("")}</table>
<form method="post" action="/action" enctype="multipart/form-data"><input type="hidden" name="anchor" value="music"><div class="grid2"><input type="file" name="file" accept="audio/*" multiple required><select name="genre">${["reggae", "soul", "african", "afrobeats", "hiphop", "jazz"].map((g) => `<option>${g}</option>`).join("")}</select></div><p><button name="do" value="music_upload">Add to music library</button></p></form></section>

<section id="photos"><h2>Photo library (${photos.length} photo${photos.length === 1 ? "" : "s"})</h2>
<p class="small">Your own photos make the posts. The Studio puts them behind the cards for each kind of post (Artists for music posts, Shows &amp; hosts for show reminders, Station &amp; studio for everything else) and into the weekly carousels. Community news posts keep the designed background, so nobody's photo appears next to a story it isn't from. Only upload photos the station owns or has permission to use.</p>
${pendingPhotos.length ? `<h3>Sent by artists, waiting for your OK (${pendingPhotos.length})</h3><div class="photos">${pendingPhotos.map((ph) => `<figure><a href="${esc(ph.url)}" target="_blank"><img src="${esc(ph.url)}" alt="" loading="lazy"></a><figcaption><b>${esc(ph.about)}</b>${ph.credit ? `<br>Photo: ${esc(ph.credit)}` : ""}<br><span class="small">${esc(ph.email)}${ph.instagram ? " · @" + esc(ph.instagram) : ""}</span></figcaption><form method="post" action="/action"><input type="hidden" name="anchor" value="photos"><input type="hidden" name="key" value="${esc(ph.key)}"><button name="do" value="photo_approve">Approve</button> <button class="ghost" name="do" value="photo_reject">Decline</button></form></figure>`).join("")}</div>` : ""}
${Object.entries(PHOTO_TAGS).map(([t, label]) => { const list = photos.filter((ph) => ph.tag === t); return `<details${list.length && list.length <= 12 ? " open" : ""}><summary>${esc(label)} (${list.length})</summary>${list.length ? `<div class="photos">${list.map((ph) => `<figure><a href="${esc(ph.url)}" target="_blank"><img src="${esc(ph.url)}" alt="${esc(ph.about)}" loading="lazy"></a>${ph.about || ph.credit ? `<figcaption>${esc(ph.about)}${ph.credit ? ` <span class="small">· ${esc(ph.credit)}</span>` : ""}</figcaption>` : ""}<form method="post" action="/action"><input type="hidden" name="anchor" value="photos"><input type="hidden" name="key" value="${esc(ph.key)}"><button class="ghost" name="do" value="photo_delete" onclick="return confirm('Remove this photo from the library?')">Remove</button></form></figure>`).join("")}</div>` : `<p class="small">None yet.</p>`}</details>`; }).join("")}
<h3>Add photos</h3>
<form method="post" action="/action" enctype="multipart/form-data"><input type="hidden" name="anchor" value="photos"><input type="file" name="file" accept="image/jpeg,image/png,image/webp" multiple required><div class="grid3"><select name="tag">${Object.entries(PHOTO_TAGS).map(([t, label]) => `<option value="${t}">${esc(label)}</option>`).join("")}</select><input name="about" placeholder="Who or what is in them (e.g. a show or artist name)"><input name="credit" placeholder="Photo credit (optional)"></div><p class="small">Up to 60 photos at a time, 25 MB each. Tip: name the show or artist in “Who or what” so the Studio can match photos to the right show reminder or artist post.</p><p><button name="do" value="photo_upload">Add to photo library</button></p></form>
<p class="small">Artists can send their own photos here: <a href="/send-photos" target="_blank">${esc(origin(env, request))}/send-photos</a> (share this link with them). You approve each one first.</p></section>

<section id="series"><h2>Original series: episodes (${episodes.length})</h2>
<p class="small">Episodes uploaded here play on the website's series pages (from our own storage, no YouTube needed). Name each file like <code>cpbw-s1-e01--Poet--Title.mp4</code>, with a matching <code>.jpg</code> for its picture (cpbw = Cleveland Poetry in Black and White, cmbw = Cleveland Music in Black and White). The Studio listens to each new episode and writes down the words, so a description can be written from them.</p>
${episodes.map((e) => `<details class="post"><summary><b>${esc(SERIES_TITLE[e.series] || e.series)} · S${e.season} E${e.episode}</b> — ${esc(e.poet || "?")}: ${esc(e.title)} ${e.video ? "" : `<span class="pill warn">no video yet</span>`}${e.description ? "" : ` <span class="pill">no description</span>`}${e.hidden ? ` <span class="pill">hidden</span>` : ""}</summary>${e.poster ? `<img src="${esc(e.poster)}" alt="" style="max-width:260px;border-radius:8px">` : ""}<form method="post" action="/action"><input type="hidden" name="anchor" value="series"><input type="hidden" name="id" value="${esc(episodeId(e))}"><div class="grid2"><input name="poet" value="${esc(e.poet)}" placeholder="Poet / artist"><input name="title" value="${esc(e.title)}" placeholder="Title"></div><textarea name="description" maxlength="600" placeholder="Short description for the website">${esc(e.description)}</textarea><p><select name="hidden"><option value="no">Show on the website</option><option value="yes"${e.hidden ? " selected" : ""}>Hide from the website</option></select> <button name="do" value="episode_edit">Save</button></p></form>${e.transcript ? `<details><summary class="small">Words (from the Studio)</summary><p class="small">${esc(e.transcript)}</p></details>` : `<p class="small">${e.video ? "The Studio will write down the words on its next run." : ""}</p>`}</details>`).join("")}
<h3>Upload episodes</h3>
<p class="small">Pick all the videos and pictures at once (each file up to 95 MB). They upload one by one; keep this page open until it says done.</p>
<input type="file" id="epFiles" accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" multiple> <button type="button" id="epGo">Upload episodes</button>
<p class="small" id="epStatus"></p>
<script>
document.getElementById("epGo").onclick = async () => {
  const files = [...document.getElementById("epFiles").files], st = document.getElementById("epStatus");
  if (!files.length) { st.textContent = "Choose the files first."; return; }
  let ok = 0, bad = [];
  for (const [i, f] of files.entries()) {
    st.textContent = "Uploading " + (i + 1) + " of " + files.length + ": " + f.name + " …";
    if (f.size > 95e6) { bad.push(f.name + " (over 95 MB)"); continue; }
    try {
      const r = await fetch("/upload-episode?name=" + encodeURIComponent(f.name), { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
      const j = await r.json();
      if (r.ok) ok++; else bad.push(f.name + " (" + (j.error || r.status) + ")");
    } catch (e) { bad.push(f.name + " (" + e.message + ")"); }
  }
  st.textContent = "Done: " + ok + " uploaded." + (bad.length ? " Not uploaded: " + bad.join("; ") : "");
  if (ok) setTimeout(() => location.href = "/?msg=" + encodeURIComponent(ok + " episode files uploaded.") + "#series", 1500);
};
</script></section>

<section id="community"><h2>Community board</h2>
<p class="small">The scout reads ${(settings.sources || []).filter((s) => s.enabled).length} sources every 4 hours, keeps positive local stories and events, and the desk posts the best ones at ${esc(settings.community.times.join(" and "))}. The same list feeds the website's Community board.${scout ? ` Last scout: ${esc(fmtLocal(scout.at, tz))}.` : ""}</p>
${scout && scout.sources ? `<details><summary>Source health</summary><table>${scout.sources.map((s) => `<tr><td>${esc(s.name)}</td><td><span class="pill ${s.ok ? "ok" : "bad"}">${s.ok ? `${s.found} found` : "error"}</span></td><td class="small">${esc(s.error || "")}</td></tr>`).join("")}</table></details>` : ""}
${items.map((i) => `<div class="post"><div class="body"><div class="meta"><b>${esc(i.title)}</b>${i.status === "review" ? `<span class="pill warn">Submitted — needs your OK</span>` : `<span class="pill">score ${Number(i.score).toFixed(0)}</span>`}<span class="pill">${esc(i.region)}</span>${i.eventDate ? `<span class="pill">📅 ${esc(prettyDate(i.eventDate))}</span>` : ""}</div><div class="small">${esc(i.source)} · <a href="${esc(i.url)}" target="_blank" rel="noopener">open</a>${i.contact ? " · contact " + esc(i.contact) : ""}</div><div class="preview">${esc(i.summary)}</div>
<form method="post" action="/action" class="row" style="margin-top:6px"><input type="hidden" name="item" value="${esc(i.id)}"><input type="hidden" name="anchor" value="community">${i.status === "review" ? `<button name="do" value="item_approve">Approve</button>` : ""}<button class="ghost" name="do" value="item_post">Post now</button><button class="ghost" name="do" value="item_skip">Skip</button></form></div></div>`).join("") || `<p class="small">No new items right now.</p>`}
<p class="small">Website feed: <code>${esc(origin(env, request))}/api/public/events</code></p></section>

<section id="inbox"><h2>Inbox</h2><p class="small">Comments and replies from Facebook, Instagram and Bluesky. Simple ones (thanks, praise, "how do I listen") are answered automatically${settings.engage.autoReply === "simple" ? "" : " — currently off"}; the rest wait here with a suggested reply.</p>
${inbox.map((c) => `<div class="post"><div class="body"><div class="meta"><b>${esc(c.author)}</b><span class="pill">${esc(c.platform)}</span><span class="pill">${esc(c.type || "comment")}</span></div><div class="preview">${esc(c.text)}</div>${c.postText ? `<div class="small">On: ${esc(c.postText.slice(0, 100))}</div>` : ""}
<form method="post" action="/action"><input type="hidden" name="inbox" value="${esc(c.id)}"><input type="hidden" name="anchor" value="inbox"><textarea name="reply" placeholder="Your reply">${esc(c.reply)}</textarea><div class="row"><button name="do" value="reply">Send reply</button><button class="ghost" name="do" value="ignore">Mark handled</button></div></form></div></div>`).join("") || `<p class="small">All caught up.</p>`}</section>

<section id="results"><h2>Results (last 7 days)</h2>
<h3>Link clicks by platform</h3><table>${stats.clicks.map((c) => `<tr><td style="width:120px">${esc(c.platform)}</td><td><div class="bar" style="width:${Math.round(((c.n || 0) / maxClicks) * 100)}%"></div></td><td style="width:50px">${c.n}</td></tr>`).join("") || `<tr><td class="small">No clicks tracked yet${env.PUBLIC_URL ? "" : " — set PUBLIC_URL to turn on tracking"}.</td></tr>`}</table>
<h3>Top posts</h3><table>${stats.topPosts.map((t) => `<tr><td>${esc(t.text)}</td><td>${t.n}</td></tr>`).join("") || `<tr><td class="small">—</td></tr>`}</table>
<p class="small">Email list: ${stats.subsTotal} people. <a href="/export/subscribers.csv">Download the list (CSV)</a>. Sign-up page: <a href="/links" target="_blank">${esc(origin(env, request))}/links</a> — put this in your Instagram, TikTok and Facebook bios.</p>
${report ? `<details><summary>Last weekly report</summary><pre class="small">${esc(report.text)}</pre></details>` : ""}</section>

<section id="new"><h2>Add a post</h2><form method="post" action="/action"><input type="hidden" name="do" value="new_post"><input type="hidden" name="anchor" value="new">
<h3>Post text (Facebook, Instagram, Telegram)</h3><textarea name="long" required></textarea><h3>Short version (optional)</h3><textarea name="short" style="min-height:50px"></textarea>
<div class="grid2"><div><h3>Date</h3><input type="date" name="date"></div><div><h3>Time (blank = next check)</h3><input type="time" name="time"></div></div>
<div class="grid2"><div><h3>Link</h3><input type="url" name="link" placeholder="${esc(settings.station.listenUrl)}"></div><div><h3>Picture / video links (one per line)</h3><textarea name="media" style="min-height:42px"></textarea></div></div>
<h3>Where</h3><div class="row">${platformChecks(settings.weekly.platforms)}</div><p><button>Schedule post</button></p></form></section>

<section><h2>Recently</h2>${recent.map((p) => postCard(p, false)).join("") || `<p class="small">Nothing posted yet.</p>`}
<h3>Activity</h3><table>${logs.map((l) => `<tr><td class="small" style="white-space:nowrap">${esc(fmtLocal(l.t, tz))}</td><td>${l.level === "error" ? "⚠️ " : ""}${esc(l.msg)}</td></tr>`).join("") || `<tr><td class="small">No activity yet.</td></tr>`}</table></section>

<section id="conn"><h2>Connections</h2><table>${Object.entries(PLATFORMS).map(([k, p]) => `<tr><td><b>${esc(p.label)}</b></td><td>${p.ready(env) ? `<span class="pill ok">connected</span>` : `<span class="pill">not set up</span>`}</td><td class="small">${esc(p.help)}</td><td>${p.ready(env) ? `<form method="post" action="/action"><input type="hidden" name="anchor" value="conn"><input type="hidden" name="platform" value="${k}"><button class="ghost" name="do" value="test">Test</button></form>` : ""}</td></tr>`).join("")}</table>
<p class="small">Also: <b>MEDIA</b> (R2 bucket) ${env.MEDIA ? "✓" : "✗"} · <b>STUDIO_TOKEN</b> ${env.STUDIO_TOKEN ? "✓" : "✗"} · <b>ANTHROPIC_API_KEY</b> ${env.ANTHROPIC_API_KEY ? "✓" : "✗"} · <b>PUBLIC_URL</b> ${env.PUBLIC_URL ? "✓" : "✗"} · alerts ${env.NOTIFY_TELEGRAM_CHAT_ID || env.NOTIFY_DISCORD_WEBHOOK ? "✓" : "✗"} · Run-Studio button ${env.GH_DISPATCH_TOKEN && env.GH_REPO ? "✓" : "✗"}</p></section>

<section id="settings"><h2>Settings</h2><p class="small">Everything the team knows about the station. Change the words between the quote marks and press Save. Most useful: <b>schedule</b> (show day/time, active: true), <b>artists</b> (with <i>image</i> and <i>audio</i> links for promo videos), <b>sources</b> (local feeds to watch), <b>studio.videoFeeds</b> (your podcast/YouTube feeds to clip automatically), <b>station.logoUrl</b>, <b>donateUrl</b>, <b>signupUrl</b>, <b>nowPlaying.url</b> (your AzuraCast now-playing link), and <b>live</b> (your Cloudflare Stream customer code and live input ID; the website's Live page and the "we're live" posts use it).</p>
<form method="post" action="/action"><input type="hidden" name="anchor" value="settings"><textarea class="code" name="settings" spellcheck="false">${esc(JSON.stringify(settings, null, 2))}</textarea>
<div class="row" style="margin-top:10px"><button name="do" value="save_settings">Save settings</button><button class="danger" name="do" value="reset_settings" onclick="return confirm('Reset all settings to the starting defaults?')">Reset to defaults</button></div></form></section>
<p class="small" style="text-align:center">Resofrik Autopilot ${VERSION}</p></main>`;
  return page("Autopilot · " + settings.station.name, body, settings.station.brandColor);
}
