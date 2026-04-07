/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { spawn } from '@malept/cross-spawn-promise';

const root = path.dirname(path.dirname(import.meta.dirname));
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));

async function removeExtendedAttributes(targetPath: string): Promise<void> {
	await spawn('xattr', ['-cr', targetPath], { stdio: 'inherit' });
}

async function adHocSignApp(appPath: string): Promise<void> {
	// Do not pass `--options runtime` for local internal builds. Hardened runtime
	// enables library validation, which rejects ad-hoc nested Electron frameworks.
	await spawn('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
	await spawn('codesign', ['--verify', '--deep', '--strict', '-v', appPath], { stdio: 'inherit' });
}

async function createZip(appRoot: string, appName: string, zipPath: string): Promise<void> {
	if (fs.existsSync(zipPath)) {
		fs.unlinkSync(zipPath);
	}

	await spawn('zip', ['-Xry', zipPath, appName], { cwd: appRoot, stdio: 'inherit' });
	await removeExtendedAttributes(zipPath);
}

async function createDmg(buildDir: string, outDir: string, dmgPath: string, arch: string, quality: string): Promise<void> {
	if (fs.existsSync(dmgPath)) {
		fs.unlinkSync(dmgPath);
	}

	const tempOutDir = path.join(outDir, `.internal-test-dmg-${arch}`);
	fs.rmSync(tempOutDir, { force: true, recursive: true });
	fs.mkdirSync(tempOutDir, { recursive: true });

	await spawn(process.execPath, [path.join(root, 'build', 'darwin', 'create-dmg.ts'), buildDir, tempOutDir], {
		env: { ...process.env, VSCODE_ARCH: arch, VSCODE_QUALITY: quality },
		stdio: 'inherit',
	});

	const createdDmgPath = path.join(tempOutDir, `VSCode-darwin-${arch}.dmg`);
	if (!fs.existsSync(createdDmgPath)) {
		throw new Error(`DMG was not created at expected path: ${createdDmgPath}`);
	}

	fs.renameSync(createdDmgPath, dmgPath);
	await removeExtendedAttributes(dmgPath);
	fs.rmSync(tempOutDir, { force: true, recursive: true });
}

function writeReadme(outDir: string, artifactBaseName: string, appName: string): void {
	const readmePath = path.join(outDir, `${artifactBaseName}-README.txt`);
	const contents = [
		`${artifactBaseName}`,
		'',
		'This is a local internal-test build. It is ad-hoc signed and not notarized.',
		'Use it for local verification only, not public distribution.',
		'',
		'If macOS still blocks the app after copying it to /Applications, run:',
		`xattr -dr com.apple.quarantine "/Applications/${appName}"`,
		`xattr -dr com.apple.provenance "/Applications/${appName}" 2>/dev/null || true`,
		`open "/Applications/${appName}"`,
		'',
	].join('\n');

	fs.writeFileSync(readmePath, contents);
}

async function main(buildDir = path.dirname(root), outDir = path.dirname(root)): Promise<void> {
	if (process.platform !== 'darwin') {
		throw new Error('Internal test macOS packages can only be created on darwin.');
	}

	const arch = process.env['VSCODE_ARCH'] ?? 'arm64';
	const quality = process.env['VSCODE_QUALITY'] ?? 'stable';
	const appRoot = path.join(buildDir, `VSCode-darwin-${arch}`);
	const appName = `${product.nameLong}.app`;
	const appPath = path.join(appRoot, appName);
	const artifactBaseName = `VSCode-darwin-${arch}-internal-test`;
	const zipPath = path.join(outDir, `${artifactBaseName}.zip`);
	const dmgPath = path.join(outDir, `${artifactBaseName}.dmg`);

	if (!fs.existsSync(appPath)) {
		throw new Error(`App path does not exist: ${appPath}`);
	}

	console.log(`Preparing internal test package for ${appName}`);
	console.log(`  App path: ${appPath}`);
	console.log(`  Output directory: ${outDir}`);

	await removeExtendedAttributes(appPath);
	await adHocSignApp(appPath);
	await createZip(appRoot, appName, zipPath);
	await createDmg(buildDir, outDir, dmgPath, arch, quality);
	writeReadme(outDir, artifactBaseName, appName);

	console.log('Internal test artifacts created:');
	console.log(`  ${zipPath}`);
	console.log(`  ${dmgPath}`);
	console.log(`  ${path.join(outDir, `${artifactBaseName}-README.txt`)}`);
}

if (import.meta.main) {
	main(process.argv[2], process.argv[3]).catch(err => {
		console.error('Failed to create internal test package:', err);
		process.exit(1);
	});
}
