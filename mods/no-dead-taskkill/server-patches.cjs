// Effect's NodeChildProcessSpawner runs `taskkill /pid <pid> /T /F` on Windows whenever a child
// exits with a non-zero code: once from the child's "exit" listener and once from the scope
// finalizer. The child is already gone by then, so 97% of those runs exit 128 (process not
// found). T3 runs git and gh through this spawner, and expected failures such as
// `git config --get <unset key>` (1) or `git symbolic-ref refs/remotes/origin/HEAD` (128) cost
// two taskkill processes plus WMI load each, about 25 per minute.
//
// Fix: the shared `taskkill` helper does nothing when Node already knows the child has exited
// (exitCode or signalCode is set; Node sets them before it emits "exit"). A live child, as in a
// timeout or an interrupt, still gets the tree kill. The helper still calls its callback, so the
// spawner's flow does not change.
//
// Fail safe: if the helper's shape changes in a T3 update, the patch fails, the chunk stays
// unpatched and the loader logs it; `t3mods doctor` shows the state.

/** @type {import("../../loader/types/t3mods").ServerPatch[]} */
module.exports = [
  {
    id: "skip-taskkill-for-exited-child",
    find: '"taskkill", [',
    replace: [
      {
        match:
          /const (\i) = \((\i), (\i) = \(\) => \{\}\) => (\i)\.execFile\("taskkill", \[\s*"\/pid",\s*String\(\2\.pid\),\s*"\/T",\s*"\/F"\s*\], \{ windowsHide: true \}, \3\);/,
        replace: (_, fn, cp, onExit, mod) =>
          `const ${fn} = (${cp}, ${onExit} = () => {}) => {` +
          ` if (${cp}.exitCode !== null || ${cp}.signalCode !== null) { ${onExit}(null); return; }` +
          ` return ${mod}.execFile("taskkill", ["/pid", String(${cp}.pid), "/T", "/F"], { windowsHide: true }, ${onExit});` +
          ` };`,
      },
    ],
  },
];
