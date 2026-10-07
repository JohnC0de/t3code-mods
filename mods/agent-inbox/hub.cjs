// Agent Inbox hub: leader election and relay between the main processes of the T3 Code apps
// that run at once (they share one mods folder). The first app to listen on the endpoint is
// the leader; the others connect as followers. The leader merges every app's model and routes
// an action to the app that owns the thread. Newline-delimited JSON over a named pipe (Windows)
// or a unix socket. Pure Node, so a test can run several hubs in one process. CONTRACT.md.
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PROTOCOL = 1;
const ACT_TIMEOUT_MS = 15_000;

function username() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || "";
  }
}

/** The pipe or socket for one user and mods folder; every app on that folder gets the same one. */
function endpointFor(modsDir, { platform = process.platform, user = username() } = {}) {
  const id = crypto.createHash("sha1").update(path.resolve(modsDir).toLowerCase() + user).digest("hex").slice(0, 12);
  return platform === "win32" ? `\\\\.\\pipe\\t3mods-agent-inbox-${id}` : path.join(os.tmpdir(), `t3ai-${id}.sock`);
}

const sameThread = (a, b) => a?.environmentId === b?.environmentId && a?.threadId === b?.threadId;
const owns = (model, ref) => !!model && ["cards", "dots", "agents"].some((f) => (model[f] ?? []).some((i) => sameThread(i.ref, ref)));
const label = (a) => a.name ?? a.id;

/**
 * app: { id, name, home }; act(action): runs an action in this app; ui: { openInbox, openList }
 * run in the leader (a follower's call is relayed); onChange(): the leader's models changed;
 * onRole(isLeader): this hub won or lost the lead; retryMs: [min, max] election jitter.
 */
