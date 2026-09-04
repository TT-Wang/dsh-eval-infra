window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-eval-infra",
	factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/Panel.tsx
var import_react = require("react");
var BASE = "/eval";
var GOOD = "var(--dsh-good, #12805c)";
var BAD = "var(--dsh-bad, #c33)";
var MUTED = "var(--dsh-muted, #6b7280)";
function summarise(v) {
  const pct = v.costPct === null ? "" : ` ${Math.abs(v.costPct).toFixed(0)}%`;
  if (v.gate === "regressions") return { text: `${v.arm}: breaks ${v.regressions} scenario${v.regressions === 1 ? "" : "s"}`, color: BAD };
  if (v.gate === "incomplete") return { text: `${v.arm}: run incomplete`, color: MUTED };
  if (v.costReading === "cheaper") return { text: `${v.arm}: cheaper by${pct}`, color: GOOD };
  if (v.costReading === "more-expensive") return { text: `${v.arm}: costs${pct} more`, color: BAD };
  if (v.costReading === "equivalent") return { text: `${v.arm}: no real difference`, color: MUTED };
  if (v.improvements > 0) return { text: `${v.arm}: fixes ${v.improvements} scenario${v.improvements === 1 ? "" : "s"}`, color: GOOD };
  return { text: `${v.arm}: not conclusive${v.costPct === null ? "" : ` (${v.costPct < 0 ? "\u2212" : "+"}${pct.trim()})`}`, color: MUTED };
}
function EvalPanel({ wide }) {
  const [runs, setRuns] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let alive = true;
    const load = () => {
      fetch(`${BASE}/api/runs`, { headers: { accept: "application/json" } }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((rs) => {
        if (alive) {
          setRuns(rs);
          setError(null);
        }
      }).catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    };
    load();
    const timer = setInterval(load, 5e3);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const latest = runs?.[0];
  const running = runs?.find((r) => r.status === "running");
  const open = (hash = "") => {
    window.open(`${BASE}/${hash}`, "_blank", "noopener");
  };
  if (!wide) {
    return /* @__PURE__ */ (0, import_react.createElement)(
      "button",
      {
        type: "button",
        title: latest ? `dsh-eval \xB7 last run ${latest.status}` : "dsh-eval",
        onClick: () => open(),
        style: { width: 32, height: 32, borderRadius: 8, border: "1px solid var(--dsh-line, #e5e7eb)", background: "transparent", cursor: "pointer", fontSize: 13 }
      },
      running ? "\u25D0" : "A/B"
    );
  }
  return /* @__PURE__ */ (0, import_react.createElement)("div", { style: { padding: "8px 10px", borderTop: "1px solid var(--dsh-line, #e5e7eb)", fontSize: 12, lineHeight: 1.5 } }, /* @__PURE__ */ (0, import_react.createElement)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } }, /* @__PURE__ */ (0, import_react.createElement)("b", { style: { fontSize: 12 } }, "dsh-eval"), /* @__PURE__ */ (0, import_react.createElement)("button", { type: "button", onClick: () => open(), style: linkStyle }, "open")), error !== null && /* @__PURE__ */ (0, import_react.createElement)("div", { style: { color: MUTED } }, "not reachable: ", error), error === null && runs === null && /* @__PURE__ */ (0, import_react.createElement)("div", { style: { color: MUTED } }, "loading\u2026"), error === null && runs !== null && runs.length === 0 && /* @__PURE__ */ (0, import_react.createElement)("div", { style: { color: MUTED } }, "no comparisons yet"), running !== void 0 && /* @__PURE__ */ (0, import_react.createElement)("div", { style: { marginBottom: 4 } }, /* @__PURE__ */ (0, import_react.createElement)("span", { style: { color: "var(--dsh-warn, #b26a00)" } }, "\u25D0 running"), " ", running.label ?? running.id), latest !== void 0 && running === void 0 && /* @__PURE__ */ (0, import_react.createElement)("div", { style: { marginBottom: 4 } }, /* @__PURE__ */ (0, import_react.createElement)("div", { style: { color: MUTED } }, latest.label ?? latest.id, " \xB7 ", latest.arms.join(" vs ")), (latest.verdicts ?? []).slice(0, 2).map((v) => {
    const line = summarise(v);
    return /* @__PURE__ */ (0, import_react.createElement)("div", { key: v.arm, style: { color: line.color } }, line.text);
  })), /* @__PURE__ */ (0, import_react.createElement)("div", { style: { display: "flex", gap: 6 } }, /* @__PURE__ */ (0, import_react.createElement)("button", { type: "button", onClick: () => open("#/new"), style: linkStyle }, "new comparison"), latest !== void 0 && /* @__PURE__ */ (0, import_react.createElement)("button", { type: "button", onClick: () => open(`#/run/${latest.id}`), style: linkStyle }, "last result")));
}
var linkStyle = { border: "none", background: "transparent", padding: 0, color: "var(--dsh-accent, #2563eb)", cursor: "pointer", font: "inherit" };

// src/client/index.tsx
var inject = ["slots"];
function apply(ctx) {
  const slots = ctx.slots;
  slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "dsh-eval" }, EvalPanel));
}
return module.exports;
	}
});
