#!/usr/bin/env bash

echo "=== GLOBAL LSP HEALTH CHECK ==="

check() {
    if command -v "$1" >/dev/null 2>&1; then
        echo "[OK]   $1 → $(command -v "$1")"
    else
        echo "[MISS] $1"
    fi
}

echo
echo "Python:"
check pylsp
check pyright
check ruff        # ruff server is invoked as: ruff server

echo
echo "JavaScript / TypeScript:"
check typescript-language-server
check tsserver

echo
echo "Bash:"
check bash-language-server

echo
echo "Rust:"
check rust-analyzer

echo
echo "Go:"
check gopls

echo
echo "PHP:"
check intelephense

echo
echo "Vue (Volar):"
check vue-language-server

echo
echo "Svelte:"
check svelte-language-server

echo
echo "Tailwind:"
check tailwindcss-language-server

echo
echo "=== DONE ==="
