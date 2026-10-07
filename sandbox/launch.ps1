# Launch the sandbox copy of T3 Code (sandbox/app) with the loader from this checkout and its
# own APPDATA and T3CODE_HOME, so the live install and its data stay untouched.
# Set up once: copy the installed app to sandbox/app, then
#   node loader/t3mods.mjs install --app sandbox/app
# Stop it with sandbox/kill.ps1. CDP listens on -Port (tools/e2e.mjs --port).
param([string]$Mods = (Join-Path $PSScriptRoot '..\examples'), [int]$Port = 9333)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe = Get-ChildItem (Join-Path $PSScriptRoot 'app') -Filter 'T3 Code*.exe' -ErrorAction Stop | Select-Object -First 1
if (-not $exe) { throw 'no app in sandbox/app; see the setup note at the top of this script' }
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:APPDATA = Join-Path $PSScriptRoot 'appdata'
$env:T3CODE_HOME = Join-Path $PSScriptRoot 'home'
$env:T3CODE_DISABLE_AUTO_UPDATE = '1'
$env:T3MODS_LOADER = Join-Path $root 'loader\t3mods-loader.cjs'
$env:T3MODS_DIR = (Resolve-Path $Mods).Path
Start-Process -FilePath $exe.FullName -ArgumentList "--remote-debugging-port=$Port"
