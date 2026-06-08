#!/usr/bin/env node

import sharp from "sharp";
import { promises as fs } from "fs";
import {
	join,
	extname,
	relative as _relative,
	resolve,
	dirname,
	basename,
} from "path";
import { program } from "commander";

program
	.option("-s, --source <path>", "Исходная папка или файл")
	.option("-d, --dist <path>", "Выходная папка (сохраняет структуру подпапок)")
	.option("-q, --quality <number>", "Качество WebP (0-100)", parseInt, 80)
	.option("--no-recursive", "Не обрабатывать подпапки рекурсивно")
	.option(
		"-c, --concurrency <number>",
		"Количество параллельных потоков",
		parseInt,
		4,
	)
	.parse(process.argv);

const options = program.opts();

if (!options.source) {
	console.error("error: Укажите исходную папку или файл: -s ./images");
	program.help();
}

const SUPPORTED_EXT = new Set([
	".jpg",
	".jpeg",
	".png",
	".tiff",
	".bmp",
	".svg",
]);

// Функция для обхода дерева файлов (возвращает плоский список задач)
async function getFiles(dir, baseDir, recursive) {
	let results = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory() && recursive) {
			const subFiles = await getFiles(fullPath, baseDir, recursive);
			results = results.concat(subFiles);
		} else if (entry.isFile()) {
			const ext = extname(entry.name).toLowerCase();
			if (SUPPORTED_EXT.has(ext)) {
				results.push({
					fullPath,
					relative: _relative(baseDir, fullPath),
					name: entry.name,
					ext,
				});
			}
		}
	}
	return results;
}

// Ограничитель параллельных задач (Simple Worker Pool)
async function pool(workers, queue, fn) {
	const execute = async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (item) await fn(item);
		}
	};
	await Promise.all(Array.from({ length: workers }, execute));
}

async function main() {
	const sourcePath = resolve(options.source);
	const distPath = options.dist ? resolve(options.dist) : null;
	const quality = Math.min(100, Math.max(0, options.quality));

	try {
		const stat = await fs.stat(sourcePath);
		let filesToProcess = [];
		let baseDir = sourcePath;

		if (stat.isFile()) {
			const ext = extname(sourcePath).toLowerCase();
			if (!SUPPORTED_EXT.has(ext)) {
				console.error(`error: Неподдерживаемый формат: ${sourcePath}`);
				process.exit(1);
			}
			baseDir = dirname(sourcePath);
			filesToProcess.push({
				fullPath: sourcePath,
				relative: basename(sourcePath),
				name: basename(sourcePath),
				ext,
			});
		} else if (stat.isDirectory()) {
			filesToProcess = await getFiles(
				sourcePath,
				sourcePath,
				options.recursive,
			);
		}

		console.log(`Найдено файлов для обработки: ${filesToProcess.length}`);

		// Обработка очереди с ограничением параллелизма
		await pool(options.concurrency, filesToProcess, async (file) => {
			const outName = basename(file.name, file.ext) + ".webp";
			let outPath;

			if (distPath) {
				const relativeDir = dirname(file.relative);
				const targetDir = join(distPath, relativeDir);
				await fs.mkdir(targetDir, { recursive: true });
				outPath = join(targetDir, outName);
			} else {
				outPath = join(dirname(file.fullPath), outName);
			}

			try {
				await sharp(file.fullPath).webp({ quality }).toFile(outPath);
				console.log(
					`success: ${file.relative} -> ${distPath ? _relative(distPath, outPath) : outName}`,
				);
			} catch (err) {
				console.error(
					`error: Ошибка конвертации ${file.fullPath}: ${err.message}`,
				);
			}
		});

		console.log("Обработка успешно завершена!");
	} catch (err) {
		if (err.code === "ENOENT") {
			console.error(`error: Путь не существует: ${sourcePath}`);
		} else {
			console.error("fatal:", err);
		}
		process.exit(1);
	}
}

main();
