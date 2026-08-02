/** Открыта ли сейчас строка прогресса, которую перезаписываем через \r. */
let progressLineOpen = false;

/**
 * Выбирает форму слова для числа: 1 файл, 2 файла, 5 файлов.
 *
 * @param count Число, для которого подбираем форму.
 * @param one Форма для 1.
 * @param few Форма для 2-4.
 * @param many Форма для 5-20.
 */
export function plural(
	count: number,
	one: string,
	few: string,
	many: string,
): string {
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
 */
export function writeProgress(text: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\r${text}`);
	progressLineOpen = true;
}

/** Закрывает строку прогресса переводом строки, если она была открыта. */
export function endProgress(): void {
	if (progressLineOpen) {
		process.stdout.write("\n");
		progressLineOpen = false;
	}
}

/** Печатает сообщение в stdout, не ломая строку прогресса. */
export function logInfo(message: string): void {
	endProgress();
	console.log(message);
}

/** Печатает сообщение в stderr, не ломая строку прогресса. */
export function logError(message: string): void {
	endProgress();
	console.error(message);
}
