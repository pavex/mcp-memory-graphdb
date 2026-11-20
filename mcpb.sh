#!/usr/bin/env bash
set -euo pipefail

echo "[1/3] Installing dependencies..."
npm ci --no-audit --no-fund

echo "[2/3] Building + packing mcpb/mcp-memory-graphdb.mcpb..."
npm run build -- --mcpb

echo "[3/3] Cleaning up node_modules..."
rm -rf node_modules

echo ""
echo "Done! Install by double-clicking:"
echo "  mcpb/mcp-memory-graphdb.mcpb"
printf '\a' 2>/dev/null || true
