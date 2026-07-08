// Copy the committed sample GLBs from the single source (assets/models) into
// the web app's public dir so the viewer serves them same-origin (no CORS).
// Runs in predev and prebuild. public/models is gitignored.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../../../assets/models/', import.meta.url));
const destDir = fileURLToPath(new URL('../public/models/', import.meta.url));

mkdirSync(destDir, { recursive: true });

const models = ['DamagedHelmet.glb', 'CesiumMilkTruck.glb', 'Box.glb'];
let copied = 0;
for (const file of models) {
  const from = `${srcDir}${file}`;
  if (existsSync(from)) {
    cpSync(from, `${destDir}${file}`);
    copied += 1;
  } else {
    console.warn(`copy-models: missing ${from}`);
  }
}
console.log(`copy-models: copied ${copied}/${models.length} models to public/models`);
