#!/bin/bash
# First-time setup script for sitemgr development environment
# Requires: Node.js 20+, npm

set -e

echo "================================================"
echo "  sitemgr Development Environment Setup"
echo "================================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js not found"
    echo ""
    echo "Install Node.js 20+:"
    echo "  https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "Error: Node.js 20+ required (found $(node -v))"
    exit 1
fi

echo "Found Node.js $(node -v)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm not found"
    exit 1
fi

echo "Found npm $(npm -v)"

# Install web dependencies
echo ""
echo "Installing web dependencies..."
cd web
npm install
cd ..

echo ""
echo "================================================"
echo "  Setup Complete"
echo "================================================"
echo ""
echo "Next steps:"
echo ""
echo "1. Start Supabase and configure environment:"
echo "   ./scripts/local-dev.sh"
echo ""
echo "2. Run the CLI:"
echo "   cd web && npm run smgr stats"
echo ""
echo "3. Run tests:"
echo "   cd web && npm test"
echo ""
