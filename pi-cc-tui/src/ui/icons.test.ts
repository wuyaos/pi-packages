import assert from "node:assert/strict";
import test from "node:test";
import {
	configureIcons,
	createIconSet,
	getIcons,
	normalizeIconMode,
} from "./icons.ts";

test("icon mode normalization defaults to Unicode", () => {
	assert.equal(normalizeIconMode(undefined), "unicode");
	assert.equal(normalizeIconMode("unknown"), "unicode");
	assert.equal(normalizeIconMode("ascii"), "ascii");
	assert.equal(normalizeIconMode("nerd"), "nerd");
	assert.equal(normalizeIconMode("emoji"), "emoji");
});

test("ASCII icon set contains readable fallbacks", () => {
	const icons = createIconSet({ mode: "ascii" });
	assert.equal(icons.model, "model");
	assert.equal(icons.path, "cwd");
	assert.equal(icons.success, "ok");
	assert.equal(icons.traffic, "in/out");
	assert.equal(Object.isFrozen(icons), true);
});

test("Emoji icon set provides a complete semantic alternative", () => {
	const icons = createIconSet({ mode: "emoji" });
	assert.equal(icons.model, "🤖");
	assert.equal(icons.path, "📁");
	assert.equal(icons.user, "👤");
	assert.equal(icons.traffic, "⇅");
});

test("icon overrides are non-empty only and do not mutate a new set", () => {
	const icons = createIconSet({
		mode: "unicode",
		overrides: { model: "M", success: "" },
	});
	assert.equal(icons.model, "M");
	assert.equal(icons.success, "✓");
	assert.equal(createIconSet({ mode: "unicode" }).model, "◆");
	assert.equal(createIconSet({ mode: "unicode" }).traffic, "⇅");
});

test("configured icons override the environment-backed default", () => {
	const previous = process.env.PI_CC_TUI_ICON_MODE;
	try {
		process.env.PI_CC_TUI_ICON_MODE = "ascii";
		configureIcons({ mode: "nerd" });
		assert.notEqual(getIcons().context, "ctx");
		configureIcons({ mode: "unicode" });
		assert.equal(getIcons().context, "▤");
	} finally {
		if (previous === undefined) delete process.env.PI_CC_TUI_ICON_MODE;
		else process.env.PI_CC_TUI_ICON_MODE = previous;
		configureIcons({ mode: previous });
	}
});
