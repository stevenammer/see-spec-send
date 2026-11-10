// A tiny stand-in for the DOM, just enough to run demo/lib/render.js under Node.
// It records every element and attribute so tests can check nothing a visitor typed became markup.
export class Node {
  constructor(tag, text = null) { this.tag = tag; this.text = text; this.attrs = {}; this.children = []; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  // Like a real browser: anything that isn't a node becomes a text node, so null shows as "null".
  replaceChildren(...nodes) { this.children = nodes.map(node => (node instanceof Node ? node : new Node('#text', String(node)))); }
}
export const fakeDocument = {
  createElement: tag => new Node(tag),
  createTextNode: text => new Node('#text', String(text)),
};
export function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
export const textOf = node => (node.tag === '#text' ? node.text : node.children.map(textOf).join(''));
