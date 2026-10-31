// Hands the chat timeline's rows to renderer.js `calmRows`, which folds finished turns to a title,
// adds receipts and the "Since you left" card. The edit sits where MessagesTimeline derives its
// rows, after T3 derives them, so T3's streaming fast path keeps working on its own rows.
// It also adds a small store (globalThis.__t3modCalm) that the renderer bumps: the rows then run
// again, so a density switch or a click on a title applies at once. In Full density T3 gets
// "every fold and group is open". Without the mod's renderer the rows pass through.
const STORE =
  "(globalThis.__t3modCalm??=(()=>{let s={v:0,full:!1,all:{has:()=>!0},l:new Set};" +
  "s.sub=f=>(s.l.add(f),()=>s.l.delete(f));s.get=()=>s.v;s.bump=()=>{s.v++;s.l.forEach(f=>f())};return s})())";

const ID = "[A-Za-z_$][\\w$]*";
const re = (r) => new RegExp(r.source.replaceAll("\\i", ID), r.flags);

// Full density opens every run fold and work group: `all` answers yes to every `.has`.
const fullInput = (body, store) =>
  body
    .replace(/(^|,)expandedRunIds:([\w$]+)/, `$1expandedRunIds:${store}.full?${store}.all:$2`)
    .replace(/(^|,)expandedWorkGroupIds:([\w$]+)/, `$1expandedWorkGroupIds:${store}.full?${store}.all:$2`);
const isWorkingOf = (body) => /(?:^|,)isWorking:([\w$]+)/.exec(body)?.[1] ?? "!1";

// 0.1.4: React Compiler output. A hook derives the rows (state, not a memo) and a second one
// keeps them stable: rows=stable(derive(`${threadKey}\0${root}`,{timelineEntries:..},threadKey)).
// The arrow runs during render, so its hooks run every render in the same order:
// the store, T3's derive hook, then a memo that calls calmRows only when its inputs change.
const HOOK_ROWS = re(/(\i)=(\i)\((\i)\(([^,()]+?),\{(timelineEntries:(\i),[^{}]*?latestRun:(\i),[^{}]*?)\}\),(\i)\)/);

function patchHookRows(text, self) {
  const m = HOOK_ROWS.exec(text);
  if (!m) return null;
  const [all, rows, stable, derive, key, body, entries, latestRun, threadKey] = m;
  const R = [...text.slice(0, m.index).matchAll(re(/\(0,(\i)\.use(?:State|Ref|Memo|Effect|Callback)\)/g))].at(-1)?.[1];
  if (!R) return null;
  const memo =
    `(__calmS=>{let __calmV=(0,${R}.useSyncExternalStore)(__calmS.sub,__calmS.get),` +
    `__calmR=${derive}(${key},{${fullInput(body, "__calmS")}});` +
    `return(0,${R}.useMemo)(()=>${self}.calmRows?.(__calmR,{threadKey:${threadKey},entries:${entries},latestRun:${latestRun},isWorking:${isWorkingOf(body)}})??__calmR,` +
    `[__calmR,${threadKey},${entries},${latestRun},${isWorkingOf(body)},__calmV])})(${STORE})`;
  return text.slice(0, m.index) + `${rows}=${stable}(${memo},${threadKey})` + text.slice(m.index + all.length);
}

// 0.1.3: ref=(0,R.useRef)(null),rows=useStableRows((0,R.useMemo)(()=>{let prev=ref.current,
// projection=deriveRowsWithState({timelineEntries:..},reuse);return ref.current={threadKey:..},
// projection.rows},[deps]),threadKey)
const MEMO_ROWS = re(
  /(\i)=\(0,(\i)\.useRef\)\(null\),(\i)=(\i)\(\(0,\2\.useMemo\)\(\(\)=>\{let (\i)=\1\.current,(\i)=(\i)\(\{(timelineEntries:(\i),latestRun:(\i),[^{}]*?)\},([^;]*?)\);return \1\.current=\{threadKey:(\i),([^{}]*?)\},\6\.rows\},\[([^\]]*)\]\)/,
);

function patchMemoRows(text, self) {
  if (!MEMO_ROWS.test(text)) return null;
  return text.replace(MEMO_ROWS, (_all, ref, R, rows, stable, prev, projection, derive, body, entries, latestRun, reuse, threadKey, rest, deps) =>
    `${ref}=(0,${R}.useRef)(null),__calmS=${STORE},__calmV=(0,${R}.useSyncExternalStore)(__calmS.sub,__calmS.get),` +
    `${rows}=${stable}((0,${R}.useMemo)(()=>{let ${prev}=${ref}.current,${projection}=${derive}({${fullInput(body, "__calmS")}},${reuse});` +
    `return ${ref}.current={threadKey:${threadKey},${rest}},` +
    `${self}.calmRows?.(${projection}.rows,{threadKey:${threadKey},entries:${entries},latestRun:${latestRun},isWorking:${isWorkingOf(body)}})??${projection}.rows},` +
    `[${deps},__calmV])`,
  );
}

module.exports = [
  {
    id: "timeline-rows",
    find: "continuesWorkLog:!0",
    transform: (text, { self }) => patchHookRows(text, self) ?? patchMemoRows(text, self) ?? text,
  },
];
