#!/bin/bash

# 快速在 Chrome 中打开插件管理页面

echo "🚀 正在打开 Chrome 扩展管理页面..."
open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || \
open -a "Google Chrome Beta" "chrome://extensions/" 2>/dev/null || \
open -a "Chromium" "chrome://extensions/" 2>/dev/null || \
echo "❌ 未找到 Chrome 浏览器，请手动打开 chrome://extensions/"

echo ""
echo "📋 接下来的步骤："
echo "  1. 启用右上角的「开发者模式」"
echo "  2. 点击「加载已解压的扩展程序」"
echo "  3. 选择文件夹："
echo "     /Users/wangjie494/codespace/self/SuperJAI/projects/chrome_plugin"
echo ""
echo "或者："
echo "  1. 解压 chrome_plugin_v1.0.0.zip"
echo "  2. 将解压后的文件夹拖入 Chrome 扩展页面"
echo ""
