@echo off
rem Run the zcode desktop bridge on the harness's own embedded Node — no
rem system Node.js install required. Locates ZCode.exe in the default
rem per-user install location (override with ZCODE_EXE).
rem Optional: set ZCODE_BRIDGE_API_KEY to require an x-api-key on requests.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "SCRIPT_DIR=%~dp0"
if not defined ZCODE_EXE set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
"%ZCODE_EXE%" "%SCRIPT_DIR%server.cjs" %*
endlocal
