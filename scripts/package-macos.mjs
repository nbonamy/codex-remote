import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

if (process.platform !== 'darwin') {
  throw new Error('Signed and notarized macOS packages must be built on macOS');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredSigningEnvPath = process.env.CODEX_REMOTE_SIGNING_ENV;
const signingEnvPath = resolve(
  projectRoot,
  configuredSigningEnvPath || '../witsy/.env',
);
const signingEnv = await loadSigningEnvironment();
const signingIdentity = configuredValue(
  'CSC_NAME',
  signingEnv,
  'IDENTIFY_DARWIN_CODE',
);
if (!signingIdentity.startsWith('Developer ID Application:')) {
  throw new Error('CSC_NAME must identify a Developer ID Application certificate');
}
const releaseEnvironment = {
  ...process.env,
  APPLE_ID: configuredValue('APPLE_ID', signingEnv),
  APPLE_TEAM_ID: configuredValue('APPLE_TEAM_ID', signingEnv),
  APPLE_APP_SPECIFIC_PASSWORD: configuredValue(
    'APPLE_APP_SPECIFIC_PASSWORD',
    signingEnv,
    'APPLE_PASSWORD',
  ),
  CSC_NAME: signingIdentity.replace(/^Developer ID Application:\s*/, ''),
};

console.log(
  `Building signed and notarized macOS artifacts using ${
    Object.keys(signingEnv).length > 0 ? signingEnvPath : 'the process environment'
  }`,
);
await run(
  resolve(projectRoot, 'node_modules/.bin/electron-builder'),
  ['--mac', ...process.argv.slice(2)],
  releaseEnvironment,
);
await run(
  process.execPath,
  [resolve(projectRoot, 'scripts/verify-macos-release.mjs')],
  process.env,
);

function configuredValue(name, fileEnvironment, fallbackName = name) {
  const value = process.env[name]
    || fileEnvironment[name]
    || fileEnvironment[fallbackName];
  if (!value?.trim()) {
    throw new Error(
      `Missing ${name}; set it in ${signingEnvPath} or the process environment`,
    );
  }
  return value.trim();
}

async function loadSigningEnvironment() {
  try {
    return parseEnv(await readFile(signingEnvPath, 'utf8'));
  } catch (error) {
    if (
      !configuredSigningEnvPath
      && error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
}

function run(command, args, environment) {
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
