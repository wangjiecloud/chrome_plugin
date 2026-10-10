#!/bin/bash

# Chrome 插件自动打包脚本
# 用途：清理、打包插件，生成可分发的 .zip 文件

set -e  # 遇到错误立即退出

echo "🚀 开始打包 Chrome 插件..."

# 切换到插件目录
cd "$(dirname "$0")"

# 清理不需要打包的文件
echo "🧹 清理测试和文档文件..."
rm -f _*.py test_*.py gen_*.py *.md

# 清理旧的发布文件
echo "🧹 清理旧的发布文件..."
rm -rf ../chrome_plugin_release
rm -f ../chrome_plugin_v*.zip

# 创建发布目录
echo "📁 创建发布目录..."
mkdir -p ../chrome_plugin_release

# 复制必要文件
echo "📋 复制文件..."
cp manifest.json ../chrome_plugin_release/
cp background.js ../chrome_plugin_release/
cp popup.html ../chrome_plugin_release/
cp popup.css ../chrome_plugin_release/
cp popup.js ../chrome_plugin_release/
cp chart.js ../chrome_plugin_release/

# 复制图标文件夹
echo "🖼️  复制图标..."
cp -r icons ../chrome_plugin_release/

# 获取版本号
VERSION=$(grep '"version"' manifest.json | sed -E 's/.*"version": "(.*)".*/\1/')

# 打包成 zip
echo "📦 打包中..."
cd ../
zip -rq "chrome_plugin_v${VERSION}.zip" chrome_plugin_release/

# 输出结果
echo ""
echo "✅ 打包完成！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 文件名: chrome_plugin_v${VERSION}.zip"
echo "📂 位置: $(pwd)/chrome_plugin_v${VERSION}.zip"
echo "📊 大小: $(du -h chrome_plugin_v${VERSION}.zip | cut -f1)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎯 接下来的步骤："
echo "  1. 打开 chrome://extensions/"
echo "  2. 启用「开发者模式」"
echo "  3. 拖入 .zip 文件安装"
echo "  或者"
echo "  1. 将 .zip 文件解压"
echo "  2. 点击「加载已解压的扩展程序」"
echo "  3. 选择解压后的文件夹"
echo ""
