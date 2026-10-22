#!/bin/sh
# Renders banner.html to banner.png (2560×800)
cd "$(dirname "$0")" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 --window-size=1280,400 --virtual-time-budget=2000 --screenshot="$PWD/banner.png" "file://$PWD/banner.html"
