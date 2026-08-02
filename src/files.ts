import { promises as fs } from "node:fs";
import path from "node:path";

import { logError } from "./logger.ts";
import { SUPPORTED_EXT } from "./options.ts";

/** Один файл в очереди на конвертацию. */
export interface FileTask {
	/** Абсолютный путь к исходному файлу. */
	fullPath: string;
	/** Путь относительно корня источника — для логов и структуры подпапок. */
	relative: string;
	/** Имя файла с расширением. */
	name: string;
	/** Расширение в нижнем регистре, включая точку. */
	ext: string;
	/** Куда пишем результат. */
	outPath: string;
}

/** Файл, который не будем обрабатывать, и причина этого. */
export interface SkippedTask {
	file: FileTask;
	/** Файл, который занял тот же выходной путь первым. */
	winner: FileTask;
}

/**
 * Меняет расширение файла на .webp.
 *
 * Через path.basename(name, ext) делать это нельзя: сравнение суффикса
 * регистрозависимое, поэтому "photo.PNG" с расширением ".png" превратился бы
 * в "photo.PNG.webp".
 */
export function toWebpName(name: string): string {
	const ext = path.extname(name);
	return `${name.slice(0, name.length - ext.length)}.webp`;
}

/**
 * Считает путь результата для исходного файла.
 *
 * @param relative Путь исходника относительно корня источника.
 * @param fullPath Абсолютный путь исходника.
 * @param distPath Выходная папка или undefined, если пишем рядом с оригиналом.
 */
export function resolveOutPath(
	relative: string,
	fullPath: string,
	distPath: string | undefined,
): string {
	const outName = toWebpName(path.basename(fullPath));

	if (distPath === undefined) {
		return path.join(path.dirname(fullPath), outName);
	}

	return path.join(distPath, path.dirname(relative), outName);
}

/**
 * Рекурсивно собирает поддерживаемые файлы в плоский список.
 * Папку, которую не удалось прочитать, пропускает с сообщением, а не роняет
 * весь запуск.
 *
 * @param dir Текущая папка обхода.
 * @param baseDir Корень источника, от него считается relative.
 * @param recursive Заходить ли в подпапки.
 * @param distPath Выходная папка или undefined.
 */
export async function collectFiles(
	dir: string,
	baseDir: string,
	recursive: boolean,
	distPath: string | undefined,
): Promise<FileTask[]> {
	let results: FileTask[] = [];

	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		logError(
			`error: Не удалось прочитать папку ${dir}: ${(err as Error).message}`,
		);
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (recursive) {
				results = results.concat(
					await collectFiles(fullPath, baseDir, recursive, distPath),
				);
			}
			continue;
		}

		if (!entry.isFile()) continue;

		const ext = path.extname(entry.name).toLowerCase();
		if (!SUPPORTED_EXT.has(ext)) continue;

		const relative = path.relative(baseDir, fullPath);
		results.push({
			fullPath,
			relative,
			name: entry.name,
			ext,
			outPath: resolveOutPath(relative, fullPath, distPath),
		});
	}

	return results;
}

/**
 * Находит файлы, которые пишут в один и тот же результат — например logo.png
 * и logo.svg в одной папке. Первый занявший путь остаётся, остальные уходят
 * в skipped, чтобы результат не зависел от порядка потоков.
 */
export function dropCollisions(files: readonly FileTask[]): {
	kept: FileTask[];
	skipped: SkippedTask[];
} {
	// На Windows и macOS пути нечувствительны к регистру, на Linux — наоборот,
	// и там Logo.webp с logo.webp это два разных файла.
	const ignoreCase = process.platform !== "linux";

	const taken = new Map<string, FileTask>();
	const kept: FileTask[] = [];
	const skipped: SkippedTask[] = [];

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
