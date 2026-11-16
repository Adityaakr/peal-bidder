import { defineConfig } from "vite";

/**
 * QoreChain's REST API and CometBFT RPC send no CORS headers, so the app reaches
 * them through same-origin paths. Locally this dev server forwards them; hosted,
 * vercel.json's rewrites do the same. Both only ever forward to these two public
 * testnet endpoints. (Same arrangement as Peal Tender's dashboard.)
 */
const proxy = {
  "/api/qore/rest": {
    target: "https://api-testnet.qore.host",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/qore\/rest/, ""),
  },
  "/api/qore/rpc": {
    target: "https://rpc-testnet.qore.host",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/qore\/rpc/, ""),
  },
};

export default defineConfig({
  root: import.meta.dirname,
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 3000,
    target: "es2022",
  },
});
