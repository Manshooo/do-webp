import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";

import { orientedSize, planResize } from "../src/convert.ts";
import { dropCollisions, resolveOutPath, toWebpName } from "../src/files.ts";
import type { FileTask } from "../src/files.ts";
import { plural } from "../src/logger.ts";
import {
	OptionError,
	parseInteger,
	parsePercent,
	validateOptions,
} from "../src/options.ts";
import type { ConvertOptions } from "../src/options.ts";
import { runPool } from "../src/pool.ts";

/** Базовые опции, поверх которых тесты меняют только нужное поле. */
function makeOptions(patch: Partial<ConvertOptions> = {}): ConvertOptions {
	return {
		source: "./",
		dist: undefined,
		quality: 80,
		width: undefined,
		height: undefined,
		scale: undefined,
		fit: "inside",
		lossless: false,
		recursive: true,
		concurrency: 4,
		...patch,
	};
}

/** Собирает задачу с заданным выходным путём. */
function makeTask(name: string, outPath: string): FileTask {
	return {
		fullPath: path.resolve(name),
		relative: name,
		name,
		ext: path.extname(name).toLowerCase(),
		outPath: path.resolve(outPath),
	};
}

test("parseInteger разбирает число и держит границы", () => {
	assert.strictEqual(parseInteger("--quality", "100", 1, 100), 100);
	assert.strictEqual(parseInteger("--quality", " 42 ", 1, 100), 42);

	// Ровно тот случай, на котором ломался parseInt с основанием из commander.
	assert.strictEqual(parseInteger("--concurrency", "8", 1, 64), 8);

	assert.throws(() => parseInteger("--quality", "abc", 1, 100), OptionError);
	assert.throws(() => parseInteger("--quality", "1.5", 1, 100), OptionError);
	assert.throws(() => parseInteger("--quality", "0", 1, 100), OptionError);
	assert.throws(() => parseInteger("--quality", "101", 1, 100), OptionError);
});

test("parsePercent принимает и число, и запись со знаком процента", () => {
	assert.strictEqual(parsePercent("--scale", "50"), 50);
	assert.strictEqual(parsePercent("--scale", "150%"), 150);
	assert.strictEqual(parsePercent("--scale", "12.5"), 12.5);

	assert.throws(() => parsePercent("--scale", "0"), OptionError);
	assert.throws(() => parsePercent("--scale", "-10"), OptionError);
	assert.throws(() => parsePercent("--scale", "abc"), OptionError);
});

test("validateOptions ловит несовместимые сочетания", () => {
	assert.doesNotThrow(() => validateOptions(makeOptions({ scale: 50 })));
	assert.doesNotThrow(() => validateOptions(makeOptions({ width: 100 })));

	assert.throws(
		() => validateOptions(makeOptions({ scale: 50, width: 100 })),
		OptionError,
	);
	assert.throws(
		() => validateOptions(makeOptions({ scale: 50, height: 100 })),
		OptionError,
	);
	assert.throws(
		() =>
			validateOptions(
				makeOptions({ fit: "squeeze" as ConvertOptions["fit"] }),
			),
		OptionError,
	);
});

test("orientedSize меняет стороны местами для повёрнутых снимков", () => {
	assert.deepStrictEqual(orientedSize({ width: 400, height: 200 }), [400, 200]);

	// Ориентации 1-4 поворота на 90 градусов не дают.
	assert.deepStrictEqual(
		orientedSize({ width: 400, height: 200, orientation: 3 }),
		[400, 200],
	);

	// 5-8 дают, значит после .rotate() стороны поменяются.
	assert.deepStrictEqual(
		orientedSize({ width: 400, height: 200, orientation: 6 }),
		[200, 400],
	);
});

