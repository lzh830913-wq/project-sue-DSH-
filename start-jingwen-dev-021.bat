@echo off
rem jingwen-dev instance (DSH dev mode) on port 3080
rem DSH 0.2.1-rc.2 - upgraded 2026-11-11 from 0.1.1-rc.2
rem (old cache de4831d60afe10da kept untouched as rollback; full .dsh backup in
rem  I:\PJ sue\backup dir dsh-3080-20261111 - restore patch there before rollback)
rem
rem Runtime is a private copy of the proven 3081 runtime (offline, no npx fetch).
rem
rem TEMP pinned to a fixed dir: the system cleaner deletes stale %TEMP% dirs and
rem DSH never recreates its temp root (learned 2026-09-18; same pattern as the
rem 3081 launcher in I:\SUE test, see its .cmd for the original).
set "TEMP=C:\Users\lzh_6\dsh-temp"
set "TMP=C:\Users\lzh_6\dsh-temp"
if not exist "%TEMP%" mkdir "%TEMP%"

set "DSH_RUNTIME=C:\Users\lzh_6\.dsh\dsh-runtime-021\node_modules\@deepseek-ai\dsh\lib\bin.js"
node "%DSH_RUNTIME%" web --port 3080

echo.
echo   DSH exited with code %ERRORLEVEL%.
pause
