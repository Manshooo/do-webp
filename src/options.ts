/** Расширения, которые умеем читать. */
export const SUPPORTED_EXT: ReadonlySet<string> = new Set([
	".jpg",
	".jpeg",
	".png",
	".tiff",
	".bmp",
	".svg",
]);

/** Режимы вписывания при изменении размера (значения sharp). */
export const FIT_MODES = [
	"cover",
	"contain",
	"fill",
	"inside",
	"outside",
] as const;

export type FitMode = (typeof FIT_MODES)[number];

/** Разобранные и проверенные опции запуска. */
export interface ConvertOptions {
	/** Исходный файл или папка. */
	source: string;
	/** Выходная папка или undefined, если результат кладём рядом с оригиналом. */
	dist: string | undefined;
	/** Качество WebP, 1-100. */
	quality: number;
	/** Ширина результата в пикселях. */
	width: number | undefined;
	/** Высота результата в пикселях. */
	height: number | undefined;
	/** Масштаб в процентах от исходного размера. */
	scale: number | undefined;
	/** Как вписывать, когда заданы обе стороны. */
	fit: FitMode;
	/** Сжимать без потерь. */
	lossless: boolean;
	/** Заходить ли в подпапки. */
	recursive: boolean;
	/** Сколько файлов обрабатывать одновременно. */
	concurrency: number;
}

/**
 * Ошибка в аргументах командной строки. Отделена от остальных, чтобы cli.ts
 * мог показать её как понятное сообщение, а не как стек падения.
 */
export class OptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OptionError";
	}
}

/**
 * Разбирает целое число из аргумента.
 *
 * Отдавать commander голый parseInt нельзя: он вызывает парсер как
 * fn(value, previous), поэтому значение по умолчанию попадает во второй
 * аргумент parseInt — основание системы счисления. parseInt("100", 80)
 * возвращает NaN, потому что основание 80 недопустимо.
 *
 * @param flag Имя опции для текста ошибки.
 * @param value Сырое значение из командной строки.
 * @param min Минимальное допустимое значение.
 * @param max Максимальное допустимое значение.
 */
export function parseInteger(
	flag: string,
	value: string,
	min: number,
	max: number,
): number {
	const raw = value.trim();
	if (!/^\d+$/.test(raw)) {
		throw new OptionError(`${flag} ожидает целое число, получено "${value}"`);
	}

	const parsed = Number.parseInt(raw, 10);
	if (parsed < min || parsed > max) {
		throw new OptionError(
			`${flag} должно быть в диапазоне от ${min} до ${max}, получено ${parsed}`,
		);
	}

	return parsed;
}

/**
 * Разбирает проценты: принимает и "150", и "150%".
 *
 * @param flag Имя опции для текста ошибки.
 * @param value Сырое значение из командной строки.
 */
export function parsePercent(flag: string, value: string): number {
	const raw = value.trim().replace(/%$/, "");
	if (!/^\d+(\.\d+)?$/.test(raw)) {
		throw new OptionError(
			`${flag} ожидает число процентов, например 50 или 150%, получено "${value}"`,
		);
	}

	const parsed = Number.parseFloat(raw);
	if (parsed <= 0 || parsed > 10000) {
		throw new OptionError(
			`${flag} должно быть больше 0 и не больше 10000, получено ${parsed}`,
		);
	}

	return parsed;
}

/** Проверяет сочетания опций, которые по отдельности корректны. */
export function validateOptions(options: ConvertOptions): void {
	if (
		options.scale !== undefined &&
		(options.width !== undefined || options.height !== undefined)
	) {
		throw new OptionError(
			"--scale нельзя совмещать с --width/--height, выберите что-то одно",
		);
	}

	if (!FIT_MODES.includes(options.fit)) {
		throw new OptionError(
			`--fit ожидает одно из значений: ${FIT_MODES.join(", ")}, получено "${options.fit}"`,
		);
	}
}
