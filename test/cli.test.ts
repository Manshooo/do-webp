import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import {
	exists,
	makeTmpDir,
	PNG_1X1,
	readMeta,
	removeTmpDir,
	runCli,
	tmpDir,
	writePng,
	writeSvg,
	writeViewBoxSvg,
} from "./helpers.ts";

beforeEach(makeTmpDir);
afterEach(removeTmpDir);

test("Успешно конвертирует одиночный файл", async () => {
	const sourceFile = path.join(tmpDir, "test.png");
	await fs.writeFile(sourceFile, PNG_1X1);

	const { status } = runCli(["-s", sourceFile, "-d", tmpDir]);

	assert.strictEqual(status, 0, "CLI должен завершиться без ошибки");
	assert.strictEqual(
		await exists(path.join(tmpDir, "test.webp")),
		true,
		"Файл webp должен быть создан",
	);
});

test("Принимает -q 100 и не превращает качество в NaN", async () => {
	const sourceFile = await writePng("quality.png");

	const { status, stderr } = runCli(["-s", sourceFile, "-q", "100"]);

	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);
	assert.ok(!stderr.includes("NaN"), `В выводе не должно быть NaN: ${stderr}`);
	assert.strictEqual(await exists(path.join(tmpDir, "quality.webp")), true);
});

test("Отклоняет некорректное качество", async () => {
	const sourceFile = await writePng("bad-quality.png");

	const notANumber = runCli(["-s", sourceFile, "-q", "abc"]);
	assert.notStrictEqual(notANumber.status, 0);
	assert.match(notANumber.stderr, /целое число/);

	const outOfRange = runCli(["-s", sourceFile, "-q", "0"]);
	assert.notStrictEqual(outOfRange.status, 0);
	assert.match(outOfRange.stderr, /от 1 до 100/);
});

test("Принимает -c и обрабатывает все файлы", async () => {
	for (let i = 0; i < 5; i++) {
		await writePng(`file-${i}.png`);
	}

	const { status, stdout, stderr } = runCli(["-s", tmpDir, "-c", "8"]);

	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);
	assert.match(stdout, /успешно 5 из 5/);
});

test("--width задаёт ширину и сохраняет пропорции", async () => {
	const sourceFile = await writePng("wide.png", 400, 200);

	const { status, stderr } = runCli(["-s", sourceFile, "--width", "100"]);
	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);

	const meta = await readMeta(path.join(tmpDir, "wide.webp"));
	assert.strictEqual(meta.width, 100);
	assert.strictEqual(meta.height, 50);
});

test("--width и --height вписывают изображение целиком (fit inside)", async () => {
	const sourceFile = await writePng("box.png", 400, 200);

	const { status, stderr } = runCli([
		"-s",
		sourceFile,
		"--width",
		"100",
		"--height",
		"100",
	]);
	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);

	const meta = await readMeta(path.join(tmpDir, "box.webp"));
	assert.strictEqual(meta.width, 100);
	assert.strictEqual(meta.height, 50, "Кадрировать по умолчанию не должны");
});

test("--fit cover обрезает до точного размера", async () => {
	const sourceFile = await writePng("cover.png", 400, 200);

	const { status, stderr } = runCli([
		"-s",
		sourceFile,
		"--width",
		"100",
		"--height",
		"100",
		"--fit",
		"cover",
	]);
	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);

	const meta = await readMeta(path.join(tmpDir, "cover.webp"));
	assert.strictEqual(meta.width, 100);
	assert.strictEqual(meta.height, 100);
});

test("--fit отвергает неизвестный режим", async () => {
	const sourceFile = await writePng("fit.png");

	const { status, stderr } = runCli([
		"-s",
		sourceFile,
		"--width",
		"50",
		"--fit",
		"squeeze",
	]);

	assert.notStrictEqual(status, 0);
	assert.match(stderr, /--fit ожидает одно из значений/);
});

test("--scale считает размер в процентах", async () => {
	const sourceFile = await writePng("scaled.png", 400, 200);

	const half = runCli(["-s", sourceFile, "--scale", "50"]);
	assert.strictEqual(half.status, 0, `CLI упал: ${half.stderr}`);

	let meta = await readMeta(path.join(tmpDir, "scaled.webp"));
	assert.strictEqual(meta.width, 200);
	assert.strictEqual(meta.height, 100);

	const bigger = runCli(["-s", sourceFile, "--scale", "150%"]);
	assert.strictEqual(bigger.status, 0, `CLI упал: ${bigger.stderr}`);

	meta = await readMeta(path.join(tmpDir, "scaled.webp"));
	assert.strictEqual(meta.width, 600);
	assert.strictEqual(meta.height, 300);
});

test("--scale нельзя совмещать с --width", async () => {
	const sourceFile = await writePng("conflict.png");

	const { status, stderr } = runCli([
		"-s",
		sourceFile,
		"--scale",
		"50",
		"--width",
		"100",
	]);

	assert.notStrictEqual(status, 0);
	assert.match(stderr, /нельзя совмещать/);
});

