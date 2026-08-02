import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import type { Metadata } from "sharp";

/** Временная папка, в которой живут файлы одного теста. */
export const tmpDir = path.resolve("./tmp-test");

/** Собранный CLI — тесты гоняют именно то, что уедет в пакет. */
export const cliPath = path.resolve("./dist/cli.js");

/** Минимальный валидный PNG 1x1, прозрачный. */
export const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

export interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Запускает собранный CLI отдельным процессом.
 * spawnSync, а не execSync: нам нужно проверять ненулевые коды выхода,
 * а не ловить исключение.
 */
export function runCli(args: string[]): CliResult {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		encoding: "utf8",
	});

	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** Пишет PNG заданного размера во временную папку. */
export async function writePng(
	name: string,
	width = 100,
	height = 100,
): Promise<string> {
	const filePath = path.join(tmpDir, name);

	await sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 200, g: 40, b: 40 },
		},
	})
		.png()
		.toFile(filePath);

	return filePath;
}

/** Пишет SVG фиксированного размера — как иконка из реального проекта. */
export async function writeSvg(name: string, size = 800): Promise<string> {
	const filePath = path.join(tmpDir, name);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
		`<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 10}" fill="#e02020"/>` +
		`</svg>`;

	await fs.writeFile(filePath, svg);
	return filePath;
}

/** Пишет SVG, у которого есть только viewBox — без width и height. */
export async function writeViewBoxSvg(
	name: string,
	size = 64,
): Promise<string> {
	const filePath = path.join(tmpDir, name);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
		`<rect width="${size}" height="${size}" rx="${size / 4}" fill="#2563eb"/>` +
		`</svg>`;

	await fs.writeFile(filePath, svg);
	return filePath;
}

/** Проверяет, существует ли файл. */
export function exists(filePath: string): Promise<boolean> {
	return fs
		.stat(filePath)
		.then(() => true)
		.catch(() => false);
}

/**
 * Читает метаданные через буфер, а не по пути. Если отдать sharp путь,
 * на Windows файл остаётся заблокированным и очистка падает с EBUSY.
 */
export async function readMeta(filePath: string): Promise<Metadata> {
	return sharp(await fs.readFile(filePath)).metadata();
}

/** Создаёт чистую временную папку. */
export async function makeTmpDir(): Promise<void> {
	await fs.mkdir(tmpDir, { recursive: true });
}

/** Удаляет временную папку, переживая редкие блокировки файлов на Windows. */
export async function removeTmpDir(): Promise<void> {
	await fs.rm(tmpDir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
}
