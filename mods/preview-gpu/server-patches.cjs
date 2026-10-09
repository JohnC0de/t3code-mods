// T3's preview browser (agent and human tabs in the server's headless shell) starts with
// --disable-gpu, so Chrome draws WebGL with SwiftShader on the CPU. A three.js page then uses
// every core. On Windows, --use-angle=d3d11 puts it on the graphics card: a full-screen WebGL
// page went from about 15 cores to 0.1 of a core, and from 14 to 88 frames per second.
// Without the flag, headless Chrome stays on SwiftShader even when --disable-gpu is gone.
// Other platforms keep --disable-gpu; they are untested. Without a usable GPU, Chrome falls
// back to software drawing, as before.
//
// The html_preview / html_render renderer is a second browser with its own --disable-gpu; it gets
// the same flag, so canvas and WebGL in a rendered page draw on the GPU too.
const GPU_FLAG = `(process.platform === "win32" ? "--use-angle=d3d11" : "--disable-gpu")`;

/** @type {import("../../loader/types/t3mods").ServerPatch[]} */
module.exports = [
  {
    id: "preview-browser-gpu",
    find: '"--force-device-scale-factor=2"',
    replace: [
      {
        match: /args: \["--disable-gpu", "--force-device-scale-factor=2"\]/,
        replace: () => `args: [${GPU_FLAG}, "--force-device-scale-factor=2"]`,
      },
    ],
  },
  {
    id: "html-render-gpu",
    find: '"--block-new-web-contents"',
    replace: [
      {
        match: /"--no-default-browser-check",(\s*)"--disable-gpu",(\s*)"--hide-scrollbars",/,
        replace: (_, a, b) => `"--no-default-browser-check",${a}${GPU_FLAG},${b}"--hide-scrollbars",`,
      },
    ],
  },
];
