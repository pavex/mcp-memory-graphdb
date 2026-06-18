@echo off
cls
echo [1/3] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

echo [2/3] Building + packing mcpb/mcp-memory-graphdb.mcpb...
call node build.mjs --mcpb
if errorlevel 1 goto :fail

echo [3/3] Cleaning up root node_modules...
if exist node_modules rd /s /q node_modules
if exist package-lock.json del /f /q package-lock.json

echo.
echo Done! Install by double-clicking:
echo   mcpb\mcp-memory-graphdb.mcpb
powershell -c "[console]::beep(1000,200)"
exit /b 0

:fail
echo.
echo MCPB BUILD FAILED
powershell -c "[console]::beep(400,500)"
exit /b 1
