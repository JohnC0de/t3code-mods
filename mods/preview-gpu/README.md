# Preview on the GPU

T3's preview browser starts with `--disable-gpu`, so Chrome draws WebGL pages on the CPU
(SwiftShader). When an agent opens a three.js game or a WebGL demo in a preview tab, the
`chrome-headless-shell.exe` processes take every CPU core while the tab is open.

This mod starts that browser with `--use-angle=d3d11` on Windows, so it draws on the graphics
card. Measured with T3's own headless shell (Chrome 154) and a full-screen WebGL page at T3's
2x scale on an RTX 5080:

| | CPU | Frames per second |
|---|---|---|
| T3 as shipped | about 15 cores | 14 |
| With this mod | 0.13 of a core | 88 |

Screenshots, recordings and the live view work as before. A machine without a usable GPU falls
back to software drawing, as before. Other platforms keep `--disable-gpu`.

The html_preview / html_render renderer is a separate, short-lived browser and is not changed.

Restart T3 Code to apply. The mod patches the backend's code at load time, so a T3 Code update
can break it; `t3mods doctor` shows the state.
