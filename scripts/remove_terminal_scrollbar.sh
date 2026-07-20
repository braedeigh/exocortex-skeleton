#!/bin/bash
# Origin: personal vault scripts/remove_terminal_scrollbar.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Remove the terminal scrollbar gutter completely (run with sudo). Idempotent.
#
# Why: xterm.js reserves 15px of grid width for a scrollbar even when CSS
# hides it (minified bundle: `scrollBarWidth = measured || 15`) — UNLESS
# scrollback is 0, in which case its fit logic reserves exactly 0
# (`scrollback === 0 ? 0 : scrollBarWidth`). tmux owns all scrollback
# (the app's scroll buttons drive tmux copy-mode), so scrollback=0 loses
# nothing.
#
# BUT ttyd applies `-t scrollback=0` *after* the initial fit and only
# refits for font* options — so without a later resize event the grid
# stays 15px narrow forever (phones never resize). The injected <script>
# sets scrollback=0 on the exposed window.term and refits after load.
set -e

# --- ttyd: add scrollback=0 (idempotent; restart only when changed) ---
if ! grep -q 'scrollback=0' /etc/systemd/system/ttyd.service; then
    sed -i 's|-t fontSize=14 -t reconnect=1|-t fontSize=14 -t reconnect=1 -t scrollback=0|' /etc/systemd/system/ttyd.service
    grep -q 'scrollback=0' /etc/systemd/system/ttyd.service || { echo "FAILED to update ttyd.service"; exit 1; }
    systemctl daemon-reload
    systemctl restart ttyd
fi

# --- nginx: hide scrollbars, no background force-paint, post-load refit ---
sed -i "s|sub_filter '</head>'.*|sub_filter '</head>' '<style>html,body{margin:0;height:100%;background:#2b2b2b}.xterm-viewport{scrollbar-width:none!important}.xterm-viewport::-webkit-scrollbar{display:none!important}</style><script>addEventListener(\"load\",()=>{let n=0,iv=setInterval(()=>{const t=window.term;if(t){t.options.scrollback=0;t.fit()}if(++n>=10)clearInterval(iv)},400)})</script></head>';|" /etc/nginx/sites-enabled/exocortex
nginx -t
systemctl reload nginx

echo "DONE — fully kill and reopen the PWA; hard-refresh the desktop page."
