@echo off
cls
echo [1/3] Installing dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail

echo [2/3] Building + packing mcpb/mcp-memory-graphdb.mcpb...
call npm run build -- --mcpb
if errorlevel 1 goto :fail

echo [3/3] Cleaning up node_modules...
if exist node_modules rd /s /q node_modules

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
