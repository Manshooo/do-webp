#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { program } from "commander";

const pkg = JSON.parse(
	await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
);

/** Расширения, которые умеем читать. */
const SUPPORTED_EXT = new Set([
	".jpg",
	".jpeg",
	".png",
	".tiff",
	".bmp",
	".svg",
]);

/** Сколько строк "success:" печатать, прежде чем перейти на счётчик. */
const VERBOSE_LINES = 3;

/** Режимы вписывания при resize (см. документацию sharp). */
const FIT_MODES = ["cover", "contain", "fill", "inside", "outside"];

// ---------------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------------

/**
 * Создаёт парсер целого числа для commander.
 *
 * Передавать сюда голый parseInt нельзя: commander вызывает парсер как
 * fn(value, previous), поэтому значение по умолчанию попадает во второй
 * аргумент parseInt — основание системы счисления. Например parseInt("100", 80)
 * вернёт NaN, потому что основание 80 недопустимо. Именно из-за этого раньше
 * ломался любой вызов с -q.
 *
 * @param {string} flag Имя опции для текста ошибки.
 * @param {number} min Минимальное допустимое значение.
 * @param {number} max Максимальное допустимое значение.
 * @returns {(value: string) => number}
 */
function integerOption(flag, min, max) {
	return (value) => {
		const raw = String(value).trim();
		if (!/^\d+$/.test(raw)) {
			program.error(`error: ${flag} ожидает целое число, получено "${value}"`);
		}
		const parsed = Number.parseInt(raw, 10);
		if (parsed < min || parsed > max) {
			program.error(
				`error: ${flag} должно быть в диапазоне от ${min} до ${max}, получено ${parsed}`,
			);
		}
		return parsed;
	};
}

/**
 * Создаёт парсер процентов: принимает "150" и "150%".
 *
 * @param {string} flag Имя опции для текста ошибки.
 * @returns {(value: string) => number}
 */
function percentOption(flag) {
	return (value) => {
		const raw = String(value).trim().replace(/%$/, "");
		if (!/^\d+(\.\d+)?$/.test(raw)) {
			program.error(
				`error: ${flag} ожидает число процентов, например 50 или 150%, получено "${value}"`,
			);
		}
		const parsed = Number.parseFloat(raw);
		if (parsed <= 0 || parsed > 10000) {
			program.error(
				`error: ${flag} должно быть больше 0 и не больше 10000, получено ${parsed}`,
			);
		}
		return parsed;
	};
}

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
		integerOption("--quality", 1, 100),
		80,
	)
	.option(
		"-w, --width <px>",
		"Ширина результата в пикселях",
		integerOption("--width", 1, 100000),
	)
	.option(
		"--height <px>",
		"Высота результата в пикселях",
		integerOption("--height", 1, 100000),
	)
	.option(
		"--scale <percent>",
		"Масштаб в процентах от исходного размера (например 50 или 200)",
		percentOption("--scale"),
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
		integerOption("--concurrency", 1, 64),
		4,
	)
	.parse(process.argv);

const options = program.opts();

if (!options.source) {
	program.error(
		"error: Укажите исходную папку или файл: -s ./images\n" +
			"Полная справка: do-webp --help",
	);
}

if (options.scale != null && (options.width != null || options.height != null)) {
	program.error(
		"error: --scale нельзя совмещать с --width/--height, выберите что-то одно",
	);
}

if (!FIT_MODES.includes(options.fit)) {
	program.error(
		`error: --fit ожидает одно из значений: ${FIT_MODES.join(", ")}, получено "${options.fit}"`,
	);
}

// ---------------------------------------------------------------------------
// Вывод в консоль
// ---------------------------------------------------------------------------

/** Открыта ли сейчас строка прогресса, которую перезаписываем через \r. */
let progressLineOpen = false;

/**
 * Выбирает форму слова для числа: 1 файл, 2 файла, 5 файлов.
 *
 * @param {number} count
 * @param {string} one Форма для 1.
 * @param {string} few Форма для 2-4.
 * @param {string} many Форма для 5-20.
 * @returns {string}
 */
function plural(count, one, few, many) {
	const mod100 = count % 100;
	if (mod100 >= 11 && mod100 <= 14) return many;

	const mod10 = count % 10;
	if (mod10 === 1) return one;
	if (mod10 >= 2 && mod10 <= 4) return few;
	return many;
}

/**
 * Печатает строку прогресса поверх предыдущей.
 *
 * В неинтерактивном выводе (пайп, редирект в файл, лог CI) возврат каретки
 * ничего не перезаписывает и все строки склеиваются в одну — там прогресс
 * просто не печатаем, итоговой сводки достаточно.
 *
 * @param {string} text
 */
