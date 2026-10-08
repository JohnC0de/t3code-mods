// Turns an html_preview or html_render input with `path` into one with `html`, the shape T3's
// own handlers take. server-patches.cjs puts the source text of readHtmlInput into the
// backend, so the function may use only its arguments and globals.
"use strict";

/**
 * @param {{ html?: string, path?: string }} input the tool input after T3 decoded it
 * @param {{ fs: typeof import("node:fs"), path: typeof import("node:path"), os: typeof import("node:os"), url: typeof import("node:url"), platform: string }} sys
 * @returns {{ input: object } | { error: string }}
 */
function readHtmlInput(input, sys) {
  const MAX_BYTES = 25 * 1024 * 1024; // T3's limit for a page with its images inlined
  const HTML_FILE = /\.html?$/i;
  const hasHtml = input.html !== undefined;
  const hasPath = input.path !== undefined;
  if (hasHtml && hasPath) return { error: "Pass html or path, not both." };
  if (!hasHtml && !hasPath) return { error: "Pass html (the page) or path (the absolute path of an .html file)." };
  const { path: given, ...rest } = input;
  if (!hasPath) return { input: rest };

  const { fs, path, os, url } = sys;
  const win = sys.platform === "win32";
  let file = given.trim();
  try {
    if (/^file:/i.test(file)) file = url.fileURLToPath(file);
  } catch {
    return { error: `path is not a valid file URL: ${given}` };
  }
  if (file === "~" || /^~[\\/]/.test(file)) file = path.join(os.homedir(), file.slice(1));
  // Git Bash and MSYS write C:\x as /c/x.
  const drive = win && /^\/([a-z])(?=\/|$)/i.exec(file);
  if (drive) file = `${drive[1].toUpperCase()}:\\${file.slice(3)}`;
  if (!path.isAbsolute(file) || (win && !/^(?:[a-z]:[\\/]|\\\\)/i.test(file))) {
    return { error: `path must be absolute: ${given}` };
  }
  file = path.normalize(file);
  if (!HTML_FILE.test(file)) return { error: `path must name an .html or .htm file: ${file}` };

  let real;
  let stat;
  try {
    real = fs.realpathSync(file);
    stat = fs.statSync(real);
  } catch (e) {
    return { error: e?.code === "ENOENT" ? `No file at ${file}.` : `Cannot read ${file}: ${e?.message ?? e}` };
  }
  if (!stat.isFile()) return { error: `${file} is not a file.` };
  // A link named page.html must not carry another kind of file, such as a secret, into a page.
  if (!HTML_FILE.test(real)) return { error: `${file} links to ${real}, which is not an .html or .htm file.` };
  if (stat.size > MAX_BYTES) {
    return { error: `${file} is ${(stat.size / 1048576).toFixed(1)} MiB; the limit is 25.0 MiB.` };
  }
  let html;
  try {
    html = fs.readFileSync(real, "utf8");
  } catch (e) {
    return { error: `Cannot read ${file}: ${e?.message ?? e}` };
  }
  if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);
  if (!html.trim()) return { error: `${file} is empty.` };
  return { input: { ...rest, html } };
}

module.exports = { readHtmlInput };
