import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const WINDOWS_SHELL = process.env.ComSpec || 'cmd.exe';

function run(command, args, cwd) {
    const result = spawnSync(
        process.platform === 'win32' && command === 'pnpm' ? WINDOWS_SHELL : command,
        process.platform === 'win32' && command === 'pnpm'
            ? ['/d', '/s', '/c', command, ...args]
            : args,
        {
            cwd,
            encoding: 'utf8'
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const details = [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
            .trim();
        throw new Error(details || `${command} failed`);
    }

    return result;
}

test('packed sdk should compile in an isolated TypeScript consumer without DOM libs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-ts-consumer-'));
    const nodeModulesDir = path.join(tempDir, 'node_modules');
    const packageRoot = path.join(nodeModulesDir, 'gemini-watermark-remover');
    const tarballDir = path.join(tempDir, 'packed');
    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    const consumerEntry = path.join(tempDir, 'consumer.ts');

    await mkdir(packageRoot, { recursive: true });
    await mkdir(tarballDir, { recursive: true });

    run('pnpm', ['pack', '--pack-destination', tarballDir], ROOT_DIR);

    const packedFiles = await readdir(tarballDir);
    assert.equal(packedFiles.length, 1, `expected exactly one tarball, got ${packedFiles.join(', ')}`);

    const tarballPath = path.join(tarballDir, packedFiles[0]);
    run('tar', ['-xf', tarballPath, '-C', packageRoot, '--strip-components=1'], ROOT_DIR);

    await writeFile(tsconfigPath, JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            lib: ['ES2022'],
            types: ['node'],
            typeRoots: [path.join(ROOT_DIR, 'node_modules', '@types')],
            skipLibCheck: false
        },
        include: ['./consumer.ts']
    }, null, 2), 'utf8');

    await writeFile(consumerEntry, `
import {
    createWatermarkEngine,
    removeWatermarkFromImageDataSync,
    type ImageDataLike
} from 'gemini-watermark-remover';
import {
    inferMimeTypeFromPath,
    type NodeBufferRemovalOptions
} from 'gemini-watermark-remover/node';

const imageData: ImageDataLike = {
    width: 64,
    height: 64,
    data: new Uint8ClampedArray(64 * 64 * 4)
};

const enginePromise = createWatermarkEngine();
const result = removeWatermarkFromImageDataSync(imageData, { adaptiveMode: 'never', maxPasses: 1 });
const mimeType = inferMimeTypeFromPath('demo.png');

const options: NodeBufferRemovalOptions = {
    mimeType,
    decodeImageData() {
        return imageData;
    },
    encodeImageData() {
        return Buffer.from([]);
    }
};

void enginePromise;
void result.meta;
void options;
`, 'utf8');

    run('pnpm', ['exec', 'tsc', '--project', tsconfigPath, '--pretty', 'false'], ROOT_DIR);
});
