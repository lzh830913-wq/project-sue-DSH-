@echo off
rem jingwen-dev instance (DSH dev mode) on port 3080
rem DSH 0.1.1-rc.2, DSH_HOME = default (C:\Users\lzh_6\.dsh)
rem
rem 2026-09-27 fix: this launcher used to point at the OLD 0.1.0-rc.6 cache
rem (1e7f6d9597241db0), whose dsh-llm-deepseek hardcodes inputModalities to
rem ["text"] and whose schema drops that field -- image input was rejected
rem forever. The 0.1.1-rc.2 cache (de4831d60afe10da) supports images fully.
rem ROLLBACK: point the node path below back at 1e7f6d9597241db0.
rem
rem NOTE: keep this file PURE ASCII. cmd.exe reads .bat with the OEM code page
rem (GBK here), so non-ASCII comments get mangled and echoed as bogus commands.
rem double-click to start; close this window to stop

node "C:\Users\lzh_6\AppData\Local\npm-cache\_npx\de4831d60afe10da\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080