test("planResize считает размер по процентам и по пикселям", () => {
	assert.strictEqual(planResize({ width: 400, height: 200 }, makeOptions()), null);

	assert.deepStrictEqual(
		planResize({ width: 400, height: 200 }, makeOptions({ scale: 50 })),
		{ width: 200, height: 100, fit: "fill" },
	);

	assert.deepStrictEqual(
		planResize({ width: 400, height: 200 }, makeOptions({ width: 100 })),
		{ width: 100, height: undefined, fit: "inside" },
	);

	// Проценты считаются от повёрнутого размера, иначе стороны разъедутся.
	assert.deepStrictEqual(
		planResize(
			{ width: 400, height: 200, orientation: 6 },
			makeOptions({ scale: 50 }),
		),
		{ width: 100, height: 200, fit: "fill" },
	);

	// Без размеров исходника считать проценты не от чего.
	assert.strictEqual(planResize({}, makeOptions({ scale: 50 })), null);
});

test("planResize не схлопывает крошечные картинки в ноль пикселей", () => {
	assert.deepStrictEqual(
		planResize({ width: 10, height: 10 }, makeOptions({ scale: 1 })),
		{ width: 1, height: 1, fit: "fill" },
	);
});

test("toWebpName меняет расширение независимо от регистра", () => {
	assert.strictEqual(toWebpName("photo.png"), "photo.webp");
	assert.strictEqual(toWebpName("photo.PNG"), "photo.webp");
	assert.strictEqual(toWebpName("my.photo.JPEG"), "my.photo.webp");
	assert.strictEqual(toWebpName("noext"), "noext.webp");
});

test("resolveOutPath кладёт результат рядом или в выходную папку", () => {
	const source = path.resolve("photos/deep/pic.png");

	assert.strictEqual(
		resolveOutPath("deep/pic.png", source, undefined),
		path.resolve("photos/deep/pic.webp"),
	);

	assert.strictEqual(
		resolveOutPath(path.join("deep", "pic.png"), source, path.resolve("out")),
		path.resolve("out/deep/pic.webp"),
	);
});

test("dropCollisions оставляет первый файл и помечает остальные", () => {
	const png = makeTask("logo.png", "logo.webp");
	const svg = makeTask("logo.svg", "logo.webp");
	const other = makeTask("icon.png", "icon.webp");

	const { kept, skipped } = dropCollisions([png, svg, other]);

	assert.deepStrictEqual(
		kept.map((f) => f.name),
		["logo.png", "icon.png"],
	);
	assert.strictEqual(skipped.length, 1);
	assert.strictEqual(skipped[0]?.file.name, "logo.svg");
	assert.strictEqual(skipped[0]?.winner.name, "logo.png");
});

test("runPool выполняет все задачи и не превышает лимит потоков", async () => {
	const items = Array.from({ length: 20 }, (_, i) => i);
	const done: number[] = [];

	let running = 0;
	let peak = 0;

	await runPool(4, items, async (item) => {
		running++;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 1));
		done.push(item);
		running--;
	});

	assert.strictEqual(done.length, 20);
	assert.deepStrictEqual([...done].sort((a, b) => a - b), items);
	assert.ok(peak <= 4, `Одновременно работало ${peak} задач вместо 4`);
});

test("runPool не трогает переданный массив", async () => {
	const items = [1, 2, 3];
	await runPool(2, items, async () => {});
	assert.deepStrictEqual(items, [1, 2, 3]);
});

test("runPool переживает пустую очередь", async () => {
	let called = false;
	await runPool(4, [], async () => {
		called = true;
	});
	assert.strictEqual(called, false);
});

test("plural подбирает форму слова", () => {
	assert.strictEqual(plural(1, "файл", "файла", "файлов"), "файл");
	assert.strictEqual(plural(2, "файл", "файла", "файлов"), "файла");
	assert.strictEqual(plural(5, "файл", "файла", "файлов"), "файлов");
	assert.strictEqual(plural(11, "файл", "файла", "файлов"), "файлов");
	assert.strictEqual(plural(21, "файл", "файла", "файлов"), "файл");
	assert.strictEqual(plural(112, "файл", "файла", "файлов"), "файлов");
	assert.strictEqual(plural(0, "файл", "файла", "файлов"), "файлов");
});
