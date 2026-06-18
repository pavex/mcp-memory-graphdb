#!/usr/bin/env bash
set -euo pipefail

echo "[1/3] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/3] Building + packing mcpb/mcp-memory-graphdb.mcpb..."
node build.mjs --mcpb

echo "[3/3] Cleaning up root node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done! Install by double-clicking:"
echo "  mcpb/mcp-memory-graphdb.mcpb"
printf '\a' 2>/dev/null || true
