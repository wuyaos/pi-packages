import { ZoteroApiError } from "./client.ts";

export interface BatchWriteResult<T = void> {
  succeeded: { key: string; value: T }[];
  failed: { key: string; error: string; status?: number }[];
  skipped: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 顺序执行，避免并发消耗 single-use key；401/403/429 后停止继续弹授权或撞限流。 */
export async function runKeyBatch<T>(
  keys: string[],
  operation: (key: string) => Promise<T>,
): Promise<BatchWriteResult<T>> {
  const result: BatchWriteResult<T> = { succeeded: [], failed: [], skipped: [] };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    try {
      result.succeeded.push({ key, value: await operation(key) });
    } catch (error) {
      const status = error instanceof ZoteroApiError ? error.status : undefined;
      result.failed.push({ key, error: errorMessage(error), ...(status !== undefined ? { status } : {}) });
      if (status === 401 || status === 403 || status === 429) {
        result.skipped.push(...keys.slice(index + 1));
        break;
      }
    }
  }
  return result;
}

export function batchWriteText<T>(action: string, result: BatchWriteResult<T>): string {
  return `${action}: 成功 ${result.succeeded.length}，失败 ${result.failed.length}，跳过 ${result.skipped.length}` +
    (result.failed.length ? `\n` + result.failed.map((entry) => `[${entry.key}] ${entry.error}`).join("\n") : "");
}
