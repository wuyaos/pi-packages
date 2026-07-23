/**
 * 可逆、单实例的原型方法 patch 注册器。
 *
 * Pi 没有为消息组件和默认工具行提供完整的公共 renderer API，因此少数
 * transcript 视觉增强仍需兼容层。本模块把该风险集中起来：每个目标/方法仅有
 * 一个 wrapper，多个具名 adapter 在该 wrapper 内按安装顺序嵌套；重载只替换
 * 行为；过期 cleanup 不会移除较新的行为；也绝不覆盖后来由其他扩展替换的方法。
 *
 * 设计参考：lmilojevicc/pi-zentui 的 MIT prototype patch registry；此处按
 * cc-tui 的模块化、多个 adapter 共存与测试要求重新实现。
 */

export const CC_TUI_PROTOTYPE_PATCH_REGISTRY = Symbol.for("wuyaos.pi-cc-tui.prototype-patches");

export type PrototypeMethod = (this: unknown, ...args: unknown[]) => unknown;

export type PatchInvocation = Readonly<{
	predecessor: PrototypeMethod;
	receiver: unknown;
	args: readonly unknown[];
}>;

export type PatchBehavior = (invocation: PatchInvocation) => unknown;

type PatchRegistration = {
	token: symbol;
	behavior: PatchBehavior;
};

type MethodPatchRecord = {
	method: PropertyKey;
	predecessor: PrototypeMethod;
	wrapper: PrototypeMethod;
	registrations: Map<string, PatchRegistration>;
	order: string[];
};

type PatchRegistry = Map<PropertyKey, MethodPatchRecord>;
type PatchTarget = Record<PropertyKey, unknown>;

function registryFor(target: PatchTarget): PatchRegistry {
	const existing = target[CC_TUI_PROTOTYPE_PATCH_REGISTRY];
	if (existing instanceof Map) return existing as PatchRegistry;

	const registry: PatchRegistry = new Map();
	Object.defineProperty(target, CC_TUI_PROTOTYPE_PATCH_REGISTRY, {
		value: registry,
		configurable: true,
	});
	return registry;
}

function invokeRecord(
	record: MethodPatchRecord,
	position: number,
	receiver: unknown,
	args: readonly unknown[],
): unknown {
	const adapter = record.order[position];
	const registration = adapter === undefined ? undefined : record.registrations.get(adapter);
	if (!registration) return Reflect.apply(record.predecessor, receiver, args);

	const predecessor: PrototypeMethod = function ccTuiPatchPredecessor(
		this: unknown,
		...nextArgs: unknown[]
	): unknown {
		return invokeRecord(record, position - 1, this, nextArgs);
	};
	return registration.behavior({ predecessor, receiver, args });
}

function createRecord(method: PropertyKey, predecessor: PrototypeMethod): MethodPatchRecord {
	const record: MethodPatchRecord = {
		method,
		predecessor,
		wrapper: () => undefined,
		registrations: new Map(),
		order: [],
	};
	record.wrapper = function ccTuiPrototypePatchWrapper(this: unknown, ...args: unknown[]): unknown {
		return invokeRecord(record, record.order.length - 1, this, args);
	};
	return record;
}

function removeRecord(target: PatchTarget, registry: PatchRegistry, record: MethodPatchRecord): void {
	if (registry.get(record.method) !== record) return;
	// A third party may have installed a later wrapper. Never clobber it.
	if (target[record.method] === record.wrapper) target[record.method] = record.predecessor;
	registry.delete(record.method);
	if (registry.size === 0) delete target[CC_TUI_PROTOTYPE_PATCH_REGISTRY];
}

/**
 * Install or replace a named behavior around one prototype method.
 *
 * Adapter names must be package-qualified (for example
 * `cc-tui:thinking-content`) so unrelated extensions cannot accidentally
 * replace one another's behavior. The returned cleanup is idempotent.
 */
export function installPrototypePatch(
	targetValue: object,
	method: PropertyKey,
	adapter: string,
	behavior: PatchBehavior,
): () => void {
	if (!adapter.includes(":")) {
		throw new TypeError("Prototype patch adapters must use a package-qualified name");
	}

	const target = targetValue as PatchTarget;
	const registry = registryFor(target);
	let record = registry.get(method);
	if (!record || target[method] !== record.wrapper) {
		const predecessor = target[method];
		if (typeof predecessor !== "function") {
			throw new TypeError(`Cannot patch ${String(method)}: predecessor is not a function`);
		}
		record = createRecord(method, predecessor as PrototypeMethod);
		registry.set(method, record);
		target[method] = record.wrapper;
	}

	const token = Symbol(adapter);
	if (!record.registrations.has(adapter)) record.order.push(adapter);
	record.registrations.set(adapter, { token, behavior });
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		if (registry.get(method) !== record) return;
		if (record.registrations.get(adapter)?.token !== token) return;

		record.registrations.delete(adapter);
		record.order = record.order.filter((name) => name !== adapter);
		if (record.registrations.size === 0) removeRecord(target, registry, record);
	};
}
