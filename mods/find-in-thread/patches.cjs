// Hands the chat timeline's list (LegendList handle) and its rows to renderer.js `track`, so
// Ctrl+F can search rows that are scrolled out of view and scroll to them.
// Optional: without it the mod still searches the rows on screen.
module.exports = [
  {
    id: "timeline-list",
    optional: true,
    find: "estimatedItemSize:90",
    replace: [{ match: /\{ref:(\i),data:(\i),extraData:/, replace: "{ref:$1,data:$2,...$self.track?.($1,$2),extraData:" }],
  },
];
