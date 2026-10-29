#!/bin/sh
# Builds index.html (the website) from src/page.html, and the Chrome extension from the same source.
# Usage: sh tools/build.sh   (run from the repo root)
set -e
WRAP='<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
{ printf "$WRAP"; cat src/page.html; printf '\n</body>\n</html>\n'; } > index.html
mkdir -p .build && cp src/page.html .build/sticky-desk.html
python3 tools/build-ext.py .build .
rm -rf .build/ext && mkdir -p .build/ext && cp -r extension .build/ext/sticky-desk && rm -f .build/ext/sticky-desk/README.md
rm -f sticky-desk-chrome.zip && (cd .build/ext && zip -qr ../../sticky-desk-chrome.zip sticky-desk)
echo "built index.html, extension/ and sticky-desk-chrome.zip"
