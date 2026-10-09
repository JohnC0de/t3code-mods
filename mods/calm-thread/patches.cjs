// Hands the chat timeline's rows to renderer.js `calmRows`, which folds finished turns to a title,
// adds receipts and the "Since you left" card. The edit sits in MessagesTimeline's rows memo,
// after T3 derives its rows, so T3's streaming fast path keeps working on its own rows.
// It also adds a small store (globalThis.__t3modCalm) that the renderer bumps: the memo then runs
// again, so a density switch or a click on a title applies at once. In Full density the memo
// passes "every fold and group is open" to T3. Without the mod's renderer the rows pass through.
const STORE =
  "(globalThis.__t3modCalm??=(()=>{let s={v:0,full:!1,all:{has:()=>!0},l:new Set};" +
  "s.sub=f=>(s.l.add(f),()=>s.l.delete(f));s.get=()=>s.v;s.bump=()=>{s.v++;s.l.forEach(f=>f())};return s})())";

module.exports = [
  {
    id: "timeline-rows",
    find: "continuesWorkLog:!0",
    replace: [
      {
        // ref=(0,R.useRef)(null),rows=useStableRows((0,R.useMemo)(()=>{let prev=ref.current,
        // projection=deriveRowsWithState({timelineEntries:..},reuse);return ref.current={threadKey:..},
        // projection.rows},[deps]),threadKey)
        match:
          /(\i)=\(0,(\i)\.useRef\)\(null\),(\i)=(\i)\(\(0,\2\.useMemo\)\(\(\)=>\{let (\i)=\1\.current,(\i)=(\i)\(\{(timelineEntries:(\i),latestRun:(\i),[^{}]*?)\},([^;]*?)\);return \1\.current=\{threadKey:(\i),([^{}]*?)\},\6\.rows\},\[([^\]]*)\]\)/,
        replace: (_all, ref, R, rows, stable, prev, projection, derive, body, entries, latestRun, reuse, threadKey, rest, deps) => {
          const isWorking = /(?:^|,)isWorking:(\w+)/.exec(body)?.[1] ?? "!1";
          const input = body
            .replace(/(^|,)expandedRunIds:(\w+)/, "$1expandedRunIds:__calmS.full?__calmS.all:$2")
            .replace(/(^|,)expandedWorkGroupIds:(\w+)/, "$1expandedWorkGroupIds:__calmS.full?__calmS.all:$2");
          return (
            `${ref}=(0,${R}.useRef)(null),__calmS=${STORE},__calmV=(0,${R}.useSyncExternalStore)(__calmS.sub,__calmS.get),` +
            `${rows}=${stable}((0,${R}.useMemo)(()=>{let ${prev}=${ref}.current,${projection}=${derive}({${input}},${reuse});` +
            `return ${ref}.current={threadKey:${threadKey},${rest}},` +
            `$self.calmRows?.(${projection}.rows,{threadKey:${threadKey},entries:${entries},latestRun:${latestRun},isWorking:${isWorking}})??${projection}.rows},` +
            `[${deps},__calmV])`
          );
        },
      },
    ],
  },
];
