import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/** Executes the shipped controller and its click/input handlers. This is a DOM
 * adapter, not a browser renderer: layout, biometrics and extension UI need their
 * own browser/device checks. Nothing is injected into the distributed app. */
export function guidedUi(discovery: unknown, provider: unknown, fetcher?: typeof fetch) {
  const nodes = new Map<string, any>();
  function node(key: string): any {
    if (!nodes.has(key)) nodes.set(key, {
      innerHTML: '', textContent: '', dataset: {}, style: {}, disabled: false,
      events: {}, attrs: {}, classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector: (selector: string) => node(key + selector),
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      removeAttribute(k: string) { delete this.attrs[k]; },
      addEventListener(k: string, fn: unknown) { this.events[k] = fn; },
      focus() {}, insertAdjacentHTML(_: string, html: string) { this.innerHTML += html; },
    });
    return nodes.get(key);
  }
  const root = node('root'), scene = node('.pb-scene');
  root.querySelector = node;
  root.querySelectorAll = () => Array.from({ length: 5 }, (_, i) => node('road' + i));
  const events = new Map<string, (event: Event) => void>();
  const window: any = {
    ethereum: provider, picnicGuidedDiscovery: discovery,
    matchMedia: () => ({ matches: true }),
    addEventListener: (name: string, fn: (event: Event) => void) => events.set(name, fn),
    dispatchEvent: (event: Event) => events.get(event.type)?.(event),
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const context = vm.createContext({
    window, document: { getElementById: () => root }, Event, AbortSignal, AbortController,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms).unref(); timers.add(timer); return timer;
    }, clearTimeout,
    fetch: fetcher ?? (() => { throw Error('Unexpected UI network request: this test allows only the local chain adapter'); }),
    navigator: { clipboard: { writeText: async () => {} } },
  });
  const source = readFileSync(new URL('../../public/designs/assets/guided-live.js', import.meta.url), 'utf8');
  const end = '  render();scene.focus({preventScroll:true});\n})();';
  if (!source.includes(end)) throw Error('Guided controller test adapter needs updating');
  vm.runInContext(source.replace(end, '  window.readTestState=()=>state;render();\n})();'), context);
  return {
    get state() { return window.readTestState(); },
    get html(): string { return scene.innerHTML; },
    async click(attribute: string, value: string) {
      // Require the button to actually be rendered and enabled.
      const tag = scene.innerHTML.match(new RegExp(`<button\\b[^>]*data-${attribute}="${value}"[^>]*>`))?.[0];
      if (!tag || /\bdisabled\b/.test(tag)) throw Error(`Missing or disabled button: ${attribute}=${value}\n${scene.innerHTML}`);
      const dataset = { [attribute.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]: value };
      await root.events.click({ target: { closest: () => ({ dataset, disabled: false }) }, preventDefault() {} });
    },
    destination(value: string) {
      if(!scene.innerHTML.includes('id="pb-recipient"'))throw Error('Destination input not rendered');
      scene.querySelector('.pb-address').value=value;
      root.events.input({target:{value,classList:{contains:(v:string)=>v==='pb-address'}}});
      const disabled=scene.querySelector('[data-action=next]').disabled;
      scene.innerHTML=scene.innerHTML.replace(/<button\b[^>]*data-action="next"[^>]*>/,(tag:string)=>tag.replace(/\sdisabled\b/g,'').replace(/>$/,disabled?' disabled>':'>'));
    },
    owner(value: string) {
      if (!scene.innerHTML.includes('id="pb-owner"')) throw Error('Recovery owner input not rendered');
      root.events.input({ target: { value, classList: { contains: (v: string) => v === 'pb-owner-address' }, setAttribute() {} } });
      // Reflect the DOM property written by the production input handler.
      const disabled = scene.querySelector('[data-action=next]').disabled;
      scene.innerHTML = scene.innerHTML.replace(/<button\b[^>]*data-action="next"[^>]*>/, (tag: string) => tag.replace(/\sdisabled\b/g, '').replace(/>$/, disabled ? ' disabled>' : '>')); 
    },
    async waitFor(predicate: () => boolean, timeout = 30_000) {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > deadline) throw Error(`UI timed out on ${window.readTestState().screen}: ${scene.innerHTML}`);
        await new Promise(r => setTimeout(r, 25));
      }
    },
    dispose() { timers.forEach(clearTimeout); },
  };
}