function createHub({ endpoint, app, act, ui = {}, onChange = () => {}, onRole = () => {}, log = () => {}, timeoutMs = ACT_TIMEOUT_MS, retryMs = [60, 260], platform = process.platform }) {
  let role = null; // "leader" | "follower" | null (between elections)
  let server = null;
  let uplink = null; // follower: the socket to the leader
  let closed = false;
  let timer = null;
  let latest = null; // this app's own model
  let nextId = 1;
  const peers = new Set(); // leader: { sock, app, model }
  const pending = new Map(); // request id -> { sock, name, resolve, reject, timer }

  const send = (sock, msg) => {
    if (sock && !sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
  };
  function lines(sock, onMsg) {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {}); // 'close' follows and does the cleanup
    sock.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onMsg(JSON.parse(line));
        } catch (e) {
          log("bad message on the hub:", e.message);
        }
      }
    });
  }

  function request(sock, msg, name) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name} did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      pending.set(id, { sock, name, resolve, reject, timer: t });
      send(sock, { ...msg, id });
    });
  }
  function settle(msg) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || "failed"));
  }
  function dropPending(sock) {
    for (const [id, p] of pending) {
      if (p.sock !== sock) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`${p.name} quit before it answered`));
    }
  }

  // A request from the other side: an action for this app (leader -> follower) or a UI call
  // for the leader (follower -> leader). `allowed` is the one kind that side may send: actions
  // come only from the leader, which runs them for the user's click in its own windows.
  function answer(sock, msg, allowed) {
    const run = async () => {
      if (msg.t !== allowed) throw new Error(`unsupported request ${msg.t} ${msg.method ?? ""}`.trim());
      if (msg.t === "act") return act(msg.action);
      if (msg.t === "ui" && typeof ui[msg.method] === "function") return ui[msg.method](...(msg.args ?? []));
      throw new Error(`unsupported request ${msg.t} ${msg.method ?? ""}`.trim());
    };
    run().then(
      (value) => send(sock, { t: "res", id: msg.id, ok: true, value }),
      (e) => send(sock, { t: "res", id: msg.id, ok: false, error: e?.message ?? String(e) }),
    );
  }

  // ---------- election ----------
  const later = (fn) => {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(fn, retryMs[0] + Math.random() * (retryMs[1] - retryMs[0]));
    timer.unref();
  };

  function tryListen() {
    if (closed) return;
    const srv = net.createServer();
    const failed = (err) => {
      srv.close();
      if (err.code === "EADDRINUSE") return connect();
      log("hub could not listen:", err.message);
      later(tryListen);
    };
    srv.once("error", failed);
    srv.listen(endpoint, () => {
      srv.off("error", failed);
      srv.on("error", (e) => log("hub server:", e.message));
      if (closed) return srv.close();
      if (platform !== "win32") fs.chmod(endpoint, 0o600, () => {});
      srv.unref(); // the hub must not keep the app from quitting
      server = srv;
      role = "leader";
      srv.on("connection", onPeer);
      onRole(true);
      onChange();
    });
  }

  function connect() {
    if (closed) return;
    const sock = net.connect(endpoint);
    let up = false;
    sock.unref();
    sock.once("connect", () => {
      up = true;
      uplink = sock;
      role = "follower";
      lines(sock, (msg) => (msg.t === "res" ? settle(msg) : answer(sock, msg, "act")));
      send(sock, { t: "hello", v: PROTOCOL, app });
      send(sock, { t: "model", model: latest });
      onRole(false);
    });
    sock.on("error", (err) => {
      if (up) return;
      // Nobody answers: a unix socket file left by a dead leader blocks the endpoint until removed.
      if (err.code === "ECONNREFUSED" && platform !== "win32") fs.rmSync(endpoint, { force: true });
      later(tryListen);
    });
    sock.on("close", () => {
      if (!up) return;
      up = false;
      uplink = null;
      role = null;
      dropPending(sock);
      later(tryListen);
    });
  }

  // ---------- leader side ----------
  function onPeer(sock) {
    sock.unref();
    const peer = { sock, app: null, model: null };
    lines(sock, (msg) => {
      if (msg.t === "hello") {
        if (msg.v !== PROTOCOL) {
          log(`hub: dropped an app with protocol ${msg.v}; this one speaks ${PROTOCOL}`);
          return sock.end();
        }
        peer.app = { id: String(msg.app?.id ?? "?"), name: msg.app?.name ?? null, home: String(msg.app?.home ?? "") };
        peers.add(peer);
        onChange();
      } else if (!peer.app) {
        // Nothing counts before hello.
      } else if (msg.t === "model") {
        peer.model = msg.model ?? null;
        onChange();
      } else if (msg.t === "res") settle(msg);
      else answer(sock, msg, "ui");
    });
    sock.on("close", () => {
      dropPending(sock);
      if (peers.delete(peer)) onChange();
    });
  }

  return {
    start: tryListen,
    isLeader: () => role === "leader",
    /** This app's newest model (null: the mod stopped in the app page). */
    setModel(model) {
      latest = model;
      if (role === "leader") onChange();
      else if (uplink) send(uplink, { t: "model", model });
    },
    /** Leader only: every app's model, this app's first. */
    models() {
      const mine = { app, model: latest };
      return [mine, ...[...peers].map((p) => ({ app: p.app, model: p.model }))].filter((e) => e.model);
    },
    /** Leader only: runs the action in the app that owns the thread. */
    async act(action) {
      if (role !== "leader") throw new Error("Only the app that shows the strip can run actions");
      if (owns(latest, action.ref)) return act(action);
      for (const p of peers) if (owns(p.model, action.ref)) return request(p.sock, { t: "act", action }, `The ${label(p.app)} app`);
      if (!peers.size) return act(action); // one app: let it say what is wrong
      throw new Error("No running app has this thread");
    },
    /** Runs a leader UI method (openInbox, openList), here or in the leader. */
    async ui(method, ...args) {
      if (role === "leader") return ui[method](...args);
      if (!uplink) throw new Error("This app is not connected to the app that shows the strip");
      return request(uplink, { t: "ui", method, args }, "The app that shows the strip");
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const p of peers) p.sock.destroy();
      peers.clear();
      uplink?.destroy();
      server?.close();
      server = uplink = null;
      role = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("The inbox stopped"));
      }
      pending.clear();
    },
  };
}

module.exports = { createHub, endpointFor, PROTOCOL };
