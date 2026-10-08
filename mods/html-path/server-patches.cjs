// Gives T3's html_preview and html_render MCP tools a `path` input: the absolute path of an
// .html file that the backend reads, so an agent does not paste the page as tool input.
// - "schema": `html` becomes optional and `path` is added, in both tools' parameters. Agents
//   see the change in the tool list.
// - "handlers": before T3's own code runs, a `path` input becomes an `html` input
//   (html-path.cjs). An input with neither or both fails with invalid_request.
// Minified names change per build, so both patches take them from code next to the anchors.
const { readHtmlInput } = require("./html-path.cjs");

const ID = "[A-Za-z_$][\\w$]*";
const HTML_DESCRIPTION = '"A complete, self-contained HTML document."';
const PATH_DESCRIPTION =
  "Instead of html: the absolute path of an .html or .htm file on this machine, such as a page another tool wrote. T3 reads the file, so you do not paste the page. At most 25 MiB.";

// Replaces each match of `re` (global) and checks how many there were, so a changed build fails
// the patch instead of patching half of it.
function replaceCount(text, re, count, fn, what) {
  let n = 0;
  const out = text.replace(re, (...m) => {
    n++;
    return fn(...m);
  });
  if (n !== count) throw new Error(`${what}: ${n} matches, expected ${count}`);
  return out;
}

function schema(text) {
  const decl = new RegExp(`const (${ID}) = (${ID})\\.check\\([^;]*?\\)\\.annotate\\(\\{ description: ${HTML_DESCRIPTION.replace(/[.]/g, "\\.")} \\}\\);`);
  const d = decl.exec(text);
  if (!d) throw new Error("the html schema declaration is missing");
  const [, html, str] = d;
  const opt = new RegExp(`width: (${ID})\\(${ID}\\.annotate\\(\\{ description: \`Viewport width`).exec(text);
  if (!opt) throw new Error("html_preview's optional width is missing");
  const optional = opt[1];
  const field = new RegExp(`(parameters: ${ID}\\(\\{\\s*)html: ${html.replace(/\$/g, "\\$")},`, "g");
  return replaceCount(
    text,
    field,
    2,
    (_, head) => `${head}html: ${optional}(${html}), path: ${optional}(${str}.annotate({ description: ${JSON.stringify(PATH_DESCRIPTION)} })),`,
    "html_preview and html_render parameters",
  );
}

const HELPER = "__t3modsHtmlPath";
const helperSource = `const ${HELPER} = ((read) => {
  const get = (m) => process.getBuiltinModule(m);
  return (input) => read(input, { fs: get("node:fs"), path: get("node:path"), os: get("node:os"), url: get("node:url"), platform: process.platform });
})(${readHtmlInput.toString()});
`;

function handlers(text) {
  // toFailure turns T3's render errors into the MCP failure type; reuse that type.
  const failure = new RegExp(`const ${ID} = \\((${ID})\\) => new (${ID})\\(\\{\\s*code: ${ID}\\.has\\(\\1\\._tag\\) \\? "invalid_request"`).exec(text);
  if (!failure) throw new Error("the html tools' toFailure is missing");
  const Failure = failure[2];
  let out = text.replace(failure[0], () => helperSource + failure[0]);
  for (const tool of ["html_preview", "html_render"]) {
    // Newer builds wrap the handler in readsAsCaller or actsAsCaller; older ones do not.
    const start = new RegExp(`(\\b${tool}: (?:${ID}\\()?\\((${ID})\\) => ${ID}\\(function\\* \\(\\) \\{)`, "g");
    out = replaceCount(
      out,
      start,
      1,
      (_, head, input) =>
        `${head}\n\t\t{ const read = ${HELPER}(${input}); if (read.error !== undefined) return yield* new ${Failure}({ code: "invalid_request", message: read.error }); ${input} = read.input; }`,
      `${tool} handler`,
    );
  }
  return out;
}

/** @type {import("../../loader/types/t3mods").ServerPatch[]} */
module.exports = [
  { id: "schema", find: HTML_DESCRIPTION, transform: schema },
  { id: "handlers", find: HTML_DESCRIPTION, transform: handlers },
];
