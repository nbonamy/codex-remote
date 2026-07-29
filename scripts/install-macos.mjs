import { spawn } from 'node:child_process';
import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('The local macOS installer must run on macOS');
}

const appName = 'Codex Remote';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(projectRoot, 'release');
const sourceApplication = join(
  releaseDirectory,
  process.arch === 'arm64' ? 'mac-arm64' : 'mac',
  `${appName}.app`,
);
const applicationsDirectory = '/Applications';
const destinationApplication = join(applicationsDirectory, `${appName}.app`);
const stagingApplication = join(
  applicationsDirectory,
  `.${appName}.installing-${process.pid}.app`,
);
const backupApplication = join(
  applicationsDirectory,
  `.${appName}.previous-${process.pid}.app`,
);

console.log('Packaging unsigned local macOS application');
await run(
  resolve(projectRoot, 'node_modules/.bin/electron-builder'),
  ['--mac', 'dir', '--config.mac.identity=null', '--config.mac.notarize=false'],
  {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
);

if (!await pathExists(sourceApplication)) {
  throw new Error(
    `No packaged app found at ${sourceApplication}; local packaging may have failed`,
  );
}

await stopRunningApplication();
await rm(stagingApplication, { force: true, recursive: true });
await rm(backupApplication, { force: true, recursive: true });

console.log(`Copying ${sourceApplication} to ${destinationApplication}`);
await run('/usr/bin/ditto', [sourceApplication, stagingApplication]);

const replacingExistingApplication = await pathExists(destinationApplication);
if (replacingExistingApplication) {
  await rename(destinationApplication, backupApplication);
}

try {
  await rename(stagingApplication, destinationApplication);
} catch (error) {
  if (replacingExistingApplication && await pathExists(backupApplication)) {
    await rename(backupApplication, destinationApplication);
  }
  throw error;
}

await rm(backupApplication, { force: true, recursive: true });
console.log(`Installed ${destinationApplication}`);

async function stopRunningApplication() {
  if (!await commandSucceeds('/usr/bin/pgrep', ['-x', appName])) return;

  console.log(`Stopping running ${appName} instance`);
  await runAllowingFailure('/usr/bin/pkill', ['-TERM', '-x', appName]);
  if (await waitUntilStopped(5000)) return;

  console.log(`${appName} did not quit after 5 seconds; forcing it to stop`);
  await runAllowingFailure('/usr/bin/pkill', ['-KILL', '-x', appName]);
  if (!await waitUntilStopped(2000)) {
    throw new Error(`Unable to stop the running ${appName} instance`);
  }
}

async function waitUntilStopped(timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!await commandSucceeds('/usr/bin/pgrep', ['-x', appName])) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !await commandSucceeds('/usr/bin/pgrep', ['-x', appName]);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function commandSucceeds(command, args) {
  return (await runAllowingFailure(command, args)) === 0;
}

function runAllowingFailure(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? 1));
  });
}

function run(command, args, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
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
