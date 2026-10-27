import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import identity from "./extension/identity.json" with { type: "json" };
import networks from "./extension/networks.json" with { type: "json" };

const indexOrigin = "https://api.safe.global";
const rpcOrigins = networks.map(network => new URL(network.rpc).origin);
const computedId = [...createHash("sha256").update(Buffer.from(identity.publicKey, "base64")).digest("hex").slice(0, 32)].map(n => String.fromCharCode(97 + parseInt(n, 16))).join("");
if (computedId !== identity.id) throw new Error("Extension public key/ID mismatch");
const manifest = {
  manifest_version: 3,
  name: "Picnic Bunker — Passkeys",
  description: "Valide sua passkey Picnic e simule uma retirada diretamente na blockchain. Versão experimental; não envia transações.",
  version: "0.2.0",
  minimum_chrome_version: "122",
  key: identity.publicKey,
  action: { default_title: "Abrir Picnic Bunker", default_icon: { "16": "icon16.png", "32": "icon32.png" } },
  icons: { "16": "icon16.png", "32": "icon32.png" },
  background: { service_worker: "background.js" },
  host_permissions: ["https://usepicnic.com/*", ...rpcOrigins.map(origin => `${origin}/*`), `${indexOrigin}/*`],
  content_security_policy: { extension_pages: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${rpcOrigins.join(" ")} ${indexOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'` },
};

export default defineConfig({
  root: "extension", base: "./", publicDir: false,
  define: { __PASSKEY_EXTENSION__: "true" },
  build: { outDir: "../extension-dist", emptyOutDir: true, sourcemap: false, target: "chrome122" },
  plugins: [{ name: "passkey-extension-package", generateBundle() {
    this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(manifest, null, 2) + "\n" });
    for (const [fileName, source] of [["background.js", "extension/background.js"], ["icon16.png", "public/favicon-16x16.png"], ["icon32.png", "public/favicon-32x32.png"], ["INSTALL.md", "docs/passkey-extension.md"]]) {
      this.emitFile({ type: "asset", fileName, source: readFileSync(resolve(source)) });
    }
  } }],
});
