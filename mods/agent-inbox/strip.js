import { rpc, h, where } from "./shared.js";

const wrap = document.getElementById("wrap");
const TRAY =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l2.2-7h11.6L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5zm0 0h4.5a3.5 3.5 0 0 0 7 0H20"/></svg>';

let signature = "";
let lastSize = "";
let hoverTimer = 0;
let leaveTimer = 0;
let gripDown = false;

const call = (method, ...args) => rpc(method, ...args).catch((e) => console.warn(`${method}:`, e.message));

function render(model) {
  if (model.strip === false) {
    wrap.hidden = true;
    signature = "hide";
    return;
  }
  const sig = JSON.stringify([model.dots, model.counts, model.overflow, model.cards.map((c) => c.kind)]);
  if (sig === signature && !wrap.hidden) return;
  signature = sig;

  const badgeCount = model.counts.attention + model.cards.filter((c) => c.kind === "done").length;
  const inbox = h(
    "button",
    {
      class: "inbtn",
      type: "button",
      title: "Open inbox",
      "aria-label": badgeCount ? `Open inbox, ${badgeCount} waiting` : "Open inbox",
      onclick: () => call("openInbox", {}),
    },
    badgeCount ? h("span", { class: `badge${model.counts.attention ? "" : " calm"}`, "aria-hidden": "true" }, String(badgeCount)) : null,
  );
  inbox.insertAdjacentHTML("afterbegin", TRAY); // static markup, no agent text

  const dots = model.dots.map((d) => {
    const btn = h(
      "button",
      {
        class: `dotbtn${d.unread ? " unread" : ""}`,
        type: "button",
        "aria-label": `${d.title}, ${where(d)}`,
        title: d.app ? where(d) : null,
        onclick: () => {
          clearTimeout(hoverTimer);
          call("openInbox", { threadKey: d.threadKey });
        },
        onpointerenter: () => {
          clearTimeout(leaveTimer);
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => {
            const r = btn.getBoundingClientRect();
            call("peek", { threadKey: d.threadKey, y: window.screenY + r.top + r.height / 2 });
          }, 250);
        },
        onpointerleave: () => clearTimeout(hoverTimer),
      },
      h("span", { class: "sd", "data-status": d.status }),
    );
    return btn;
  });

  const grip = h("div", { class: "grip", "aria-hidden": "true", onpointerdown: () => (gripDown = true) }, h("i"), h("i"));
  const pill = h(
    "div",
    { class: "pill", onpointerleave: () => {
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => call("unpeek"), 200);
    } },
    inbox,
    ...dots,
    model.overflow > 0 ? h("div", { class: "more", title: `${model.overflow} more` }, `+${model.overflow}`) : null,
    grip,
  );
  wrap.replaceChildren(pill);
  wrap.hidden = false;

  const r = wrap.getBoundingClientRect();
  const size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  const key = `${size.width}x${size.height}`;
  if (key !== lastSize) {
    lastSize = key;
    call("fit", size);
  }
}

function endDrag() {
  if (!gripDown) return;
  gripDown = false;
  call("dragEnd");
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

window.inbox = { update: render };

rpc("state")
  .then((m) => m && render(m))
  .catch((e) => console.warn("state:", e.message));
