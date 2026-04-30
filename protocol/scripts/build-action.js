const esbuild = require("esbuild");

// Build the action for Lit
esbuild
  .build({
    entryPoints: ["actions/src/prep/main.ts", "actions/src/single/main.ts", "actions/src/cbor/main.ts", "actions/src/updateEvm/main.ts"],
    bundle: true,
    outdir: "actions/dist",
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: false,
    mainFields: ["browser", "module", "main"],
    external: [
      "ethers", // Only keep ethers as external since it's provided by Lit
      "@lit-protocol/*",           // ✅ Add this
      "crypto",          
      "stream",                    // ✅ Common Node built-ins to exclude
      "buffer",
      "util",
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
    plugins: [],
  })
  .catch(() => process.exit(1));
