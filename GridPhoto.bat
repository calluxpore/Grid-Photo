@echo off
rem Launch GridPhoto (Electron). Pass files/folders/.gphl as arguments (or drag them onto this file).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
    echo Installing dependencies...
    call npm install || (echo npm install failed & pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" . %*
