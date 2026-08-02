import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import type { Metadata } from "sharp";
import type { FileTask } from "./files.ts";
import type { ConvertOptions, FitMode } from "./options.ts";

/** Конечный размер картинки, посчитанный для конкретного файла. */
export interface ResizePlan {
	width: number | undefined;
	height: number | undefined;
	fit: FitMode;
}

/** Минимальный набор полей метаданных, который нужен расчёту размера. */
export interface SourceSize {
	width?: number | undefined;
	height?: number | undefined;
	orientation?: number | undefined;
}

/**
 * Возвращает размер изображения с учётом EXIF-поворота: дальше в конвейере
 * вызывается .rotate(), и стороны могут поменяться местами.
 */
export function orientedSize(
	metadata: SourceSize,
): [number | undefined, number | undefined] {
	const orientation = metadata.orientation ?? 1;
	const swapped = orientation >= 5 && orientation <= 8;

	return swapped
		? [metadata.height, metadata.width]
		: [metadata.width, metadata.height];
}

/**
 * Считает конечный размер для конкретного файла.
 *
 * @param metadata Размеры исходника, нужны только режиму --scale.
 * @param options Разобранные опции запуска.
 * @returns null, если размер менять не нужно.
 */
export function planResize(
	metadata: SourceSize,
	options: ConvertOptions,
): ResizePlan | null {
	if (options.scale !== undefined) {
		const [width, height] = orientedSize(metadata);
		if (!width || !height) return null;

		// Обе стороны считаем сами, поэтому fit роли не играет — берём точные
		// числа и растягиваем ровно в них.
		return {
			width: Math.max(1, Math.round((width * options.scale) / 100)),
			height: Math.max(1, Math.round((height * options.scale) / 100)),
			fit: "fill",
		};
	}

	if (options.width !== undefined || options.height !== undefined) {
		return { width: options.width, height: options.height, fit: options.fit };
	}

	return null;
}

/** Папки, которые уже создали, чтобы не дёргать mkdir на каждый файл. */
const createdDirs = new Set<string>();

/** Создаёт папку под результат, если её ещё нет. */
async function ensureDir(dir: string): Promise<void> {
	if (createdDirs.has(dir)) return;
	await fs.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
}

/**
 * Конвертирует один файл в WebP.
 *
 * Отдельная настройка density для SVG не нужна: когда задан конечный размер,
 * sharp сам перерисовывает вектор сразу в него, а не растягивает картинку,
 * отрисованную в исходные размеры. Без --width/--height/--scale SVG попадёт
 * в WebP в своих собственных размерах — из-за этого иконка с одним лишь
 * viewBox выглядит пиксельной, сколько ни поднимай качество.
 */
export async function convertFile(
	file: FileTask,
	options: ConvertOptions,
): Promise<void> {
	// Метаданные читаем только ради --scale: остальным режимам исходный размер
	// не нужен, а лишнее открытие файла стоит времени.
	const metadata: Metadata | SourceSize =
		options.scale !== undefined
			? await sharp(file.fullPath).metadata()
			: {};

	const plan = planResize(metadata, options);

	await ensureDir(path.dirname(file.outPath));

	// .rotate() без аргументов применяет EXIF-ориентацию. WebP её не хранит,
	// поэтому без этого вызова снятые вертикально фотографии ложатся набок.
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
		.webp({ quality: options.quality, lossless: options.lossless })
		.toFile(file.outPath);
}
