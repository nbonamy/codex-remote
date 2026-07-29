import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('macOS release verification must run on macOS');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(projectRoot, 'release');
const appBundles = await findAppBundles(releaseDirectory);
if (appBundles.length === 0) {
  throw new Error(`No packaged .app bundle found under ${releaseDirectory}`);
}

for (const appBundle of appBundles) {
  console.log(`Verifying ${appBundle}`);
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle]);
  await run('xcrun', ['stapler', 'validate', appBundle]);
}

console.log(`Verified ${appBundles.length} signed and notarized app bundle(s)`);

async function findAppBundles(directory, depth = 0) {
  if (depth > 3) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.endsWith('.app')) {
      results.push(path);
    } else {
      results.push(...await findAppBundles(path, depth + 1));
    }
  }
  return results;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
      ));
    });
  });
}
