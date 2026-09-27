@echo off
rem jingwen-dev instance (DSH dev mode) on port 3080
rem DSH 0.1.1-rc.2, DSH_HOME = default (C:\Users\lzh_6\.dsh)
rem 2026-09-27 修正：原来的路径指向 0.1.0-rc.6 缓存（1e7f6d9597241db0），该版本的
rem dsh-llm-deepseek 把 inputModalities 硬编码为 ["text"]、schema 也不认这个字段，
rem 导致收图永远被拒；0.1.1-rc.2 起适配器完整支持（含 imagePixelBudget/imageMaxBytes）。
rem 两个缓存都在本机，改回 1e7f6d9597241db0 即可回滚。
rem double-click to start; close this window to stop
node "C:\Users\lzh_6\AppData\Local\npm-cache\_npx\de4831d60afe10da\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080
