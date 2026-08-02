#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { convertFile } from "./convert.ts";
import { collectFiles, dropCollisions, resolveOutPath } from "./files.ts";
import {
	endProgress,
	logError,
	logInfo,
	plural,
	writeProgress,
} from "./logger.ts";
import {
	FIT_MODES,
	OptionError,
	parseInteger,
	parsePercent,
	SUPPORTED_EXT,
	validateOptions,
} from "./options.ts";
import type { ConvertOptions } from "./options.ts";
import type { FileTask } from "./files.ts";
import { runPool } from "./pool.ts";

/** Сколько строк "success:" печатать, прежде чем перейти на счётчик. */
const VERBOSE_LINES = 3;

const pkg = JSON.parse(
	await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

// Явная аннотация нужна, чтобы компилятор увидел, что program.error()
// возвращает never: для вызовов вида a.b() он учитывает это только у
// переменных с указанным типом.
const program: Command = new Command();

program
	.name("do-webp")
	.description("Конвертация изображений в WebP")
	.version(pkg.version, "-V, --version", "Показать версию")
	.helpOption("-h, --help", "Показать справку")
	.option("-s, --source <path>", "Исходная папка или файл")
	.option("-d, --dist <path>", "Выходная папка (сохраняет структуру подпапок)")
	.option(
		"-q, --quality <number>",
		"Качество WebP (1-100)",
		(value) => parseInteger("--quality", value, 1, 100),
		80,
	)
	.option(
		"-w, --width <px>",
		"Ширина результата в пикселях",
		(value) => parseInteger("--width", value, 1, 100000),
	)
	.option(
		"--height <px>",
		"Высота результата в пикселях",
		(value) => parseInteger("--height", value, 1, 100000),
	)
	.option(
		"--scale <percent>",
		"Масштаб в процентах от исходного размера (например 50 или 200)",
		(value) => parsePercent("--scale", value),
	)
	.option(
		"--fit <mode>",
		`Как вписывать в заданные размеры: ${FIT_MODES.join(", ")}`,
		"inside",
	)
	.option("--lossless", "Сжатие без потерь (крупнее файл, но без артефактов)")
	.option("--no-recursive", "Не обрабатывать подпапки рекурсивно")
	.option(
		"-c, --concurrency <number>",
		"Количество параллельных потоков",
		(value) => parseInteger("--concurrency", value, 1, 64),
		4,
	);

/** Печатает сообщение как ошибку аргументов и выходит с кодом 1. */
function fail(message: string): never {
	program.error(`error: ${message}`);
}

/**
 * Разбирает аргументы и приводит их к проверенным опциям.
 * Ошибки парсеров прилетают как OptionError и превращаются в понятный текст.
 */
function readOptions(argv: string[]): ConvertOptions {
	try {
		program.parse(argv);
	} catch (err) {
		if (err instanceof OptionError) fail(err.message);
		throw err;
	}

	const raw = program.opts();

	if (!raw.source) {
		fail(
			"Укажите исходную папку или файл: -s ./images\nПолная справка: do-webp --help",
		);
	}

	const options: ConvertOptions = {
		source: raw.source,
		dist: raw.dist,
		quality: raw.quality,
		width: raw.width,
		height: raw.height,
		scale: raw.scale,
		fit: raw.fit,
		lossless: Boolean(raw.lossless),
		recursive: Boolean(raw.recursive),
		concurrency: raw.concurrency,
	};

	try {
		validateOptions(options);
	} catch (err) {
		if (err instanceof OptionError) fail(err.message);
		throw err;
	}

	return options;
}

/** Собирает очередь файлов для источника — одиночного файла или папки. */
async function buildQueue(
	sourcePath: string,
	distPath: string | undefined,
	recursive: boolean,
): Promise<FileTask[]> {
	const stat = await fs.stat(sourcePath);

	if (stat.isFile()) {
		const ext = path.extname(sourcePath).toLowerCase();
		if (!SUPPORTED_EXT.has(ext)) {
			logError(`error: Неподдерживаемый формат: ${sourcePath}`);
			process.exit(1);
		}

		const name = path.basename(sourcePath);
		return [
			{
				fullPath: sourcePath,
				relative: name,
				name,
				ext,
				outPath: resolveOutPath(name, sourcePath, distPath),
			},
		];
	}

	if (stat.isDirectory()) {
		return collectFiles(sourcePath, sourcePath, recursive, distPath);
	}

	logError(`error: Это не файл и не папка: ${sourcePath}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const options = readOptions(process.argv);

	const sourcePath = path.resolve(options.source);
	const distPath =
		options.dist === undefined ? undefined : path.resolve(options.dist);

	let queue: FileTask[];
	try {
		queue = await buildQueue(sourcePath, distPath, options.recursive);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			logError(`error: Путь не существует: ${sourcePath}`);
		} else {
			logError(`fatal: ${(err as Error).message}`);
		}
		process.exit(1);
	}

	const { kept, skipped } = dropCollisions(queue);

	logInfo(`Найдено файлов для обработки: ${queue.length}`);

	for (const { file, winner } of skipped) {
		logError(
			`warning: Пропущен ${file.relative}: имя результата занято файлом ${winner.relative}`,
		);
	}

	let successCount = 0;
	let errorCount = 0;

	await runPool(options.concurrency, kept, async (file) => {
		try {
			await convertFile(file, options);
			successCount++;

			if (successCount <= VERBOSE_LINES) {
				const shown =
					distPath === undefined
						? path.basename(file.outPath)
						: path.relative(distPath, file.outPath);
				logInfo(`success: ${file.relative} -> ${shown}`);
			} else {
				const rest = successCount - VERBOSE_LINES;
				writeProgress(
					`...обработано ещё ${rest} ${plural(rest, "файл", "файла", "файлов")}`,
				);
			}
		} catch (err) {
			errorCount++;
			logError(
				`error: Ошибка конвертации ${file.fullPath}: ${(err as Error).message}`,
			);
		}
	});

	endProgress();

	const parts = [`успешно ${successCount}`];
	if (errorCount) parts.push(`с ошибкой ${errorCount}`);
	if (skipped.length) parts.push(`пропущено ${skipped.length}`);

	logInfo(`Обработка завершена! ${parts.join(", ")} из ${queue.length}`);

	if (errorCount > 0 || skipped.length > 0) {
		process.exitCode = 1;
	}
}

await main().catch((err: unknown) => {
	endProgress();
	console.error("fatal:", err);
	process.exit(1);
});
