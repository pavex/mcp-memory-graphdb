@echo off
cls
echo [1/4] Installing dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail

echo [2/4] Typecheck + building dist/...
call npm run build
if errorlevel 1 goto :fail

echo [3/4] Running tests...
call npm run test:run
if errorlevel 1 goto :fail

echo [4/4] Cleaning up node_modules...
if exist node_modules rd /s /q node_modules

echo.
echo Done! dist/ is self-contained:
echo   dist/mcp.js              - bundled MCP server
echo   dist/duckdb.node         - native DuckDB binding
echo   dist/duckdb.dll          - DuckDB shared library (Windows)
echo   dist/schema.default.yaml - the schema a new database starts with
echo   dist/config.example.json - config template
powershell -c "[console]::beep(1000,200)"
exit /b 0

:fail
echo.
echo BUILD FAILED
powershell -c "[console]::beep(400,500)"
exit /b 1
