#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] Installing dependencies..."
npm ci --no-audit --no-fund

echo "[2/4] Typecheck + building dist/..."
npm run build

echo "[3/4] Running tests..."
npm run test:run

echo "[4/4] Cleaning up node_modules..."
rm -rf node_modules

echo ""
echo "Done! dist/ is self-contained:"
echo "  dist/mcp.js              - bundled MCP server"
echo "  dist/duckdb.node         - native DuckDB binding"
echo "  dist/libduckdb.*         - DuckDB shared library (.so on Linux, .dylib on macOS)"
echo "  dist/schema.default.yaml - the schema a new database starts with"
echo "  dist/config.example.json - config template"
printf '\a' 2>/dev/null || true