test("SVG растеризуется в нужный размер, а не увеличивается после отрисовки", async () => {
	const sourceFile = await writeSvg("icon.svg", 800);

	const { status, stderr } = runCli([
		"-s",
		sourceFile,
		"--width",
		"1600",
		"-q",
		"100",
	]);
	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);

	const outPath = path.join(tmpDir, "icon.webp");
	const meta = await readMeta(outPath);
	assert.strictEqual(meta.width, 1600);
	assert.strictEqual(meta.height, 1600);

	// Если бы SVG сначала отрисовали в его 800x800, а потом растянули, кромка
	// круга размылась бы примерно вдвое. Сравниваем с таким двухшаговым
	// вариантом: у нас полупрозрачных пикселей должно быть заметно меньше.
	const raster800 = await sharp(await fs.readFile(sourceFile)).png().toBuffer();
	const twoStep = await sharp(raster800)
		.resize({ width: 1600 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const actual = await sharp(await fs.readFile(outPath))
		.raw()
		.toBuffer({ resolveWithObject: true });

	const actualSoft = countSoftPixels(actual);
	const twoStepSoft = countSoftPixels(twoStep);

	assert.ok(
		actualSoft * 2 < twoStepSoft,
		`Край должен быть резче двухшагового варианта: ${actualSoft} против ${twoStepSoft}`,
	);
});

test("SVG с одним viewBox без размера конвертируется как есть", async () => {
	const sourceFile = await writeViewBoxSvg("favicon.svg", 64);

	// Так выглядела исходная жалоба: иконка кажется большой в браузере,
	// но растеризуется в 64x64 и выглядит пиксельной при любом качестве.
	const asIs = runCli(["-s", sourceFile, "-q", "100"]);
	assert.strictEqual(asIs.status, 0, `CLI упал: ${asIs.stderr}`);

	let meta = await readMeta(path.join(tmpDir, "favicon.webp"));
	assert.strictEqual(meta.width, 64);

	// И лечится указанием размера.
	const resized = runCli(["-s", sourceFile, "--width", "512", "--lossless"]);
	assert.strictEqual(resized.status, 0, `CLI упал: ${resized.stderr}`);

	meta = await readMeta(path.join(tmpDir, "favicon.webp"));
	assert.strictEqual(meta.width, 512);
	assert.strictEqual(meta.height, 512);
});

/** Считает полупрозрачные пиксели — чем их больше, тем шире размытая кромка. */
function countSoftPixels({
	data,
	info,
}: {
	data: Buffer;
	info: { width: number; height: number; channels: number };
}): number {
	let count = 0;

	for (let i = 0; i < info.width * info.height; i++) {
		const alpha = data[i * info.channels + 3] ?? 0;
		if (alpha > 8 && alpha < 247) count++;
	}

	return count;
}

test("Расширение в верхнем регистре не остаётся в имени результата", async () => {
	const sourceFile = path.join(tmpDir, "photo.PNG");
	await fs.writeFile(sourceFile, PNG_1X1);

	const { status, stderr } = runCli(["-s", sourceFile]);

	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);
	assert.strictEqual(await exists(path.join(tmpDir, "photo.webp")), true);
	assert.strictEqual(await exists(path.join(tmpDir, "photo.PNG.webp")), false);
});

test("Сообщает о конфликте имён вместо тихой перезаписи", async () => {
	await writePng("logo.png");
	await writeSvg("logo.svg", 64);

	const { status, stderr, stdout } = runCli(["-s", tmpDir]);

	assert.strictEqual(status, 1, "Конфликт должен давать ненулевой код выхода");
	assert.match(stderr, /имя результата занято/);
	assert.match(stdout, /пропущено 1/);
});

test("Битый файл не роняет остальные и виден в коде возврата", async () => {
	await writePng("good.png");
	await fs.writeFile(path.join(tmpDir, "broken.png"), "это не картинка");

	const { status, stdout, stderr } = runCli(["-s", tmpDir]);

	assert.strictEqual(status, 1);
	assert.match(stderr, /Ошибка конвертации/);
	assert.match(stdout, /успешно 1, с ошибкой 1 из 2/);
	assert.strictEqual(await exists(path.join(tmpDir, "good.webp")), true);
});

test("--no-recursive не заходит в подпапки", async () => {
	await writePng("root.png");
	await fs.mkdir(path.join(tmpDir, "nested"), { recursive: true });
	await writePng(path.join("nested", "inner.png"));

	const { status, stdout, stderr } = runCli(["-s", tmpDir, "--no-recursive"]);

	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);
	assert.match(stdout, /Найдено файлов для обработки: 1/);
	assert.strictEqual(
		await exists(path.join(tmpDir, "nested", "inner.webp")),
		false,
	);
});

test("Сохраняет структуру подпапок в выходной папке", async () => {
	const distDir = path.join(tmpDir, "out");
	await fs.mkdir(path.join(tmpDir, "src", "deep"), { recursive: true });
	await writePng(path.join("src", "deep", "pic.png"));

	const { status, stderr } = runCli([
		"-s",
		path.join(tmpDir, "src"),
		"-d",
		distDir,
	]);

	assert.strictEqual(status, 0, `CLI упал: ${stderr}`);
	assert.strictEqual(
		await exists(path.join(distDir, "deep", "pic.webp")),
		true,
	);
});

test("Сообщает об ошибке на несуществующем пути", async () => {
	const { status, stderr } = runCli(["-s", path.join(tmpDir, "нет-такого")]);

	assert.notStrictEqual(status, 0);
	assert.match(stderr, /Путь не существует/);
});

test("Отказывается от неподдерживаемого формата", async () => {
	const sourceFile = path.join(tmpDir, "notes.txt");
	await fs.writeFile(sourceFile, "текст");

	const { status, stderr } = runCli(["-s", sourceFile]);

	assert.notStrictEqual(status, 0);
	assert.match(stderr, /Неподдерживаемый формат/);
});

test("Требует -s и не завершается успехом без него", () => {
	const { status, stderr } = runCli([]);

	assert.notStrictEqual(status, 0, "Без -s код выхода должен быть ненулевым");
	assert.match(stderr, /Укажите исходную папку или файл/);
});

test("--version печатает версию из package.json", async () => {
	const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as {
		version: string;
	};

	const { status, stdout } = runCli(["--version"]);

	assert.strictEqual(status, 0);
	assert.strictEqual(stdout.trim(), pkg.version);
});
