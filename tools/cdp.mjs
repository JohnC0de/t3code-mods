// Tiny CDP helper for a dev, sandbox or test app (port: CDP_PORT, default 9333):
//   node tools/cdp.mjs eval "<expr>"   |   node tools/cdp.mjs shot out.png
// Exits non-zero when the page closes or does not answer within 30 s.
import fs from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "9333";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("t3code://app") && !t.url.includes("/__mods/"));
if (!page) throw new Error(`no T3 Code page on CDP port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
setTimeout(() => fail("no answer from the page within 30 s"), 30_000).unref();
ws.onclose = () => fail("the page closed before it answered");
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
};
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => (ws.onopen = r));
if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.exceptionDetails ? r.result.exceptionDetails : r.result?.result?.value, null, 1));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
}
ws.onclose = null;
ws.close();
