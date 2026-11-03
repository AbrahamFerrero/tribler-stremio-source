import { runInNewContext } from 'node:vm';
import { diagnosticReportScript } from '../src/diagnostics/html-report';

// A deliberately small DOM contract harness, not a browser/CSP/layout emulator.
export class Element {
  children: Element[] = []; attrs = new Map<string, string>(); text = ""; value = ""; type = ""; focused = false;
  listeners = new Map<string, () => void>();
  constructor(readonly tag = "div") {}
  set textContent(text: string) { this.text = text; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(" "); }
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this.text = ""; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
  change() { this.listeners.get("change")!(); }
  click() { this.listeners.get("click")!(); }
  focus() { this.focused = true; }
}
export function diagnosticReportDom(html: string) {
  const nodes: Element[] = []; const ids = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const node = new Element(match[1]);
    for (const attr of match[2]!.matchAll(/([a-z-]+)="([^"]*)"/g)) node.setAttribute(attr[1]!, attr[2]!);
    nodes.push(node); const id = node.getAttribute("id"); if (id) ids.set(id, node);
  }
  for (const id of ["diagnostic-data", "diagnostic-translations", "diagnostic-limits"]) {
    ids.get(id)!.textContent = new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)<\\/script>').exec(html)![1]!;
  }
  const document = { title: "", documentElement: { lang: "es" },
    getElementById: (id: string): Element => {
      const find = (node: Element): Element | undefined => node.getAttribute("id") === id ? node : node.children.map(find).find(Boolean);
      const dynamic = [...ids.values()].map(find).find(Boolean);
      if (dynamic) return dynamic;
      if (!ids.has(id)) throw new Error("Missing static element: " + id); return ids.get(id)!;
    },
    querySelectorAll: (selector: string) => nodes.filter(node => node.attrs.has(selector.slice(1, -1))),
    createElement: (tag: string) => new Element(tag) };
  ids.get("language")!.value = "es";
  runInNewContext(diagnosticReportScript, { document, navigator: { language: "es" } }, { timeout: 2000 });
  return { document, ids, nodes };
}
