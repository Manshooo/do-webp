#!/usr/bin/env node

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { program } = require("commander");

program
	.option("-s, --source <path>", "Исходная папка или файл")
	.option(
		"-d, --dist <path>",
		"Выходная папка (если не указана, сохраняет рядом с исходниками)",
	)
	.option("-q, --quality <number>", "Качество WebP (0-100)", parseInt, 80)
	.option(
		"--no-recursive",
		"Не обрабатывать подпапки рекурсивно (по умолчанию рекурсия включена)",
	)
	.parse(process.argv);

const options = program.opts();

if (!options.source) {
	console.error("error: Укажите исходную папку или файл: -s ./images");
	program.help();
	process.exit(1);
}

const sourcePath = path.resolve(options.source);
const distPath = options.dist ? path.resolve(options.dist) : null;
const quality = Math.min(100, Math.max(0, options.quality));
const recursive = options.recursive;

if (!fs.existsSync(sourcePath)) {
	console.error(`error: Путь не существует: ${sourcePath}`);
	process.exit(1);
}

const supportedExt = [".jpg", ".jpeg", ".png", ".tiff", ".bmp"];

async function convertFile(filePath, outPath) {
	try {
		await sharp(filePath).webp({ quality }).toFile(outPath);
		console.log(
			`success: ${path.basename(filePath)} -> ${path.basename(outPath)}`,
		);
	} catch (err) {
		console.error(`error: ${filePath}: ${err.message}`);
	}
}

async function processDirectory(inputDir, outputDir) {
	const entries = fs.readdirSync(inputDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(inputDir, entry.name);
		const outFull = outputDir ? path.join(outputDir, entry.name) : null;

		if (entry.isDirectory() && recursive) {
			if (outputDir) {
				if (!fs.existsSync(outFull)) fs.mkdirSync(outFull, { recursive: true });
				await processDirectory(fullPath, outFull);
			} else {
				await processDirectory(fullPath, null);
			}
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (supportedExt.includes(ext)) {
				const outName = path.basename(entry.name, ext) + ".webp";
				let outPath;
				if (outputDir) {
					outPath = path.join(outputDir, outName);
				} else {
					outPath = path.join(inputDir, outName);
				}
				await convertFile(fullPath, outPath);
			}
		}
	}
}

async function main() {
	const stat = fs.statSync(sourcePath);

	if (stat.isFile()) {
		const ext = path.extname(sourcePath).toLowerCase();
		if (!supportedExt.includes(ext)) {
			console.error(`error: Неподдерживаемый формат: ${sourcePath}`);
			process.exit(1);
		}
		const outName = path.basename(sourcePath, ext) + ".webp";
		let outPath;
		if (distPath) {
			if (!fs.existsSync(distPath)) fs.mkdirSync(distPath, { recursive: true });
			outPath = path.join(distPath, outName);
		} else {
			outPath = path.join(path.dirname(sourcePath), outName);
		}
		await convertFile(sourcePath, outPath);
	} else if (stat.isDirectory()) {
		if (distPath) {
			if (!fs.existsSync(distPath)) fs.mkdirSync(distPath, { recursive: true });
			await processDirectory(sourcePath, distPath);
		} else {
			await processDirectory(sourcePath, null);
		}
	}
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
