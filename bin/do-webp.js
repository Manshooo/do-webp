#!/usr/bin/env node

import sharp from "sharp";
import { promises as fs } from "fs";
import path from "path";
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
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory() && recursive) {
			const subFiles = await getFiles(fullPath, baseDir, recursive);
			results = results.concat(subFiles);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (SUPPORTED_EXT.has(ext)) {
				results.push({
					fullPath,
					relative: path.relative(baseDir, fullPath),
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
	const sourcePath = path.resolve(options.source);
	const distPath = options.dist ? path.resolve(options.dist) : null;
	const quality = Math.min(100, Math.max(0, options.quality));

	try {
		const stat = await fs.stat(sourcePath);
		let filesToProcess = [];

		if (stat.isFile()) {
			const ext = path.extname(sourcePath).toLowerCase();
			if (!SUPPORTED_EXT.has(ext)) {
				console.error(`error: Неподдерживаемый формат: ${sourcePath}`);
				process.exit(1);
			}
			baseDir = path.dirname(sourcePath);
			filesToProcess.push({
				fullPath: sourcePath,
				relative: path.basename(sourcePath),
				name: path.basename(sourcePath),
				ext,
			});
		} else if (stat.isDirectory()) {
			filesToProcess = await getFiles(
				sourcePath,
				sourcePath,
				options.recursive,
			);
		}

		const totalFiles = filesToProcess.length;
		console.log(`Найдено файлов для обработки: ${totalFiles}`);

		let successCount = 0;

		// Обработка очереди с ограничением параллелизма
		await pool(options.concurrency, filesToProcess, async (file) => {
			const outName = path.basename(file.name, file.ext) + ".webp";
			let outPath;

			if (distPath) {
				const relativeDir = path.dirname(file.relative);
				const targetDir = path.join(distPath, relativeDir);
				await fs.mkdir(targetDir, { recursive: true });
				outPath = path.join(targetDir, outName);
			} else {
				outPath = path.join(path.dirname(file.fullPath), outName);
			}

			try {
				await sharp(file.fullPath).webp({ quality }).toFile(outPath);

				successCount++;

				if (successCount <= 3) {
					console.log(
						`success: ${file.relative} -> ${distPath ? path.relative(distPath, outPath) : outName}`,
					);
				} else {
					process.stdout.write(
						`\r...и еще ${successCount - 3} файлов успешно обработано`,
					);
				}
			} catch (err) {
				process.stdout.write("\n");
				console.error(
					`error: Ошибка конвертации ${file.fullPath}: ${err.message}`,
				);
			}
		});

		if (successCount > 3) {
			process.stdout.write("\n");
		}
		console.log(
			`Обработка завершена! Всего успешно конвертировано: ${successCount} из ${totalFiles}`,
		);
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
