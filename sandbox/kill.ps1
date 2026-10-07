# Stop only the sandbox copy of T3 Code (sandbox/app), never the live install.
$app = (Join-Path $PSScriptRoot 'app').ToLower() + '\'
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($app) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# A sandbox boot registers the t3code:// handler to the sandbox exe; point it back.
$live = Get-ChildItem "$env:LOCALAPPDATA\Programs\t3code" -Filter 'T3 Code*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($live) { Set-Item -Path 'HKCU:\Software\Classes\t3code\shell\open\command' -Value "`"$($live.FullName)`" `"%1`"" }
