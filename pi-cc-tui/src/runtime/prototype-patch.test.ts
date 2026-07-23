import assert from "node:assert/strict";
import test from "node:test";
import {
	CC_TUI_PROTOTYPE_PATCH_REGISTRY,
	installPrototypePatch,
} from "./prototype-patch.ts";

class Target {
	value = 0;

	add(amount: number): number {
		this.value += amount;
		return this.value;
	}
}

test("prototype patch delegates with receiver and restores the original method", () => {
	const original = Target.prototype.add;
	const cleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:test", ({ predecessor, receiver, args }) => {
		return Number(Reflect.apply(predecessor, receiver, [Number(args[0]) * 2]));
	});

	const target = new Target();
	assert.equal(target.add(3), 6);
	cleanup();
	assert.equal(Target.prototype.add, original);
	assert.equal(target.add(3), 9);
	assert.equal(Object.hasOwn(Target.prototype, CC_TUI_PROTOTYPE_PATCH_REGISTRY), false);
});

test("a reload replaces behavior and stale cleanup cannot remove the latest registration", () => {
	const original = Target.prototype.add;
	const firstCleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:reload", ({ predecessor, receiver, args }) => {
		return Number(Reflect.apply(predecessor, receiver, args)) + 1;
	});
	const wrapper = Target.prototype.add;
	const secondCleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:reload", ({ predecessor, receiver, args }) => {
		return Number(Reflect.apply(predecessor, receiver, args)) + 2;
	});

	assert.equal(Target.prototype.add, wrapper);
	firstCleanup();
	assert.equal(new Target().add(1), 3);
	secondCleanup();
	assert.equal(Target.prototype.add, original);
});

test("different adapters compose on the same method and clean up independently", () => {
	const original = Target.prototype.add;
	const firstCleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:first", ({ predecessor, receiver, args }) => {
		return Number(Reflect.apply(predecessor, receiver, args)) + 1;
	});
	const secondCleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:second", ({ predecessor, receiver, args }) => {
		return Number(Reflect.apply(predecessor, receiver, args)) * 2;
	});

	assert.equal(new Target().add(2), 6); // (2 + 1) * 2
	secondCleanup();
	assert.equal(new Target().add(2), 3);
	firstCleanup();
	assert.equal(Target.prototype.add, original);
});

test("cleanup does not overwrite another extension's later method", () => {
	const original = Target.prototype.add;
	const cleanup = installPrototypePatch(Target.prototype, "add", "cc-tui:ownership", ({ predecessor, receiver, args }) => {
		return Reflect.apply(predecessor, receiver, args);
	});
	const later = function laterReplacement(this: Target, amount: number): number {
		return amount * 10;
	};
	Target.prototype.add = later;

	cleanup();
	assert.equal(Target.prototype.add, later);
	assert.equal(new Target().add(2), 20);
	Target.prototype.add = original;
});

test("invalid adapters and non-method targets are rejected", () => {
	assert.throws(
		() => installPrototypePatch(Target.prototype, "add", "unqualified", () => undefined),
		/package-qualified/,
	);
	assert.throws(
		() => installPrototypePatch({}, "missing", "cc-tui:test", () => undefined),
		/predecessor is not a function/,
	);
});
