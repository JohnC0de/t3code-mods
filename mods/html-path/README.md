# HTML from a file

T3 Code's `html_preview` and `html_render` tools take a page as `html`, so an agent pastes the
whole page as tool input. A 17 KB page is about 4,000 tokens that the agent must write out, which
takes about 40 s. With this mod both tools also take `path`: the absolute path of an `.html` or
`.htm` file. T3 reads the file, and the call costs about 50 tokens.

```json
{ "path": "C:\\Users\\me\\.hv\\cache\\project\\page.embed.html", "title": "Report", "height": 2000 }
```

- Pass `html` or `path`, not both. Everything else works as before: T3 inlines local images, sets
  its theme, measures the page and stores it in the thread.
- `path` takes a drive path, `~/...`, a `file://` URL, and on Windows a Git Bash path
  (`/c/Users/...`). A relative path fails, because the backend does not know the agent's folder.
- The file must be an `.html` or `.htm` file, also after links are followed, and at most 25 MiB
  (T3's limit for a page). The 512,000-character limit applies only to pasted `html`.
- Agents see `path` in the tool list. No instructions need to change.

Restart T3 Code after you install or update the mod. The mod patches the backend's code when it
loads, so a T3 Code update can break it; `t3mods doctor` shows the state. While the patch is off,
the tools take only `html`, as in T3 Code without the mod.

## After an update of this mod

Restart T3 Code. If you wrote the patches into `server.asar` with `t3mods server-patch`
(Windows), quit T3 Code and run `t3mods server-patch` again.
