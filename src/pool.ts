/**
 * Выполняет задачи с ограничением параллелизма.
 *
 * Курсор вместо queue.shift(): переданный массив не изменяется, поэтому его
 * можно спокойно использовать после — например, чтобы посчитать итоги.
 *
 * @param size Сколько задач выполнять одновременно.
 * @param items Очередь задач.
 * @param task Что делать с каждой задачей. Ошибки ловит сам обработчик.
 */
export async function runPool<T>(
	size: number,
	items: readonly T[],
	task: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;

	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const item = items[cursor++];
			// Индекс всегда в границах, проверка нужна только компилятору
			// из-за noUncheckedIndexedAccess.
			if (item !== undefined) await task(item);
		}
	};

	const workers = Math.max(1, Math.min(size, items.length));
	await Promise.all(Array.from({ length: workers }, worker));
}
