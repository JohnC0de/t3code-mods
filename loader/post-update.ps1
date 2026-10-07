# Reinstalls the T3 Code mod loader after an app update, then relaunches the app.
# Runs as the t3mods-post-update scheduled task, through post-update.cmd:
# - queued by the loader when electron-updater starts the installer (hookUpdaterInstall in
#   t3mods-loader.cjs), which has already dropped --force-run so the installer doesn't launch
#   the app unmodded;
# - at logon and every 15 minutes, when the default install has no loader (an update the
#   loader did not see, or a failed run).
# Install needs the app closed (Windows locks app.asar). When the app is open, a notification
# asks for a restart, and the install runs the moment the app quits, before it can start
# again. The wait ends after a day; the next 15-minute run starts it over, with a reminder.
# Windows PowerShell 5.1 compatible: the task runs System32's powershell.exe.
$log = Join-Path $PSScriptRoot 'post-update.log'
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }
trap { Log "error: $_"; continue }

# A Windows notification under the app's own name, so the user knows why mods are missing.
function Notify($title, $text) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text/><text/></binding></visual></toast>")
    $lines = $xml.GetElementsByTagName('text')
    $lines.Item(0).InnerText = $title
    $lines.Item(1).InnerText = $text
    $app = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'T3 Code*' } | Select-Object -First 1
    $id = if ($app) { $app.AppID } else { '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch { Log "notification failed: $_" }
}

$requestFile = Join-Path $PSScriptRoot 'post-update.request.json'
if (Test-Path $requestFile) {
  $request = Get-Content $requestFile -Raw | ConvertFrom-Json
  Remove-Item $requestFile
} else {
  $appDir = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
  $res = Join-Path $appDir 'resources'
  if ((Test-Path "$res\app\index.cjs") -and -not (Test-Path "$res\app.asar")) { exit 0 }
  $exe = Get-ChildItem $appDir -Filter 'T3 Code*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { Log 'no pending request and no app found'; exit 0 }
  Log 'loader missing; repairing'
  $request = [pscustomobject]@{ exe = $exe.FullName; installer = ''; relaunch = $false; env = $null; pid = 0 }
}

$installerPath = ([string]$request.installer).ToLower()
$updaterPrefix = (Join-Path $env:LOCALAPPDATA 't3code-updater').ToLower() + '\'
function InstallerRunning {
  # @() around the pipeline: PowerShell 5.1 has no .Count on a single CIM object.
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $p = "$($_.ExecutablePath)".ToLower()
      $p -and ($p.StartsWith($updaterPrefix) -or $p -eq $installerPath)
    }).Count -gt 0
}
# 'open': the app holds app.asar, so an exclusive open fails. That is the exact test for the
# rename that install does; a process scan is not: a helper process from the app folder can
# outlive the app without holding the file.
# 'updating': an update installer runs, or the app folder has no bundle. Without the loader
# the app's own updater still installs a pending update when the app quits, and that
# installer moves the whole folder away first.
$res = Join-Path (Split-Path $request.exe) 'resources'
function Check {
  if (Test-Path "$res\app.asar") {
    try { [IO.File]::Open("$res\app.asar", 'Open', 'Read', 'None').Dispose() } catch { return 'open' }
  } elseif (-not (Test-Path "$res\_app.asar")) { return 'updating' }
  if (InstallerRunning) { return 'updating' }
  'ready'
}

# electron-builder keeps the install folder in <HKCU or HKLM>\Software\<app guid>\InstallLocation.
function InstalledExe($name) {
  foreach ($root in 'HKCU:\Software', 'HKLM:\Software') {
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $dir = (Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue).InstallLocation
      if ($dir -and (Test-Path -LiteralPath (Join-Path $dir $name))) { return (Join-Path $dir $name) }
    }
  }
  $null
}

Log "started (installer=$($request.installer), relaunch=$($request.relaunch))"
if ($request.installer) {
  # The app starts the installer and quits; the installer then replaces the app folder. Wait
  # for both. An app the user opens again meanwhile does not matter.
  $deadline = (Get-Date).AddMinutes(30)
  if ($request.pid) {
    while (Get-Process -Id $request.pid -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) { Log 'gave up: the app did not quit for the update'; exit 1 }
      Start-Sleep -Milliseconds 500
    }
  } else {
    # A loader from before 0.3.0 sends no pid: give the installer time to start.
    $appear = (Get-Date).AddSeconds(30)
    while (-not (InstallerRunning) -and (Get-Date) -lt $appear) { Start-Sleep -Milliseconds 500 }
  }
  while (InstallerRunning) {
    if ((Get-Date) -gt $deadline) { Log 'gave up: the installer still runs after 30 minutes'; exit 1 }
    Start-Sleep -Seconds 1
  }
  # The installer writes to the app's registered folder, not to the folder of the exe that
  # started the update: an update started from a copy of the app updates the installed app.
  $installed = InstalledExe (Split-Path $request.exe -Leaf)
  if ($installed -and $installed -ne $request.exe) {
    Log "the installer updated $(Split-Path $installed), not $(Split-Path $request.exe); installing there"
    $request.exe = $installed
    $res = Join-Path (Split-Path $installed) 'resources'
  }
}

# The new build's own exe runs the CLI as Node, so no separate Node install is needed.
function Install {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:T3MODS_POST_UPDATE = '1'
  $out = & $request.exe (Join-Path $PSScriptRoot 't3mods.mjs') install --app (Split-Path $request.exe) 2>&1 | Out-String
  $script:code = $LASTEXITCODE
  Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:T3MODS_POST_UPDATE
  Log "install (exit $code): $($out.Trim())"
  $code -eq 0
}

# Installs once the app quits and no installer runs. The check runs twice a second, so the
# install (under a second) usually beats a restart; a lost race waits for the next quit.
$waited = $false
$until = (Get-Date).AddHours(24)
while ($true) {
  $state = Check
  if ($state -eq 'ready') {
    if (Install) { break }
    if ((Check) -eq 'ready') {
      Notify 'T3 Code mods are off' "Reinstall failed. Run: node ~/.t3/t3mods/t3mods.mjs install. Log: $log"
      exit 1
    }
    continue
  }
  if ($state -eq 'open' -and -not $waited) {
    Log 'app is open; installing when it quits'
    Notify 'T3 Code mods are off' 'T3 Code was updated. Restart it to turn the mods back on.'
    $waited = $true
  }
  if ((Get-Date) -gt $until) { Log 'app still open after 24 hours; the next check starts over'; exit 0 }
  Start-Sleep -Milliseconds 500
}

# Starts the app through WMI so it has no console parent. Started from here, it would attach
# to this task's console and keep the task running until the app exits, which blocks the
# next update's run. The environment list replaces the new process's whole environment.
function Start-Detached($exe) {
  $vars = [string[]](Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $vars }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$exe`""; CurrentDirectory = (Split-Path $exe); ProcessStartupInformation = $startup
  }
  if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
}

# The user closed an app they had opened themselves: that quit was on purpose.
if ($request.relaunch -and -not $waited) {
  foreach ($var in $request.env.PSObject.Properties) { Set-Item "Env:$($var.Name)" $var.Value }
  Start-Detached $request.exe
  Log 'relaunched'
}
