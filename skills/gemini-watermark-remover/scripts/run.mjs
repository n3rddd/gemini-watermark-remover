import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localBinPath = fileURLToPath(new URL('../../../bin/gwr.mjs', import.meta.url));

function getPathFallbackCandidates(args) {
  if (process.platform === 'win32') {
    return [
      { command: 'gwr.cmd', commandArgs: args },
      { command: 'gwr', commandArgs: args }
    ];
  }

  return [{ command: 'gwr', commandArgs: args }];
}

async function resolveCliCandidates(args) {
  try {
    await access(localBinPath);
    return [{
      command: process.execPath,
      commandArgs: [localBinPath, ...args]
    }];
  } catch {
    return getPathFallbackCandidates(args);
  }
}

function spawnOnce(command, commandArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runSkillCli(args, options = {}) {
  const candidates = await resolveCliCandidates(args);
  let lastEnoentError = null;

  for (const { command, commandArgs } of candidates) {
    try {
      return await spawnOnce(command, commandArgs, options);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        lastEnoentError = error;
        continue;
      }

      throw error;
    }
  }

  if (lastEnoentError) {
    throw lastEnoentError;
  }

  throw new Error('Unable to locate gwr CLI executable');
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }

  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export async function main(argv = process.argv.slice(2)) {
  const { code, stdout, stderr } = await runSkillCli(argv);

  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  if (typeof code !== 'number') {
    return 1;
  }

  return code;
}

if (isDirectRun()) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
