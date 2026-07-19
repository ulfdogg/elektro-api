#!/bin/bash
# Bereitet den Web-Inhalt für die Offline-APK vor.
# Kopiert public/ → www/ und setzt OFFLINE_APP = true.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$SCRIPT_DIR/../public"
WWW="$SCRIPT_DIR/www"

echo "→ Erstelle www/ aus public/ ..."
rm -rf "$WWW"
cp -r "$PUBLIC" "$WWW"

echo "→ Setze OFFLINE_APP = true ..."
sed -i 's/const OFFLINE_APP = false/const OFFLINE_APP = true/' "$WWW/index.html"
sed -i 's/const OFFLINE_APP = false/const OFFLINE_APP = true/' "$WWW/logo-editor.html"

# Capacitor-Bridge einbinden (wird von npx cap sync hinzugefügt,
# aber wir stellen sicher dass der Platzhalter korrekt ist)
echo "→ www/ bereit ($(find "$WWW" -type f | wc -l) Dateien)"
