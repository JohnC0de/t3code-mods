# No taskkill for exited processes

**Obsolete from T3 Code 0.1.2.** T3's spawner now does this check itself, so the patch reports
`match-missing` and nothing needs it. Uninstall the mod.

On Windows, Effect's child process spawner (inside T3's backend) runs `taskkill /pid <pid> /T /F`
twice for every child that exits with a non-zero code, after the child is already gone. 97% of
those runs exit 128 (process not found). T3 runs git and gh through that spawner, and expected
failures such as `git config --get <unset key>` (exit 1) or `git symbolic-ref
refs/remotes/origin/HEAD` (exit 128) are common. Measured: about 25 taskkills per minute from
the T3 server, each with WMI load.

This mod makes the spawner's `taskkill` helper do nothing when Node already knows the child
exited (`exitCode` or `signalCode` is set). A live child, as in a timeout or an interrupt, still
gets the tree kill, so cancelling a command still stops its grandchildren.

Checked with the real bundle: a command that exits 1 or 128 spawns 0 taskkills (2 before); a live
process with a grandchild, killed through the handle or by closing its scope, spawns 1 and the
whole tree dies (3 and 2 before).

Restart T3 Code to apply. The mod patches the backend's code at load time, and fails safe: if an
update changes the helper, the chunk stays unpatched and `t3mods doctor` shows the state.
