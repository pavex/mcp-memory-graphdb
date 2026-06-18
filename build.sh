#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/4] Building dist/mcp.js + copying DuckDB binaries..."
node build.mjs

echo "[3/4] Running tests..."
npm test

echo "[4/4] Cleaning up root node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done! dist/ is self-contained:"
echo "  dist/mcp.js      - bundled MCP server"
echo "  dist/duckdb.node - native DuckDB binding"
echo "  dist/duckdb.so   - DuckDB shared library (Linux/macOS)"
printf '\a' 2>/dev/null || true