function writeProgress(text) {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\r${text}`);
	progressLineOpen = true;
}

/** Закрывает строку прогресса переводом строки, если она была открыта. */
function endProgress() {
	if (progressLineOpen) {
		process.stdout.write("\n");
		progressLineOpen = false;
	}
}

/**
 * Печатает сообщение в stderr, не ломая строку прогресса.
 * @param {string} message
 */
function logError(message) {
	endProgress();
	console.error(message);
}

// ---------------------------------------------------------------------------
// Поиск файлов
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FileTask
 * @property {string} fullPath Абсолютный путь к исходному файлу.
 * @property {string} relative Путь относительно корня источника (для логов и структуры).
 * @property {string} name Имя файла с расширением.
 * @property {string} ext Расширение в нижнем регистре, включая точку.
 * @property {string} [outPath] Куда писать результат, заполняется позже.
 */

/**
 * Рекурсивно собирает поддерживаемые файлы в плоский список.
 * Папку, которую не удалось прочитать, пропускает с сообщением, а не роняет
 * весь запуск.
 *
 * @param {string} dir Текущая папка обхода.
 * @param {string} baseDir Корень источника, от него считается relative.
 * @param {boolean} recursive Заходить ли в подпапки.
 * @returns {Promise<FileTask[]>}
 */
async function getFiles(dir, baseDir, recursive) {
	let results = [];

	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		logError(`error: Не удалось прочитать папку ${dir}: ${err.message}`);
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (recursive) {
				results = results.concat(await getFiles(fullPath, baseDir, recursive));
			}
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

/**
 * Меняет расширение файла на .webp.
 *
 * Через path.basename(name, ext) делать это нельзя: сравнение суффикса
 * регистрозависимое, поэтому "photo.PNG" с ext ".png" превратился бы
 * в "photo.PNG.webp".
 *
 * @param {string} name Имя исходного файла.
 * @returns {string}
 */
function toWebpName(name) {
	const ext = path.extname(name);
	return `${name.slice(0, name.length - ext.length)}.webp`;
}

// ---------------------------------------------------------------------------
// Расчёт размеров
// ---------------------------------------------------------------------------

/**
 * Возвращает размер изображения с учётом EXIF-поворота, потому что дальше
 * в конвейере вызывается .rotate() и стороны могут поменяться местами.
 *
 * @param {import("sharp").Metadata} metadata
 * @returns {[number | undefined, number | undefined]} Пара [ширина, высота].
 */
function orientedSize(metadata) {
	const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
	return swapped
		? [metadata.height, metadata.width]
		: [metadata.width, metadata.height];
}

/**
 * @typedef {Object} ResizePlan
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} fit
 */

/**
 * Считает конечный размер для конкретного файла.
 *
 * @param {import("sharp").Metadata} metadata Метаданные исходника.
 * @param {typeof options} opts Разобранные опции CLI.
 * @returns {ResizePlan | null} null, если размер менять не нужно.
 */
function planResize(metadata, opts) {
	if (opts.scale != null) {
		const [width, height] = orientedSize(metadata);
		if (!width || !height) return null;

		// Обе стороны считаем сами, поэтому fit не важен — берём точные числа.
		return {
			width: Math.max(1, Math.round((width * opts.scale) / 100)),
			height: Math.max(1, Math.round((height * opts.scale) / 100)),
			fit: "fill",
		};
	}

	if (opts.width != null || opts.height != null) {
		return { width: opts.width, height: opts.height, fit: opts.fit };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Конвертация
// ---------------------------------------------------------------------------

/**
 * Конвертирует один файл в WebP.
 *
 * Для SVG отдельная настройка плотности растеризации не нужна: если задан
 * конечный размер, sharp сам перерисовывает вектор сразу в него, а не
 * растягивает картинку, отрисованную в исходные размеры. Без -w/--height/--scale
 * SVG попадёт в WebP в своих собственных размерах — так и было в жалобе на
 * пиксельный favicon 800x800.
 *
 * @param {FileTask} file
 * @param {typeof options} opts
 * @returns {Promise<void>}
 */
async function convertFile(file, opts) {
	// Метаданные читаем только ради --scale: остальным режимам исходный
	// размер не нужен, а лишнее открытие файла стоит времени.
	const metadata =
		opts.scale != null ? await sharp(file.fullPath).metadata() : {};

	const plan = planResize(metadata, opts);

	// .rotate() без аргументов применяет EXIF-ориентацию. WebP её не хранит,
	// поэтому без этого вызова снятые вертикально фотографии ложились набок.
	let pipeline = sharp(file.fullPath).rotate();

	if (plan) {
		pipeline = pipeline.resize({
			width: plan.width,
			height: plan.height,
			fit: plan.fit,
			withoutEnlargement: false,
		});
	}

	await pipeline
		.webp({ quality: opts.quality, lossless: Boolean(opts.lossless) })
		.toFile(file.outPath);
}

/**
 * Выполняет задачи с ограничением параллелизма.
 * Исходный массив не изменяется, в отличие от варианта с queue.shift().
 *
 * @template T
 * @param {number} size Количество одновременных задач.
 * @param {T[]} items
 * @param {(item: T) => Promise<void>} task
 * @returns {Promise<void>}
 */
async function runPool(size, items, task) {
	let cursor = 0;

	const worker = async () => {
		while (cursor < items.length) {
			await task(items[cursor++]);
		}
	};

	const workers = Math.max(1, Math.min(size, items.length));
	await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Заполняет outPath у каждой задачи и создаёт нужные папки.
 *
 * @param {FileTask[]} files
 * @param {string | null} distPath
 * @returns {Promise<void>}
 */
async function resolveOutputPaths(files, distPath) {
	for (const file of files) {
		const outName = toWebpName(file.name);

		if (distPath) {
			const targetDir = path.join(distPath, path.dirname(file.relative));
			await fs.mkdir(targetDir, { recursive: true });
			file.outPath = path.join(targetDir, outName);
		} else {
			file.outPath = path.join(path.dirname(file.fullPath), outName);
		}
	}
}

/**
 * Находит файлы, которые пишут в один и тот же результат — например logo.png
 * и logo.svg в одной папке. Первый занявший путь остаётся, остальные
 * возвращаются как пропущенные, чтобы результат не зависел от порядка потоков.
 *
 * @param {FileTask[]} files
 * @returns {{ kept: FileTask[], skipped: Array<{ file: FileTask, winner: FileTask }> }}
 */
function dropCollisions(files) {
	// На Windows и macOS пути нечувствительны к регистру, на Linux — наоборот,
	// и там Logo.webp с logo.webp это два разных файла.
	const ignoreCase = process.platform !== "linux";

	const taken = new Map();
	const kept = [];
	const skipped = [];

	for (const file of files) {
		const key = ignoreCase ? file.outPath.toLowerCase() : file.outPath;
		const winner = taken.get(key);

		if (winner) {
			skipped.push({ file, winner });
		} else {
			taken.set(key, file);
			kept.push(file);
		}
	}

	return { kept, skipped };
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

async function main() {
	const sourcePath = path.resolve(options.source);
	const distPath = options.dist ? path.resolve(options.dist) : null;

	let filesToProcess = [];

	try {
		const stat = await fs.stat(sourcePath);

		if (stat.isFile()) {
			const ext = path.extname(sourcePath).toLowerCase();
			if (!SUPPORTED_EXT.has(ext)) {
				console.error(`error: Неподдерживаемый формат: ${sourcePath}`);
				process.exit(1);
			}
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
		} else {
			console.error(`error: Это не файл и не папка: ${sourcePath}`);
			process.exit(1);
		}

		await resolveOutputPaths(filesToProcess, distPath);
	} catch (err) {
		if (err.code === "ENOENT") {
			console.error(`error: Путь не существует: ${sourcePath}`);
		} else {
			console.error("fatal:", err);
		}
		process.exit(1);
	}

	const { kept, skipped } = dropCollisions(filesToProcess);
	const totalFiles = filesToProcess.length;

	console.log(`Найдено файлов для обработки: ${totalFiles}`);

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
				endProgress();
				console.log(
					`success: ${file.relative} -> ${distPath ? path.relative(distPath, file.outPath) : path.basename(file.outPath)}`,
				);
			} else {
				const rest = successCount - VERBOSE_LINES;
				writeProgress(
					`...обработано ещё ${rest} ${plural(rest, "файл", "файла", "файлов")}`,
				);
			}
		} catch (err) {
			errorCount++;
			logError(`error: Ошибка конвертации ${file.fullPath}: ${err.message}`);
		}
	});

	endProgress();

	const parts = [`успешно ${successCount}`];
	if (errorCount) parts.push(`с ошибкой ${errorCount}`);
	if (skipped.length) parts.push(`пропущено ${skipped.length}`);

	console.log(
		`Обработка завершена! ${parts.join(", ")} из ${totalFiles}`,
	);

	if (errorCount > 0 || skipped.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	endProgress();
	console.error("fatal:", err);
	process.exit(1);
});
