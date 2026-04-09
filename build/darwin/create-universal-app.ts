/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import minimatch from 'minimatch';
import { makeUniversalApp } from 'vscode-universal-bundler';

const root = path.dirname(path.dirname(import.meta.dirname));

const nodeModulesBases = [
	path.join('Contents', 'Resources', 'app', 'node_modules'),
	path.join('Contents', 'Resources', 'app', 'node_modules.asar.unpacked'),
];

/**
 * Ensures a directory exists in both the x64 and arm64 app bundles by copying
 * it from whichever build has it to the one that does not. This is needed for
 * platform-specific native module directories that npm only installs for the
 * host architecture.
 */
function crossCopyPlatformDir(x64AppPath: string, arm64AppPath: string, relativePath: string): void {
	const inX64 = path.join(x64AppPath, relativePath);
	const inArm64 = path.join(arm64AppPath, relativePath);

	if (fs.existsSync(inX64) && !fs.existsSync(inArm64)) {
		fs.mkdirSync(inArm64, { recursive: true });
		fs.cpSync(inX64, inArm64, { recursive: true });
	} else if (fs.existsSync(inArm64) && !fs.existsSync(inX64)) {
		fs.mkdirSync(inX64, { recursive: true });
		fs.cpSync(inArm64, inX64, { recursive: true });
	}
}

async function main(buildDir?: string) {
	const arch = process.env['VSCODE_ARCH'];

	if (!buildDir) {
		throw new Error('Build dir not provided');
	}

	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
	const appName = product.nameLong + '.app';
	const x64Root = resolveDarwinBuildRoot(buildDir, 'x64');
	const arm64Root = resolveDarwinBuildRoot(buildDir, 'arm64');
	const asarRelativePath = path.join('Contents', 'Resources', 'app', 'node_modules.asar');
	const outAppRoot = path.join(buildDir, `Beam-darwin-${arch}`);
	const outAppPath = path.join(outAppRoot, appName);
	const productJsonPath = path.resolve(outAppPath, 'Contents', 'Resources', 'app', 'product.json');
	const x64AppPath = path.join(x64Root, appName);
	const arm64AppPath = path.join(arm64Root, appName);

	// Copilot SDK ships platform-specific native binaries that npm only installs
	// for the host architecture. The universal app merger requires both builds to
	// have identical file trees, so we cross-copy each missing directory from the
	// other build. The binaries are then excluded from comparison (filesToSkip)
	// and the x64 binary is tagged as arch-specific (x64ArchFiles) so the merger
	// keeps both.
	for (const plat of ['darwin-x64', 'darwin-arm64']) {
		for (const base of nodeModulesBases) {
			// @github/copilot-{platform} packages (e.g. copilot-darwin-x64)
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@github', `copilot-${plat}`));
			// @github/copilot/prebuilds/{platform} (pty.node, spawn-helper)
			crossCopyPlatformDir(x64AppPath, arm64AppPath, path.join(base, '@github', 'copilot', 'prebuilds', plat));
		}
	}

	const filesToSkip = [
		'**/CodeResources',
		'**/Credits.rtf',
		'**/policies/{*.mobileconfig,**/*.plist}',
		'**/node_modules/@github/copilot-darwin-x64/**',
		'**/node_modules/@github/copilot-darwin-arm64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-x64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-arm64/**',
		'**/node_modules/@github/copilot/prebuilds/darwin-x64/**',
		'**/node_modules/@github/copilot/prebuilds/darwin-arm64/**',
		'**/node_modules.asar.unpacked/@github/copilot/prebuilds/darwin-x64/**',
		'**/node_modules.asar.unpacked/@github/copilot/prebuilds/darwin-arm64/**',
	];

	await makeUniversalApp({
		x64AppPath,
		arm64AppPath,
		asarPath: asarRelativePath,
		outAppPath,
		force: true,
		mergeASARs: true,
		x64ArchFiles: '{*/kerberos.node,**/extensions/microsoft-authentication/dist/libmsalruntime.dylib,**/extensions/microsoft-authentication/dist/msal-node-runtime.node,**/node_modules/@github/copilot-darwin-*/copilot,**/node_modules/@github/copilot/prebuilds/darwin-*/*,**/node_modules.asar.unpacked/@github/copilot-darwin-*/copilot,**/node_modules.asar.unpacked/@github/copilot/prebuilds/darwin-*/*}',
		filesToSkipComparison: (file: string) => {
			for (const expected of filesToSkip) {
				if (minimatch(file, expected)) {
					return true;
				}
			}
			return false;
		}
	});

	const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	Object.assign(productJson, {
		darwinUniversalAssetId: 'darwin-universal'
	});
	fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, '\t'));
}

function resolveDarwinBuildRoot(buildDir: string, arch: string): string {
	const candidates = [
		path.join(buildDir, `Beam-darwin-${arch}`),
		path.join(buildDir, `VSCode-darwin-${arch}`)
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return candidates[0];
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
