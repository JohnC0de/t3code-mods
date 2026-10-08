// Port of pingdotgg/t3code#15413. `isThreadWorking` (client-runtime threadInbox.ts) keeps a
// thread in the Working section only while its run is active or parked at `idle`, and T3 parks
// at `idle` only for background work that holds completion: subagents and monitors, not
// commands (#14872). So a thread that waits on a background command drops into the inbox.
// The patch counts any live background task, keeps a failed run in the inbox, and leaves
// notifications and auto-settle as they are.
module.exports = [
  {
    id: "working-keeps-background-commands",
    find: ".runtime?.status!==`idle`)return!1;",
    replace: [
      {
        match:
          /if\((\i)\.hasPendingApprovals\|\|\1\.hasPendingUserInput\|\|!(\i)\(\1\.runtime\)&&\1\.runtime\?\.status!==`idle`\)return!1;/,
        replace:
          "if($1.hasPendingApprovals||$1.hasPendingUserInput||$1.runtime?.status===`failed`||" +
          "!$2($1.runtime)&&$1.runtime?.status!==`idle`&&!$1.pendingBackgroundTasks?.length)return!1;",
      },
    ],
  },
];
