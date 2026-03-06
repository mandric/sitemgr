#!/bin/bash
# First-time setup script for sitemgr development environment
# Requires: uv (https://docs.astral.sh/uv/)

set -e

echo "================================================"
echo "  sitemgr Development Environment Setup"
echo "================================================"
echo ""

# Check for uv
if ! command -v uv &> /dev/null; then
    echo "❌ uv not found"
    echo ""
    echo "Install uv first:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo ""
    echo "Or visit: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
fi

echo "✓ Found uv"

# Create virtual environment
if [ ! -d ".venv" ]; then
    echo ""
    echo "Creating Python virtual environment..."
    uv venv
    echo "✓ Virtual environment created at .venv/"
else
    echo "✓ Virtual environment already exists"
fi

# Install dependencies
echo ""
echo "Installing Python dependencies..."
source .venv/bin/activate
uv pip install -r prototype/requirements.txt

echo ""
echo "================================================"
echo "  ✅ Setup Complete"
echo "================================================"
echo ""
echo "Next steps:"
echo ""
echo "1. Activate the virtual environment:"
echo "   source .venv/bin/activate"
echo ""
echo "2. Start Supabase and configure environment:"
echo "   ./scripts/local-dev.sh"
echo ""
echo "3. Run integration tests:"
echo "   ./tests/integration_test.sh"
echo ""
echo "4. Start developing!"
echo ""
