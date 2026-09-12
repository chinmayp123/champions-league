@echo off
rem Futbol Lab launcher — double-click to open the widget (no terminal window stays open).
rem Uses the local Electron binary directly so npm isn't required at launch time.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0widget\main.cjs"
