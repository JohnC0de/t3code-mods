// calm-thread backend: one-line turn titles from an Anthropic Messages API endpoint, cached on disk.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SYSTEM =
  "You label one turn of a chat between a user and a coding agent. Reply with JSON only, no prose: " +
  '{"title": string, "needs": string | null}. ' +
  "title: what the turn did or concluded, at most 8 words, plain common words, no trailing period, no quotes, no emoji. " +
  "needs: if the answer ends by waiting on the user (a question, a decision, or an action only the user can do), " +
  'say what in at most 6 words starting with a verb, such as "Pick a path" or "Approve the push"; otherwise null.';

const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_CONCURRENT = 2;
const MAX_ENTRIES = 5000;
const WRITE_DELAY_MS = 2000;
const TIMEOUT_MS = 30_000;
const PROMPT_MAX = 600;
const ANSWER_MAX = 2000;
const ANSWER_TAIL = 400;
const TITLE_MAX = 80;

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

function truncateAnswer(answer) {
  if (answer.length <= ANSWER_MAX) return answer;
  const sep = "\n…\n";
  return clip(answer, ANSWER_MAX - ANSWER_TAIL - sep.length) + sep + answer.slice(-ANSWER_TAIL);
}

function parseReply(data) {
  const block = Array.isArray(data && data.content) ? data.content.find((b) => b && b.type === "text" && typeof b.text === "string") : null;
  if (!block) throw new Error("bad reply: no text block");
  const m = /\{[\s\S]*\}/.exec(block.text);
  let obj;
  try {
    obj = m && JSON.parse(m[0]);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== "object") throw new Error(`bad reply: no JSON object in ${JSON.stringify(clip(block.text, 120))}`);
  if (typeof obj.title !== "string") throw new Error(`bad reply: no title in ${JSON.stringify(clip(block.text, 120))}`);
  const title = clip(
    obj.title.trim().replace(/\.$/, "").replace(/^["'“”‘’](.*)["'“”‘’]$/s, "$1").trim().replace(/\.$/, "").trim(),
    TITLE_MAX,
  );
  if (!title) throw new Error(`bad reply: empty title in ${JSON.stringify(clip(block.text, 120))}`);
  const needs = typeof obj.needs === "string" && obj.needs.trim() ? obj.needs.trim() : null;
  return { title, needs };
}

module.exports = (ctx) => {
  const file = path.join(ctx.app.home, "mod-data", "calm-thread", "titles.json");
  let cache = null;
  let dirty = false;
  let timer = null;
  let lastWrite = 0;
  let stopped = false;
  let active = 0;
  const queue = [];
  const inflight = new Map();
  const aborter = new AbortController();

  function config() {
    const st = ctx.state() || {};
    const modelUrl = (typeof st.modelUrl === "string" && st.modelUrl) || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const model = (typeof st.model === "string" && st.model) || DEFAULT_MODEL;
    let key = "";
    let why = "no keyFile and no ANTHROPIC_API_KEY";
    if (typeof st.keyFile === "string" && st.keyFile) {
      const p = st.keyFile.replace(/^~(?=$|[\\/])/, os.homedir());
      try {
        key = fs.readFileSync(p, "utf8").trim();
      } catch (e) {
        why = `cannot read keyFile ${p}: ${e.message}`;
      }
    } else if (process.env.ANTHROPIC_API_KEY) key = process.env.ANTHROPIC_API_KEY.trim();
    return { url: modelUrl.replace(/\/$/, ""), model, key, why };
  }

  function load() {
    if (cache) return cache;
    cache = { version: 1, entries: {} };
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return cache;
      throw e;
    }
    try {
      const j = JSON.parse(text);
      if (!j || typeof j.entries !== "object" || !j.entries) throw new Error("no entries object");
      cache.entries = j.entries;
    } catch (e) {
      ctx.log(`titles.json is corrupt (${e.message}); moved to titles.json.bad`);
      fs.renameSync(file, file + ".bad");
    }
    return cache;
  }

  function writeNow() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty || !cache) return;
    const ids = Object.keys(cache.entries);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => String(cache.entries[a].at).localeCompare(String(cache.entries[b].at)));
      for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete cache.entries[id];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
    dirty = false;
    lastWrite = Date.now();
  }

  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    const wait = Math.max(0, lastWrite + WRITE_DELAY_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      try {
        writeNow();
      } catch (e) {
        ctx.log("cache write failed:", e.message);
      }
    }, Math.max(wait, 1));
    if (timer.unref) timer.unref();
  }

  async function request(item, cfg) {
    const prompt = clip(item.prompt || "", PROMPT_MAX);
    const answer = truncateAnswer(item.answer || "");
    let content = `User prompt:\n${prompt}\n\nAgent answer:\n${answer}`;
    if (!item.needs) content += "\n\nSet needs to null.";
    let res;
    try {
      res = await fetch(`${cfg.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.key}`,
          "x-api-key": cfg.key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        // Models that think by default (Haiku 5.5 through some gateways) would spend the budget on it.
        body: JSON.stringify({ model: cfg.model, max_tokens: 120, thinking: { type: "disabled" }, system: SYSTEM, messages: [{ role: "user", content }] }),
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), aborter.signal]),
      });
    } catch (e) {
      if (stopped) throw new Error("stopped");
      throw new Error(`title request failed: ${e.message}`);
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`title request failed: HTTP ${res.status} ${clip(body.replace(/\s+/g, " "), 200)}`);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`title request failed: reply is not JSON: ${clip(body.replace(/\s+/g, " "), 200)}`);
    }
    if (data && data.stop_reason === "max_tokens") throw new Error("bad reply: the model hit max_tokens before the JSON ended");
    const out = parseReply(data);
    if (!item.needs) out.needs = null;
    return out;
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      active++;
      job.run().then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  }

  const enqueue = (run) =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(new Error("stopped"));
      queue.push({ run, resolve, reject });
      pump();
    });

  function title(item) {
    if (stopped) return Promise.reject(new Error("stopped"));
    const cfg = config();
    const entries = load().entries;
    const hit = entries[item.id];
    if (hit && hit.model === cfg.model && (!item.needs || hit.withNeeds)) {
      return Promise.resolve({ title: hit.title, needs: item.needs ? hit.needs : null });
    }
    if (!cfg.key) return Promise.reject(new Error(`not configured: ${cfg.why}`));
    const key = `${item.id}\0${item.needs ? 1 : 0}`;
    const running = inflight.get(key);
    if (running) return running;
    const p = enqueue(async () => {
      const out = await request(item, cfg);
      entries[item.id] = { title: out.title, needs: out.needs, model: cfg.model, withNeeds: !!item.needs, at: new Date().toISOString() };
      scheduleWrite();
      return out;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function status() {
    const cfg = config();
    return { configured: !!cfg.key, url: cfg.url, model: cfg.model, cached: Object.keys(load().entries).length };
  }

  function dispose() {
    stopped = true;
    for (const job of queue.splice(0)) job.reject(new Error("stopped"));
    aborter.abort();
    try {
      writeNow();
    } catch (e) {
      ctx.log("cache write failed:", e.message);
    }
  }

  return { title, status, dispose };
};
