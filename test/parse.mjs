/**
 * Test that all TypeScript files parse correctly using Node's built-in
 * --experimental-strip-types (requires Node >= 22.6).
 *
 * Usage: node --experimental-strip-types test/parse.mjs
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = false;

// Test core/ and pi/ directories
for (const dir of ["core", "pi"]) {
  const fullDir = join(__dirname, "..", dir);
  const files = readdirSync(fullDir).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    const fileUrl = pathToFileURL(join(fullDir, file)).href;
    try {
      await import(fileUrl);
      console.log(`  ✓ ${dir}/${file}`);
    } catch (e) {
      if (e instanceof SyntaxError) {
        const msg = e.message ?? "";
        console.log(`  ✗ ${dir}/${file}: ${msg.slice(0, 200)}`);
        failed = true;
      } else {
        // Runtime errors (missing deps, etc.) are fine — file parsed OK
        console.log(`  ✓ ${dir}/${file} (parsed, runtime dep expected)`);
      }
    }
  }
}

if (failed) {
  console.log("\nFAILED: Fix parse errors above.");
  process.exit(1);
} else {
  console.log("\nAll files parse correctly.");
}
