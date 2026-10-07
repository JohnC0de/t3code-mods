@echo off
rem Action of the t3mods-post-update scheduled task. Starts post-update.ps1 only when there is
rem work: an update request from the loader, or a default install without the loader (its
rem app.asar is renamed once the loader is in). The task also runs at logon and every 15
rem minutes, so most runs end here.
if exist "%~dp0post-update.request.json" goto run
if not exist "%LOCALAPPDATA%\Programs\t3code\resources\app.asar" exit /b 0
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0post-update.ps1"
