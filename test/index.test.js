import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const tmpDir = path.resolve("./tmp-test");
const cliPath = path.resolve("./bin/do-webp.js");

beforeEach(async () => {
	await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Успешно конвертирует одиночный файл", async () => {
	// фейковый PNG (минимальный валидный 1x1 пиксель прозрачный PNG)
	const pngBuffer = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
		"base64",
	);
	const sourceFile = path.join(tmpDir, "test.png");
	await fs.writeFile(sourceFile, pngBuffer);

	// Запускаем скрипт
	execSync(`node "${cliPath}" -s "${sourceFile}" -d "${tmpDir}"`);

	// Проверяем, что создался webp
	const expectedWebp = path.join(tmpDir, "test.webp");
	const exists = await fs
		.stat(expectedWebp)
		.then(() => true)
		.catch(() => false);

	assert.strictEqual(exists, true, "Файл webp должен быть создан");
});
