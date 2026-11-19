// Run `npm run build` from the repository root before capturing.
// Photographs every screen in screens/catalog.mjs on a hub of made-up data (screens/seed.mjs),
// at phone and desktop widths, light and dark, and prints what the layout rules measure on each.
// Run: node screens.mjs [label] [screen-id …]   writes shots/screens/<label>/<screen>-<viewport>-<theme>.png
// and shots/screens/<label>/report.json. Compare two labels (before/after) side by side.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from './harness.mjs';
import { seedHub } from './screens/seed.mjs';
import { shots, newScreenPage, openScreen, measure } from './screens/catalog.mjs';

const [label = 'after', ...only] = process.argv.slice(2);
const outDir = join(process.cwd(), 'shots', 'screens', label);
mkdirSync(outDir, { recursive: true });

const seed = await seedHub();
const browser = await launchBrowser();
const report = [];
try {
  for (const { screen, viewport, theme } of shots()) {
    if (only.length && !only.includes(screen.id)) continue;
    const name = `${screen.id}-${viewport.id}-${theme}`;
    const page = await newScreenPage(browser, viewport, theme);
    try {
      await openScreen(page, seed, screen, viewport);
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      const m = await measure(page, viewport);
      report.push({ name, ...m });
      const flags = [m.shift > 0.02 ? `shift ${m.shift} (${m.shiftSources.join(', ')})` : '', m.overflow.length ? `overflow: ${m.overflow[0]}` : '', m.smallTargets.length ? `${m.smallTargets.length} small targets` : ''].filter(Boolean);
      console.log(`${flags.length ? '!' : ' '} ${name}${flags.length ? '  ' + flags.join('; ') : ''}`);
    } catch (err) {
      report.push({ name, error: String(err.message ?? err) });
      console.log(`x ${name}  ${err.message ?? err}`);
    } finally {
      await page.context().close();
    }
  }
} finally {
  await browser.close();
  await seed.stop();
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log('screens written to', outDir);
