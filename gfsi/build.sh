#!/bin/sh
# Regenerates the Apps Script includes from src/
{ echo "<script>"; cat src/parsers.js; echo "</script>"; } > apps-script/Parsers.html
{ echo "<script>"; cat src/packet.js; echo "</script>"; } > apps-script/Packet.html
