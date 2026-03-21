#!/bin/bash
# BauDiktat → Azure App Service deployen
#
# Nutzung:
#   bash deploy.sh          → Schnell-Deploy (nur Code, ~3 MB)
#   bash deploy.sh --full   → Voll-Deploy (mit node_modules, ~26 MB)

set -e

AZ="C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd"

if [ "$1" = "--full" ]; then
  echo "📦 Voll-Deploy (mit node_modules)..."
  npx bestzip deploy.zip package.json package-lock.json .deployment backend/ pwa/ node_modules/
else
  echo "⚡ Schnell-Deploy (nur Code)..."
  npx bestzip deploy.zip package.json package-lock.json .deployment backend/ pwa/
fi

echo "🚀 Deploy zu Azure..."
"$AZ" webapp deploy --name baudiktat --resource-group baudiktat-rg --src-path deploy.zip --type zip --timeout 300

rm -f deploy.zip

echo "✅ Fertig! https://baudiktat.azurewebsites.net"
