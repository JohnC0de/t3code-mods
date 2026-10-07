# Security

## Trust model

- **Mods run with full trust.** A mod can read your files, run commands and see everything in
  T3 Code, the same as a Vencord or BetterDiscord plugin. Install only mods that you read or
  trust.
- The loader does not weaken the app's Content Security Policy. Mod code loads from the
  app's own origin, and `eval` stays blocked.
- The backend bridge (`api.server()`) listens on `127.0.0.1` and needs a random token per run.
- On Linux, root-owned files (the shim in the app folder and the package-manager hook) never
  run code from your home folder as root. The shim runs as your user, inside the app.
- `t3mods add` and the Mods page refuse archives with unsafe paths, and record the sha256 of
  each archive.

## Supported versions

Only the latest commit on `main` gets fixes.

## Report a vulnerability

Do not open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/JohnC0de/t3code-mods/security/advisories/new).
Include the steps to reproduce, the impact and your OS. You get an answer within 7 days.

Vulnerabilities in T3 Code itself go to the [T3 Code repository](https://github.com/pingdotgg/t3code).
